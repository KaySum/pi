import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

const DAY = 86400000;
const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
const sessionId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
export const hash = (s) => createHash('sha256').update(s).digest('hex');
export const alive = (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true; // Unknown ownership: fail closed.
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
};
const exists = async (p) => { try { await fs.lstat(p); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
export async function readJson(p, fallback) {
  try { return JSON.parse(await fs.readFile(p, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
export async function atomicJson(p, value) {
  await fs.mkdir(path.dirname(p), { recursive: true, mode: 0o700 });
  const tmp = `${p}.${randomUUID()}.tmp`;
  try { await fs.writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); await fs.rename(tmp, p); }
  finally { await fs.rm(tmp, { force: true }); }
}

export function validateConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('Configuration must be an object');
  const allowed = ['enabled', 'retentionDays', 'sessionRoots', 'rules'];
  for (const key of Object.keys(raw)) if (!allowed.includes(key)) throw Error(`Unknown configuration key: ${key}`);
  const c = { enabled: true, retentionDays: 30, sessionRoots: ['{agentDir}/sessions'], rules: [], ...raw };
  if (typeof c.enabled !== 'boolean' || !(c.retentionDays === null || Number.isFinite(c.retentionDays) && c.retentionDays > 0)) throw Error('Invalid enabled/retentionDays');
  if (!Array.isArray(c.sessionRoots) || !c.sessionRoots.length || !c.sessionRoots.every(x => typeof x === 'string' && x.length)) throw Error('sessionRoots must be a nonempty string array');
  if (!Array.isArray(c.rules)) throw Error('rules must be an array');
  const names = new Set();
  for (const r of c.rules) {
    if (!r || typeof r.name !== 'string' || !r.name || names.has(r.name)) throw Error('Each rule needs a unique name');
    names.add(r.name);
    if (r.enabled === false) continue;
    if (r.type === 'command') {
      if (typeof r.command !== 'string' || !r.command || !Array.isArray(r.args) || !r.args.every(x => typeof x === 'string')) throw Error(`Invalid command rule: ${r.name}`);
      if (r.timeoutSeconds !== undefined && (!Number.isFinite(r.timeoutSeconds) || r.timeoutSeconds <= 0)) throw Error(`Invalid timeout: ${r.name}`);
    } else if (r.type === 'paths' || r.type === 'sqlite') {
      if (typeof r.root !== 'string' || !r.root || !Array.isArray(r.patterns) || !r.patterns.length) throw Error(`Invalid paths: ${r.name}`);
      for (const p of r.patterns) {
        if (typeof p !== 'string' || path.isAbsolute(p) || p.split('/').some(x => !x || x === '.' || x === '..' || x.includes('**') || x.includes('\\'))) throw Error(`Unsafe pattern: ${r.name}`);
        if (r.type === 'paths' && !p.split('/').some(x => /^\{sessionId\}(?:\.[A-Za-z0-9._-]+|-\*)?$/.test(x))) throw Error(`Path rule must target a sessionId directory/file or sessionId-* directory: ${r.name}`);
      }
      if (r.type === 'sqlite') {
        if (!['sessionId', 'sessionPathHash16'].includes(r.key) || !Array.isArray(r.tables) || !r.tables.length || !r.tables.every(t => identifier.test(t.table) && identifier.test(t.column))) throw Error(`Invalid SQLite rule: ${r.name}`);
      }
      for (const g of r.guards ?? []) {
        if (typeof g.file !== 'string' || path.basename(g.file) !== g.file || !identifier.test(g.pidField)) throw Error(`Invalid PID guard: ${r.name}`);
      }
    } else throw Error(`Unknown rule type: ${r.type}`);
  }
  return c;
}

export function expand(text, vars) {
  const expanded = text.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_, k) => {
    if (!(k in vars) || typeof vars[k] !== 'string') throw Error(`Unknown template variable: ${k}`);
    return vars[k];
  });
  return expanded.startsWith('~/') ? path.join(os.homedir(), expanded.slice(2)) : expanded;
}

// Refuse symbolic links anywhere in a deletion path, including ancestors.
export async function noSymlinks(p) {
  if (!path.isAbsolute(p)) throw Error(`Expected absolute path: ${p}`);
  let current = path.parse(p).root;
  for (const segment of p.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw Error(`Refusing symlink: ${current}`); }
    catch (e) { if (e.code === 'ENOENT') return false; throw e; }
  }
  return true;
}
export async function matches(root, patterns, vars) {
  root = expand(root, vars);
  if (!path.isAbsolute(root)) throw Error(`Rule root must be absolute: ${root}`);
  if (!await noSymlinks(root)) return [];
  const found = new Set();
  for (const pattern of patterns) {
    const segments = expand(pattern, vars).split('/');
    if (segments.some(s => !s || s === '..' || s === '.')) throw Error('Unsafe expanded pattern');
    let parents = [root];
    for (const segment of segments) {
      const next = [];
      const re = new RegExp('^' + segment.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
      for (const parent of parents) {
        if (!await noSymlinks(parent)) continue;
        const info = await fs.lstat(parent);
        if (!info.isDirectory()) continue;
        for (const entry of await fs.readdir(parent, { withFileTypes: true })) {
          if (!re.test(entry.name)) continue;
          if (entry.isSymbolicLink()) throw Error(`Refusing symlink: ${path.join(parent, entry.name)}`);
          next.push(path.join(parent, entry.name));
        }
      }
      parents = next;
    }
    for (const p of parents) found.add(p);
  }
  return [...found];
}

export async function runCommand(command, args, input, timeoutMs = 30000) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '', settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.destroy();
      child.stderr.destroy();
      error ? reject(error) : resolve();
    };
    const timer = setTimeout(() => {
      // Kill only the process group created by this spawn, never a persisted PID.
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { /* Report timeout even if the child already exited. */ }
      // An inherited pipe must not keep the cleanup lock held indefinitely.
      finish(Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stderr.on('data', d => { stderr = (stderr + d).slice(-2000); });
    child.stdin.on('error', () => {});
    child.on('error', finish);
    child.on('close', (code, signal) => finish(code === 0 ? undefined : Error(`${command} failed (${signal ?? code}): ${stderr}`)));
    child.stdin.end(JSON.stringify(input));
  });
}

export async function applyRule(rule, record, vars, dryRun = false) {
  if (rule.type === 'command') {
    const command = expand(rule.command, vars), args = rule.args.map(a => expand(a, vars));
    if (!dryRun) await runCommand(command, args, { ...record, agentDir: vars.agentDir }, (rule.timeoutSeconds ?? 30) * 1000);
    return [`command ${rule.name}`];
  }
  const targets = await matches(rule.root, rule.patterns, vars);
  for (const target of targets) {
    for (const g of rule.guards ?? []) {
      const leasePath = path.join(target, g.file);
      await noSymlinks(leasePath);
      const missing = Symbol('missing');
      const lease = await readJson(leasePath, missing);
      if (lease !== missing && (!lease || typeof lease !== 'object' || Array.isArray(lease) || alive(lease[g.pidField]))) throw Error(`Active or unknown owner: ${target}`);
    }
    if (dryRun) continue;
    if (!await noSymlinks(target)) continue;
    if (rule.type === 'paths') await fs.rm(target, { recursive: true, force: true });
    else {
      // Open only existing regular files. Never unlink a shared database.
      if (!(await fs.lstat(target)).isFile()) throw Error(`Not a database file: ${target}`);
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(target, { enableForeignKeyConstraints: true });
      try {
        db.exec('PRAGMA busy_timeout=1000; BEGIN IMMEDIATE');
        const key = rule.key === 'sessionId' ? record.id : hash(record.path).slice(0, 16);
        for (const { table, column } of rule.tables) {
          if (!db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(table)) continue;
          if (!db.prepare(`PRAGMA table_info("${table}")`).all().some(c => c.name === column)) throw Error(`Missing identity column: ${table}.${column}`);
          db.prepare(`DELETE FROM "${table}" WHERE "${column}" = ?`).run(key);
        }
        db.exec('COMMIT');
      } finally { db.close(); }
    }
  }
  return targets;
}

async function scan(roots) {
  const records = new Map();
  async function walk(dir) {
    if (!await noSymlinks(dir)) throw Error(`Session root disappeared: ${dir}`);
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(p);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try {
          // Read just a bounded header, not the conversation.
          const handle = await fs.open(p, 'r');
          let header, stat;
          try {
            stat = await handle.stat();
            const buf = Buffer.alloc(65536);
            const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
            const line = buf.subarray(0, bytesRead).toString('utf8').split('\n')[0];
            header = JSON.parse(line);
          } finally { await handle.close(); }
          if (header.type !== 'session' || typeof header.id !== 'string' || !sessionId.test(header.id) || typeof header.cwd !== 'string' || !path.isAbsolute(header.cwd)) continue;
          records.set(p, { id: header.id, path: p, cwd: header.cwd, mtimeMs: stat.mtimeMs });
        } catch (e) {
          if (e.code === 'ENOENT' || e instanceof SyntaxError) continue;
          throw e;
        }
      }
    }
  }
  for (const root of roots) await walk(root);
  return records;
}

export class Cleaner {
  constructor(agentDir, configPath = path.join(agentDir, 'session-cleanup.json'), removeTranscript = async p => {
    try { await runCommand('trash', [p], {}, 10000); }
    catch { if (await exists(p)) await fs.unlink(p); }
  }) {
    this.removeTranscript = removeTranscript;
    this.agentDir = path.resolve(agentDir);
    this.configPath = configPath;
    this.stateDir = path.join(this.agentDir, 'state/session-cleanup');
    this.leasePath = path.join(this.stateDir, 'leases', `${process.pid}-${randomUUID()}.json`);
  }
  async config() { return validateConfig(await readJson(this.configPath, {})); }
  async lease(sessionPath) {
    await atomicJson(this.leasePath, { pid: process.pid, path: sessionPath ? path.resolve(sessionPath) : null });
  }
  async close() { await fs.rm(this.leasePath, { force: true }); }
  async activePaths() {
    const paths = new Set();
    const dir = path.join(this.stateDir, 'leases');
    if (!await exists(dir)) return paths;
    for (const name of await fs.readdir(dir)) {
      if (!name.endsWith('.json')) continue;
      const p = path.join(dir, name), lease = await readJson(p, null);
      if (!lease) continue;
      if (alive(lease.pid)) {
        if (lease.path) paths.add(path.resolve(lease.path));
      } else await fs.rm(p, { force: true });
    }
    return paths;
  }
  async run({ dryRun = false, now = Date.now() } = {}) {
    const config = await this.config();
    const report = { expired: [], cleaned: [], pending: [], errors: [], preview: [] };
    if (!config.enabled) return report;
    await fs.mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    // mkdir lock serializes cleaners across Pi processes. Unknown locks fail closed.
    const lock = path.join(this.stateDir, 'lock');
    try { await fs.mkdir(lock); }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const owner = await readJson(path.join(lock, 'owner.json'), null);
      if (!owner) throw Error(`Cleanup lock has no owner: ${lock}. If this persists, stop Pi instances and remove this lock directory.`);
      if (alive(owner.pid)) return { ...report, pending: ['Another cleanup owns the lock'] };
      // Do not race another process reclaiming the same lock. Recovery is explicit.
      throw Error(`Stale cleanup lock: ${lock}. After stopping Pi instances, remove this lock directory to resume.`);
    }
    try {
      await atomicJson(path.join(lock, 'owner.json'), { pid: process.pid });
      const statePath = path.join(this.stateDir, 'inventory.json');
      const state = await readJson(statePath, { version: 1, records: {} });
      if (state.version !== 1 || !state.records || typeof state.records !== 'object') throw Error('Invalid cleanup inventory');
      const baseVars = { agentDir: this.agentDir, home: os.homedir(), node: process.execPath };
      const roots = config.sessionRoots.map(r => path.resolve(expand(r, baseVars)));
      const live = await scan(roots); // Incomplete inventories must never trigger cleanup.
      const active = await this.activePaths();
      const liveIds = new Set([...live.values()].map(r => r.id));
      for (const [p, r] of live) {
        // A restored transcript may have recreated previously cleaned metadata.
        state.records[hash(p)] = { ...r, done: [] };
      }
      // Journal the identity BEFORE deleting a transcript, including on first run.
      if (!dryRun) await atomicJson(statePath, state);
      for (const [key, r] of Object.entries(state.records)) {
        if (typeof r.id !== 'string' || !sessionId.test(r.id) || typeof r.path !== 'string' || !path.isAbsolute(r.path) || typeof r.cwd !== 'string' || !path.isAbsolute(r.cwd) || !Array.isArray(r.done)) throw Error('Invalid inventory record');
        if (!roots.some(root => r.path.startsWith(root + path.sep))) continue;
        if (active.has(r.path) || [...live.values()].some(other => other.id === r.id && active.has(other.path))) continue;
        try {
          if (live.has(r.path)) {
            if (config.retentionDays === null || now - r.mtimeMs < config.retentionDays * DAY) continue;
            if (dryRun) {
              report.preview.push({ session: r.path, reason: 'expired' });
              live.delete(r.path); // Simulate deletions so duplicate-ID plans match a real scan.
              const vars = { ...baseVars, sessionId: r.id, sessionFile: r.path, sessionPathHash16: hash(r.path).slice(0, 16), cwd: r.cwd };
              if (![...live.values()].some(other => other.id === r.id && other.path !== r.path)) {
                for (const rule of config.rules.filter(r => r.enabled !== false)) report.preview.push({ session: r.path, rule: rule.name, targets: await applyRule(rule, r, vars, true) });
              }
              continue;
            }
            // Check configured metadata leases before expiring the transcript too.
            const vars = { ...baseVars, sessionId: r.id, sessionFile: r.path, sessionPathHash16: hash(r.path).slice(0, 16), cwd: r.cwd };
            for (const rule of config.rules.filter(r => r.enabled !== false && r.type === 'paths')) await applyRule(rule, r, vars, true);
            // Recheck modification and leases immediately before removal.
            const stat = await fs.stat(r.path);
            if (stat.mtimeMs !== r.mtimeMs || (await this.activePaths()).has(r.path)) continue;
            await noSymlinks(r.path);
            await this.removeTranscript(r.path);
            if (await exists(r.path)) throw Error('Transcript still exists after deletion');
            live.delete(r.path);
            if (![...live.values()].some(other => other.id === r.id)) liveIds.delete(r.id);
            report.expired.push(r.path);
          } else if (await exists(r.path)) {
            // Malformed/replaced transcript is not evidence of deletion.
            continue;
          }
          if (liveIds.has(r.id)) continue;
          if ((await this.activePaths()).has(r.path) || await exists(r.path)) continue;
          const vars = { ...baseVars, sessionId: r.id, sessionFile: r.path, sessionPathHash16: hash(r.path).slice(0, 16), cwd: r.cwd };
          let failed = false;
          const protectedNow = async () => {
            if ((await this.activePaths()).has(r.path) || (!dryRun && await exists(r.path))) return true;
            if (!dryRun && [...(await scan(roots)).values()].some(other => other.id === r.id)) return true;
            return false;
          };
          for (const rule of config.rules.filter(r => r.enabled !== false)) {
            const signature = hash(JSON.stringify(rule));
            if (r.done.includes(signature)) continue;
            try {
              if (await protectedNow()) { failed = true; break; }
              const targets = await applyRule(rule, r, vars, dryRun);
              if (dryRun) report.preview.push({ session: r.path, rule: rule.name, targets });
              else { r.done.push(signature); await atomicJson(statePath, state); }
            } catch (e) { failed = true; report.errors.push(`${r.id} / ${rule.name}: ${e.message}`); }
          }
          if (await protectedNow()) failed = true;
          if (!dryRun && !failed) { delete state.records[key]; report.cleaned.push(r.id); }
          else if (failed) report.pending.push(r.id);
        } catch (e) { report.errors.push(`${r.path}: ${e.message}`); }
      }
      if (!dryRun) await atomicJson(statePath, state);
      return report;
    } finally { await fs.rm(lock, { recursive: true, force: true }); }
  }
}
