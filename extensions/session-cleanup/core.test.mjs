import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Cleaner, validateConfig, applyRule, matches, hash, runCommand } from './core.mjs';

async function fixture(t, extra = {}) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'pi-cleanup-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'sessions/project'), { recursive: true });
  const config = { retentionDays: null, sessionRoots: ['{agentDir}/sessions'], rules: [{ name: 'files', type: 'paths', root: '{agentDir}/metadata', patterns: ['{sessionId}'] }], ...extra };
  await fs.writeFile(path.join(root, 'session-cleanup.json'), JSON.stringify(config));
  const cleaner = new Cleaner(root, undefined, p => fs.unlink(p));
  const add = async (id, filename = `${id}.jsonl`) => {
    const p = path.join(root, 'sessions/project', filename);
    await fs.writeFile(p, JSON.stringify({ type: 'session', id, cwd: root }) + '\n');
    await fs.mkdir(path.join(root, 'metadata', id), { recursive: true });
    await fs.writeFile(path.join(root, 'metadata', id, 'data'), 'owned');
    return p;
  };
  const present = async p => { try { await fs.stat(p); return true; } catch { return false; } };
  return { root, cleaner, add, present, config };
}

test('manual deletion applies rules, preserves siblings, and removes completed records', async t => {
  const { root, cleaner, add, present } = await fixture(t);
  const p = await add('a'); await add('b');
  await cleaner.run(); await fs.unlink(p);
  const report = await cleaner.run();
  assert.deepEqual(report.cleaned, ['a']); assert.deepEqual(report.errors, []);
  assert.equal(await present(path.join(root, 'metadata/a')), false);
  assert.equal(await present(path.join(root, 'metadata/b')), true);
  const state = JSON.parse(await fs.readFile(path.join(root, 'state/session-cleanup/inventory.json')));
  assert.equal(Object.keys(state.records).length, 1);
});

test('expiration uses 30 days by default and protects leased sessions', async t => {
  const { root, cleaner, add, present } = await fixture(t, { retentionDays: 30 });
  const old = await add('old'), active = await add('active'), recent = await add('recent');
  const oldTime = new Date(Date.now() - 31 * 86400000);
  await fs.utimes(old, oldTime, oldTime); await fs.utimes(active, oldTime, oldTime);
  await cleaner.lease(active); t.after(() => cleaner.close());
  const preview = await cleaner.run({ dryRun: true });
  assert.equal(preview.preview[0].session, old);
  assert.equal(await present(old), true);
  assert.equal(await present(path.join(root, 'state/session-cleanup/inventory.json')), false);
  const report = await cleaner.run();
  assert.deepEqual(report.expired, [old]); assert.deepEqual(report.errors, []);
  assert.equal(await present(active), true); assert.equal(await present(recent), true);
  assert.equal(await present(path.join(root, 'metadata/old')), false);
});

test('moved transcripts preserve metadata; deletion cleans it on the first run', async t => {
  const { root, cleaner, add, present } = await fixture(t);
  const p = await add('a'); await cleaner.run();
  const moved = path.join(path.dirname(p), 'moved.jsonl');
  await fs.rename(p, moved);
  await cleaner.run();
  assert.equal(await present(path.join(root, 'metadata/a')), true);
  await fs.unlink(moved); await cleaner.run();
  assert.equal(await present(path.join(root, 'metadata/a')), false);
});

test('missing root pauses cleanup rather than treating all sessions as deleted', async t => {
  const { root, cleaner, add, present } = await fixture(t);
  await add('a'); await cleaner.run();
  await fs.rename(path.join(root, 'sessions'), path.join(root, 'offline'));
  await assert.rejects(cleaner.run(), /Session root disappeared/);
  assert.equal(await present(path.join(root, 'metadata/a')), true);
});

test('malformed replacement is not deletion', async t => {
  const { root, cleaner, add, present } = await fixture(t);
  const p = await add('a'); await cleaner.run(); await fs.writeFile(p, 'bad');
  await cleaner.run(); assert.equal(await present(path.join(root, 'metadata/a')), true);
});

test('symlink roots and intermediate paths fail closed', async t => {
  const { root, cleaner, add, present } = await fixture(t);
  const p = await add('a'); await cleaner.run(); await fs.unlink(p);
  await fs.rename(path.join(root, 'metadata'), path.join(root, 'real-metadata'));
  await fs.symlink(path.join(root, 'real-metadata'), path.join(root, 'metadata'));
  const report = await cleaner.run();
  assert.match(report.errors[0], /Refusing symlink/);
  assert.equal(await present(path.join(root, 'real-metadata/a')), true);
});

test('guarded active metadata stays pending and retries after lease is removed', async t => {
  const { root, cleaner, add, present } = await fixture(t, { rules: [{ name: 'guarded', type: 'paths', root: '{agentDir}/metadata', patterns: ['{sessionId}'], guards: [{ file: 'lease.json', pidField: 'pid' }] }] });
  const p = await add('a'); await cleaner.run(); await fs.unlink(p);
  await fs.writeFile(path.join(root, 'metadata/a/lease.json'), JSON.stringify({ pid: process.pid }));
  assert.equal((await cleaner.run()).errors.length, 1);
  assert.equal(await present(path.join(root, 'metadata/a')), true);
  await fs.unlink(path.join(root, 'metadata/a/lease.json'));
  assert.deepEqual((await cleaner.run()).cleaned, ['a']);
});

test('SQLite rules remove only matching rows, include tool counters, retain unowned content', async t => {
  const { root } = await fixture(t);
  const dbFile = path.join(root, 'content.db');
  const db = new DatabaseSync(dbFile);
  db.exec('CREATE TABLE events(session_id TEXT, data TEXT); CREATE VIRTUAL TABLE chunks USING fts5(content, session_id UNINDEXED);');
  const record = { id: 'a', path: '/sessions/a.jsonl', cwd: root };
  const key = hash(record.path).slice(0, 16);
  db.prepare('INSERT INTO events VALUES (?, ?)').run(key, 'mine');
  db.prepare('INSERT INTO events VALUES (?, ?)').run('sibling', 'keep');
  db.prepare('INSERT INTO chunks VALUES (?, ?)').run('mine', key);
  db.prepare('INSERT INTO chunks VALUES (?, ?)').run('shared', null);
  const rule = { name: 'sqlite', type: 'sqlite', root, patterns: ['*.db'], key: 'sessionPathHash16', tables: [{ table: 'events', column: 'session_id' }, { table: 'chunks', column: 'session_id' }] };
  await applyRule(rule, record, {}, true);
  assert.equal(db.prepare('SELECT count(*) AS n FROM events').get().n, 2);
  await applyRule(rule, record, {});
  assert.equal(db.prepare('SELECT count(*) AS n FROM events').get().n, 1);
  assert.equal(db.prepare('SELECT content FROM chunks').get().content, 'shared');
  db.close();
});

test('SQLite schema failures roll back the whole database transaction', async t => {
  const { root } = await fixture(t);
  const db = new DatabaseSync(path.join(root, 'x.db'));
  db.exec("CREATE TABLE a(session_id TEXT); INSERT INTO a VALUES ('a'); CREATE TABLE b(wrong TEXT);");
  await assert.rejects(applyRule({ type: 'sqlite', root, patterns: ['*.db'], key: 'sessionId', tables: [{ table: 'a', column: 'session_id' }, { table: 'b', column: 'session_id' }] }, { id: 'a' }, {}), /Missing identity column/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM a').get().n, 1); db.close();
});

test('commands get literal arguments and stdin; dry-run never executes them', async t => {
  const { root } = await fixture(t);
  const target = path.join(root, 'command.json');
  const rule = { name: 'command', type: 'command', command: '{node}', args: ['-e', "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>require('fs').writeFileSync(process.argv[1],s));", target] };
  const record = { id: 'abc', path: '/sessions/abc.jsonl', cwd: root };
  const vars = { node: process.execPath, agentDir: root };
  await applyRule(rule, record, vars, true);
  await assert.rejects(fs.stat(target), { code: 'ENOENT' });
  await applyRule(rule, record, vars);
  assert.equal(JSON.parse(await fs.readFile(target)).id, 'abc');
});

test('invalid configuration and unsafe patterns are rejected', () => {
  assert.equal(validateConfig({}).retentionDays, 30);
  assert.equal('pollSeconds' in validateConfig({}), false);
  assert.throws(() => validateConfig({ pollSeconds: 30 }), /Unknown configuration key: pollSeconds/);
  for (const config of [{ retentionDays: 0 }, { pollSeconds: 0 }, { rules: [{ name: 'bad', type: 'paths', root: '/tmp', patterns: ['*'] }] }, { rules: [{ name: 'bad', type: 'paths', root: '/tmp', patterns: ['../{sessionId}'] }] }]) assert.throws(() => validateConfig(config));
});

test('locks serialize cleaners, including dry-run, and stale locks fail closed', async t => {
  const { root, cleaner } = await fixture(t);
  const lock = path.join(root, 'state/session-cleanup/lock');
  await fs.mkdir(lock, { recursive: true });
  await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }));
  assert.equal((await cleaner.run()).pending.length, 1);
  await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: 2147483647 }));
  await assert.rejects(cleaner.run(), /Stale cleanup lock/);
});

test('falsy or malformed PID guards block expiration and metadata cleanup', async t => {
  const { root, cleaner, add, present } = await fixture(t, { retentionDays: 30, rules: [{ name: 'guarded', type: 'paths', root: '{agentDir}/metadata', patterns: ['{sessionId}'], guards: [{ file: 'lease.json', pidField: 'pid' }] }] });
  const p = await add('guarded');
  const old = new Date(Date.now() - 31 * 86400000); await fs.utimes(p, old, old);
  for (const value of [null, false, 0, '', [], {}, { pid: 0 }]) {
    await fs.writeFile(path.join(root, 'metadata/guarded/lease.json'), JSON.stringify(value));
    assert.equal((await cleaner.run()).errors.length, 1);
    assert.equal(await present(p), true);
    assert.equal(await present(path.join(root, 'metadata/guarded')), true);
  }
});

test('preview accounts for two expired copies of one session ID', async t => {
  const { cleaner, add } = await fixture(t, { retentionDays: 30 });
  const old = new Date(Date.now() - 31 * 86400000);
  for (const filename of ['first.jsonl', 'second.jsonl']) { const p = await add('a', filename); await fs.utimes(p, old, old); }
  const report = await cleaner.run({ dryRun: true });
  assert.equal(report.preview.filter(p => p.reason === 'expired').length, 2);
  assert.equal(report.preview.filter(p => p.rule === 'files').length, 1);
});

test('a lease published during a command protects against subsequent rules', async t => {
  const { root, cleaner, add, present, config } = await fixture(t);
  const p = await add('a'); await cleaner.run(); await fs.unlink(p);
  await fs.mkdir(path.dirname(cleaner.leasePath), { recursive: true });
  config.rules.unshift({ name: 'publish-lease', type: 'command', command: '{node}', args: ['-e', 'require("fs").writeFileSync(process.argv[1],process.argv[2])', cleaner.leasePath, JSON.stringify({ pid: process.pid, path: p })] });
  await fs.writeFile(path.join(root, 'session-cleanup.json'), JSON.stringify(config));
  const report = await cleaner.run();
  assert.deepEqual(report.errors, []); assert.deepEqual(report.pending, ['a']);
  assert.equal(await present(path.join(root, 'metadata/a')), true);
});

test('command timeout releases inherited stderr pipes and kills its owned group', { timeout: 5000 }, async () => {
  const script = `const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','ignore','inherit']});c.unref();process.exit(0);`;
  const started = Date.now();
  await assert.rejects(runCommand(process.execPath, ['-e', script], {}, 200), /timed out/);
  assert.ok(Date.now() - started < 3000);
});

test('session-named JSON files are configurable without removing siblings', async t => {
  const rule = { name: 'json-files', type: 'paths', root: '{agentDir}/metadata', patterns: ['{sessionId}.json'] };
  const { root, cleaner, add, present } = await fixture(t, { rules: [rule] });
  const p = await add('a');
  await fs.writeFile(path.join(root, 'metadata/a.json'), '{}');
  await fs.writeFile(path.join(root, 'metadata/ab.json'), '{}');
  await cleaner.run(); await fs.unlink(p);
  assert.deepEqual((await cleaner.run()).errors, []);
  assert.equal(await present(path.join(root, 'metadata/a.json')), false);
  assert.equal(await present(path.join(root, 'metadata/ab.json')), true);
});

test('pattern matching does not cross boundaries or follow symlinks', async t => {
  const { root } = await fixture(t);
  await fs.mkdir(path.join(root, 'metadata/a-123'), { recursive: true });
  await fs.mkdir(path.join(root, 'metadata/ab-123'), { recursive: true });
  assert.deepEqual(await matches('{root}/metadata', ['{sessionId}-*'], { root, sessionId: 'a' }), [path.join(root, 'metadata/a-123')]);
});
