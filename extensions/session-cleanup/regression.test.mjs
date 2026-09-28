import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Cleaner, hash, matches } from './core.mjs';

const DAY = 86400000;
const present = async p => fs.access(p).then(() => true, () => false);
const filesRule = { name: 'files', type: 'paths', root: '{cwd}/metadata', patterns: ['{sessionId}'] };

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'pi-cleanup-regression-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'sessions'));
  const config = { retentionDays: null, rules: [filesRule], ...options };
  const saveConfig = () => fs.writeFile(path.join(root, 'session-cleanup.json'), JSON.stringify(config));
  await saveConfig();
  const cleaner = new Cleaner(root, undefined, p => fs.unlink(p));
  const inventoryPath = path.join(root, 'state/session-cleanup/inventory.json');
  const inventory = async () => JSON.parse(await fs.readFile(inventoryPath, 'utf8'));
  const add = async (id, name = id, cwd = root, old = false) => {
    const p = path.join(root, 'sessions', `${name}.jsonl`);
    await fs.writeFile(p, JSON.stringify({ type: 'session', id, cwd }) + '\n');
    if (old) await fs.utimes(p, new Date(0), new Date(0));
    await fs.mkdir(path.join(cwd, 'metadata', id), { recursive: true });
    await fs.writeFile(path.join(cwd, 'metadata', id, 'data'), 'owned');
    return p;
  };
  return { root, config, saveConfig, cleaner, add, inventoryPath, inventory };
}

for (const expiration of [false, true]) {
  for (const leased of [false, true]) {
    test(`prefix IDs preserve longer live owners: expiration=${expiration}, leased=${leased}`, async t => {
      const defaults = JSON.parse(await fs.readFile(new URL('../../session-cleanup.json', import.meta.url), 'utf8'));
      const rules = defaults.rules.filter(r => ['background-task-artifacts', 'delegate-artifacts', 'fusion-artifacts'].includes(r.name));
      const { root, cleaner, add, inventoryPath } = await fixture(t, { rules, retentionDays: expiration ? 30 : null });
      const a = await add('a', 'a', root, expiration);
      const b = await add('a-b');
      await add('a-b-c');
      const owned = [], protectedPaths = [];
      for (const kind of ['tasks', 'delegate', 'fusion']) {
        for (const id of ['a', 'a-b', 'a-b-c']) {
          for (const pid of ['123', '456']) {
            const target = path.join(root, '.pi', kind, `${id}-${pid}`);
            await fs.mkdir(target, { recursive: true });
            await fs.writeFile(path.join(target, 'artifact'), id);
            (id === 'a' ? owned : protectedPaths).push(target);
          }
        }
      }
      if (leased) await cleaner.lease(b);
      // Inventory before manual deletion; do not expire the fixture prematurely.
      await cleaner.run({ now: 0 });
      if (!expiration) await fs.unlink(a);
      const before = await fs.readFile(inventoryPath, 'utf8');
      const preview = await cleaner.run({ dryRun: true });
      assert.deepEqual(preview.errors, []);
      assert.deepEqual(preview.preview.flatMap(p => p.targets ?? []).sort(), owned.sort());
      assert.equal(await fs.readFile(inventoryPath, 'utf8'), before);
      for (const p of [...owned, ...protectedPaths]) assert.equal(await present(p), true);
      const report = await cleaner.run();
      assert.deepEqual(report.errors, []);
      assert.deepEqual(report.cleaned, ['a']);
      for (const p of owned) assert.equal(await present(p), false);
      for (const p of protectedPaths) assert.equal(await present(p), true);
      assert.equal(await present(b), true);
      await cleaner.close();
    });
  }
}

test('prefix matching protects journaled owners after their transcript disappears', async t => {
  const rule = { name: 'tasks', type: 'paths', root: '{agentDir}/tasks', patterns: ['*/{sessionId}-*'] };
  const { root, cleaner, add } = await fixture(t, { rules: [rule] });
  const a = await add('a'), b = await add('a-b');
  for (const name of ['a-123', 'a-b-456']) await fs.mkdir(path.join(root, 'tasks/nested', name), { recursive: true });
  await cleaner.lease(b);
  await cleaner.run();
  await fs.unlink(a); await fs.unlink(b);
  assert.deepEqual((await cleaner.run()).cleaned, ['a']);
  assert.equal(await present(path.join(root, 'tasks/nested/a-123')), false);
  assert.equal(await present(path.join(root, 'tasks/nested/a-b-456')), true);
  await cleaner.close();
  assert.deepEqual((await cleaner.run()).cleaned, ['a-b']);
  assert.equal(await present(path.join(root, 'tasks/nested/a-b-456')), false);
});

test('longest known prefix wins without blocking shorter siblings or exact-ID rules', async t => {
  const { root } = await fixture(t);
  for (const name of ['a-123', 'a-b', 'a-b-456', 'a-b-c-789', 'ab-123', 'a_b-123']) {
    await fs.mkdir(path.join(root, 'targets', name), { recursive: true });
  }
  const ids = new Set(['a', 'a-b', 'a-b-c', 'ab', 'a_b']);
  for (const [id, expected] of [['a', ['a-123']], ['a-b', ['a-b-456']], ['a-b-c', ['a-b-c-789']], ['ab', ['ab-123']], ['a_b', ['a_b-123']]]) {
    const found = await matches(path.join(root, 'targets'), ['{sessionId}-*'], { sessionId: id }, ids);
    assert.deepEqual(found.map(p => path.basename(p)).sort(), expected);
  }
  assert.deepEqual(await matches(path.join(root, 'targets'), ['{sessionId}'], { sessionId: 'a-b' }, ids), [path.join(root, 'targets/a-b')]);
});

for (const leaseIndex of [0, 1]) {
  test(`deleted duplicate lease protects all rule types, lease index ${leaseIndex}`, async t => {
    const { root, cleaner, add, config, saveConfig, inventory } = await fixture(t);
    const dbPath = path.join(root, 'events.db');
    const db = new DatabaseSync(dbPath);
    t.after(() => db.close());
    db.exec("CREATE TABLE events(session_id TEXT); INSERT INTO events VALUES ('same'), ('sibling');");
    const marker = path.join(root, 'command-ran');
    config.rules.push(
      { name: 'sqlite', type: 'sqlite', root, patterns: ['events.db'], key: 'sessionId', tables: [{ table: 'events', column: 'session_id' }] },
      { name: 'command', type: 'command', command: '{node}', args: ['-e', 'require("fs").writeFileSync(process.argv[1], "ran")', marker] },
    );
    await saveConfig();
    const paths = [await add('same', 'first'), await add('same', 'second')];
    await cleaner.lease(paths[leaseIndex]);
    await cleaner.run();
    for (const p of paths) await fs.unlink(p);
    for (const dryRun of [true, false]) {
      const report = await cleaner.run({ dryRun });
      assert.deepEqual(report.errors, []);
      assert.deepEqual(report.cleaned, []);
      assert.deepEqual(report.preview, []);
      assert.equal(await present(path.join(root, 'metadata/same/data')), true);
      assert.equal(await present(marker), false);
      assert.equal(db.prepare('SELECT count(*) AS n FROM events').get().n, 2);
      assert.equal(Object.keys((await inventory()).records).length, 2);
    }
    await cleaner.close();
    const report = await cleaner.run();
    assert.deepEqual(report.errors, []);
    assert.equal(report.cleaned.length, 2);
    assert.equal(await present(path.join(root, 'metadata/same')), false);
    assert.equal(await present(marker), true);
    assert.deepEqual(db.prepare('SELECT session_id FROM events').all().map(r => r.session_id), ['sibling']);
  });
}

test('a missing leased duplicate prevents expiration of the remaining copy', async t => {
  const { root, cleaner, add } = await fixture(t, { retentionDays: 30 });
  const first = await add('same', 'first', root, true);
  const second = await add('same', 'second', root, true);
  await cleaner.lease(second);
  await cleaner.run();
  await fs.unlink(second);
  for (const dryRun of [true, false]) {
    const report = await cleaner.run({ dryRun });
    assert.deepEqual(report.preview, []);
    assert.deepEqual(report.expired, []);
    assert.equal(await present(first), true);
  }
  await cleaner.close();
  assert.deepEqual((await cleaner.run()).expired, [first]);
  assert.equal(await present(path.join(root, 'metadata/same')), false);
});

test('a duplicate lease published by a command protects later rules and records', async t => {
  const { root, cleaner, add, config, saveConfig } = await fixture(t);
  const first = await add('same', 'first'), second = await add('same', 'second');
  await cleaner.run();
  await fs.unlink(first); await fs.unlink(second);
  await fs.mkdir(path.dirname(cleaner.leasePath), { recursive: true });
  config.rules.unshift({ name: 'lease', type: 'command', command: '{node}', args: ['-e', 'require("fs").writeFileSync(process.argv[1],process.argv[2])', cleaner.leasePath, JSON.stringify({ pid: process.pid, path: second })] });
  await saveConfig();
  const report = await cleaner.run();
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.cleaned, []);
  assert.deepEqual(report.pending, ['same']);
  assert.equal(await present(path.join(root, 'metadata/same/data')), true);
  await cleaner.close();
});

test('path reuse preserves failed work and successful rule signatures across restarts', async t => {
  const { root, cleaner, add, config, saveConfig, inventory } = await fixture(t);
  const log = path.join(root, 'command.log');
  config.rules = [
    { name: 'log', type: 'command', command: '{node}', args: ['-e', 'require("fs").appendFileSync(process.argv[1], process.argv[2]+"\\n")', log, '{sessionId}'] },
    { ...filesRule, guards: [{ file: 'lease.json', pidField: 'pid' }] },
  ];
  await saveConfig();
  const p = await add('old', 'reused');
  await fs.writeFile(path.join(root, 'metadata/old/lease.json'), JSON.stringify({ pid: process.pid }));
  await cleaner.run(); await fs.unlink(p);
  assert.equal((await cleaner.run()).errors.length, 1);
  const before = Object.values((await inventory()).records)[0];
  assert.equal(before.done.length, 1);
  await add('new', 'reused');
  const restarted = new Cleaner(root, undefined, p => fs.unlink(p));
  await restarted.run();
  const saved = await inventory();
  assert.equal(saved.version, 2);
  assert.deepEqual(Object.values(saved.records).map(r => r.id).sort(), ['new', 'old']);
  assert.deepEqual(Object.values(saved.records).find(r => r.id === 'old').done, before.done);
  assert.deepEqual((await restarted.run({ dryRun: true })).preview, []);
  assert.equal(await present(path.join(root, 'metadata/old/data')), true);
  await fs.unlink(p);
  await fs.unlink(path.join(root, 'metadata/old/lease.json'));
  const report = await restarted.run();
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.cleaned.sort(), ['new', 'old']);
  assert.equal(await fs.readFile(log, 'utf8'), 'old\nnew\n');
  for (const id of ['old', 'new']) assert.equal(await present(path.join(root, 'metadata', id)), false);
  assert.deepEqual((await inventory()).records, {});
});

test('version 1 migration retains old identity when its path has already been reused', async t => {
  const { root, cleaner, add, inventoryPath, inventory } = await fixture(t);
  const p = await add('old', 'reused');
  await fs.mkdir(path.dirname(inventoryPath), { recursive: true });
  const original = { version: 1, records: { [hash(p)]: { id: 'old', path: p, cwd: root, mtimeMs: 0, done: ['successful-rule-signature'] } } };
  await fs.writeFile(inventoryPath, JSON.stringify(original));
  await add('new', 'reused');
  await cleaner.run({ dryRun: true });
  assert.deepEqual(await inventory(), original);
  await cleaner.run();
  const migrated = await inventory();
  assert.equal(migrated.version, 2);
  assert.equal(Object.keys(migrated.records).length, 2);
  assert.deepEqual(Object.values(migrated.records).find(r => r.id === 'old').done, ['successful-rule-signature']);
  await fs.unlink(p);
  assert.deepEqual((await cleaner.run()).cleaned.sort(), ['new', 'old']);
});

test('same ID and path with a different cwd retains both project identities', async t => {
  const { root, cleaner, add, inventory } = await fixture(t);
  const oldCwd = path.join(root, 'old-project'), newCwd = path.join(root, 'new-project');
  const p = await add('same', 'reused', oldCwd);
  await cleaner.run();
  await add('same', 'reused', newCwd);
  await cleaner.run();
  assert.equal(Object.keys((await inventory()).records).length, 2);
  await fs.unlink(p);
  const report = await cleaner.run();
  assert.deepEqual(report.errors, []);
  assert.equal(report.cleaned.length, 2);
  for (const cwd of [oldCwd, newCwd]) assert.equal(await present(path.join(cwd, 'metadata/same')), false);
});

for (const guarded of [['first'], ['second'], ['first', 'second']]) {
  test(`preview and execution agree on guarded duplicate expiration: ${guarded.join(', ')}`, async t => {
    const { root, cleaner, add, inventoryPath } = await fixture(t, {
      retentionDays: 30,
      rules: [{ ...filesRule, guards: [{ file: 'lease.json', pidField: 'pid' }] }],
    });
    const paths = [];
    for (const name of ['first', 'second']) {
      const cwd = path.join(root, name);
      paths.push(await add('same', name, cwd, true));
      if (guarded.includes(name)) await fs.writeFile(path.join(cwd, 'metadata/same/lease.json'), JSON.stringify({ pid: process.pid }));
    }
    const preview = await cleaner.run({ dryRun: true });
    assert.equal(preview.errors.length, guarded.length);
    assert.equal(preview.preview.filter(p => p.rule).length, 0);
    assert.equal(await present(inventoryPath), false);
    for (const p of paths) assert.equal(await present(p), true);
    const actual = await cleaner.run();
    assert.deepEqual(actual.expired, preview.preview.filter(p => p.reason === 'expired').map(p => p.session));
    assert.deepEqual(actual.errors, preview.errors);
    assert.deepEqual(actual.cleaned, []);
    for (const name of ['first', 'second']) assert.equal(await present(path.join(root, name, 'metadata/same/data')), true);
    for (const name of guarded) await fs.unlink(path.join(root, name, 'metadata/same/lease.json'));
    const retry = await cleaner.run();
    assert.deepEqual(retry.errors, []);
    assert.equal(retry.cleaned.length, 2);
  });
}

test('all expired copies reconcile cwd and path-hash metadata in the same run', async t => {
  const { root, cleaner, add, config, saveConfig } = await fixture(t, { retentionDays: 30 });
  config.rules.push({ name: 'sqlite', type: 'sqlite', root, patterns: ['events.db'], key: 'sessionPathHash16', tables: [{ table: 'events', column: 'session_id' }] });
  await saveConfig();
  const db = new DatabaseSync(path.join(root, 'events.db'));
  t.after(() => db.close());
  db.exec('CREATE TABLE events(session_id TEXT);');
  const paths = [];
  for (const name of ['first', 'second']) {
    const p = await add('same', name, path.join(root, name), true);
    paths.push(p);
    db.prepare('INSERT INTO events VALUES (?)').run(hash(p).slice(0, 16));
  }
  const preview = await cleaner.run({ dryRun: true, now: 31 * DAY });
  assert.deepEqual(preview.errors, []);
  assert.equal(preview.preview.filter(p => p.reason === 'expired').length, 2);
  assert.equal(preview.preview.filter(p => p.rule === 'files').length, 2);
  assert.equal(preview.preview.filter(p => p.rule === 'sqlite').length, 2);
  assert.equal(db.prepare('SELECT count(*) AS n FROM events').get().n, 2);
  const actual = await cleaner.run({ now: 31 * DAY });
  assert.deepEqual(actual.errors, []);
  assert.deepEqual(actual.expired, paths);
  assert.equal(actual.cleaned.length, 2);
  assert.equal(db.prepare('SELECT count(*) AS n FROM events').get().n, 0);
  for (const name of ['first', 'second']) assert.equal(await present(path.join(root, name, 'metadata/same')), false);
});

test('invalid legacy records fail closed before any expiration or inventory rewrite', async t => {
  const { root, cleaner, add, inventoryPath } = await fixture(t, { retentionDays: 30 });
  const p = await add('old', 'old', root, true);
  await fs.mkdir(path.dirname(inventoryPath), { recursive: true });
  for (const record of [null, {}, { id: 'old', path: p, cwd: root, done: [42] }]) {
    const json = JSON.stringify({ version: 1, records: { bad: record } });
    await fs.writeFile(inventoryPath, json);
    await assert.rejects(cleaner.run(), /Invalid inventory record/);
    assert.equal(await present(p), true);
    assert.equal(await fs.readFile(inventoryPath, 'utf8'), json);
  }
});
