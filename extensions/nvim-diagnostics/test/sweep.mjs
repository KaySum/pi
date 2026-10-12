#!/usr/bin/env node
// Runs the diagnostics check against the real language servers of your Neovim config, on
// files that are broken, fixed and broken again, and says where its answer was wrong.
// Not part of the test suite: it needs your servers, takes a few minutes, and what it
// finds depends on your setup.
//
//   node test/sweep.mjs                 every case, each way of asking
//   node test/sweep.mjs rust python     only these cases
//   --rounds=8                          changes per case and scenario (default 6)
//   --gaps=none,0,600                   scenarios: no warm-up, or a warm-up this many ms before the check
//   --keep                              leave the scratch project in place
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { launch } from '../../nvim-service/service.mjs';
import { openNvim } from '../../nvim-service/nvim.mjs';
import { diagnose, warmer } from '../core.mjs';
import { cases } from './sweep-cases.mjs';

const { values: options, positionals } = parseArgs({ allowPositionals: true,
  options: { rounds: { type: 'string', default: '6' }, gaps: { type: 'string', default: 'none,0,600' }, keep: { type: 'boolean', default: false } } });
const unknown = positionals.filter(name => !cases[name]);
if (unknown.length) { console.error(`Unknown case: ${unknown.join(', ')}. Known: ${Object.keys(cases).join(', ')}`); process.exit(2); }
const selected = Object.entries(cases).filter(([name]) => !positionals.length || positionals.includes(name));
const rounds = Number(options.rounds);

const directory = await realpath(await mkdtemp('/tmp/pi-diagnostics-sweep-'));
execFileSync('git', ['init', '-q', directory]);
const write = async (path, text) => { await mkdir(dirname(join(directory, path)), { recursive: true }); await writeFile(join(directory, path), text); };
for (const [, c] of selected) for (const [path, text] of Object.entries(c.project ?? {})) await write(path, text);

const results = Object.fromEntries(selected.map(([name]) => [name, { checks: 0, failures: [], first: [], changed: [], unchanged: [], sources: new Set() }]));
let failed = false;

// One check, judged: the bad version must show the expected diagnostic, the good version
// nothing at the case's severity, and neither may be incomplete.
async function check(nvim, name, c, bad, label, kind) {
  const started = Date.now();
  const out = await diagnose(nvim, { files: [c.file], severity: c.severity ?? 'error', timeoutMs: 30000 }, directory, undefined, { trace: true });
  const ms = Date.now() - started, r = results[name];
  const [text, timeline] = out.split('\n\nTimeline ');
  const [summary, ...listed] = text.split('\n');
  if (summary.includes('no language server or linter')) { r.skipped = true; return; }
  r.checks++;
  r[kind].push(ms);
  for (const source of summary.split(' — ')[1]?.split(', ') ?? []) r.sources.add(source);
  const wrong = summary.includes('incomplete') ? 'incomplete' : bad && !listed.some(line => c.expect.test(line)) ? 'problem not reported'
    : !bad && listed.length ? 'problem reported for a file without one' : undefined;
  if (wrong) r.failures.push(`${label}: ${wrong} (${ms} ms)\n      ${text.split('\n').join('\n      ')}\n      Timeline ${timeline.split('\n').join('\n      ')}`);
}

for (const gap of options.gaps.split(',')) {
  const service = launch({ cwd: directory });
  const nvim = await openNvim(await service.ready);
  const warm = warmer(() => nvim);
  const scenario = gap === 'none' ? 'no warm-up' : `warm-up ${gap} ms before`;
  process.stderr.write(`${scenario} `);
  try {
    for (let round = 0; round < rounds; round++) {
      const bad = round % 2 === 0;
      for (const [name, c] of selected) {
        if (results[name].skipped) continue;
        await write(c.file, (bad ? c.bad : c.good)(round));
        if (gap !== 'none') { void warm.add(join(directory, c.file)); await delay(Number(gap)); }
        await check(nvim, name, c, bad, `${scenario}, round ${round} (${bad ? 'broken' : 'fixed'})`, round === 0 ? 'first' : 'changed');
      }
      // Asking again about text nobody changed must give the same answer.
      for (const [name, c] of selected) {
        if (!results[name].skipped) await check(nvim, name, c, bad, `${scenario}, round ${round} again`, 'unchanged');
      }
      process.stderr.write('.');
    }
    const state = await nvim.state();
    if (state.prompt) { failed = true; console.log(`Neovim was left at a prompt after "${scenario}":\n${await nvim.screen()}`); }
  } finally {
    process.stderr.write('\n');
    nvim.close();
    await service.stop();
  }
}
if (!options.keep) await rm(directory, { recursive: true, force: true });

const median = list => list.length ? [...list].sort((a, b) => a - b)[list.length >> 1] : '-';
const worst = list => list.length ? Math.max(...list) : '-';
const row = (...cells) => console.log(cells.map((cell, i) => i < 2 ? String(cell).padEnd(i ? 8 : 12) : i < 7 ? String(cell).padStart(9) : `  ${cell}`).join(' '));
console.log();
row('case', 'result', 'checks', 'first', 'changed', 'slowest', 'unchanged', 'sources');
for (const [name, r] of Object.entries(results)) {
  failed ||= r.failures.length > 0;
  row(name, r.skipped ? 'SKIPPED' : r.failures.length ? 'FAILED' : 'ok', r.checks, worst(r.first), median(r.changed), worst(r.changed), median(r.unchanged),
    r.skipped ? 'no language server or linter attached' : [...r.sources].join(', '));
}
console.log('\nTimes in ms: the slowest first check of a session, the median and slowest check after a change, and the median re-check of unchanged text.');
for (const [name, r] of Object.entries(results)) {
  if (r.failures.length) console.log(`\n${name}: ${r.failures.length} wrong of ${r.checks}\n  - ${r.failures.slice(0, 3).join('\n  - ')}${r.failures.length > 3 ? `\n  … and ${r.failures.length - 3} more` : ''}`);
}
if (options.keep) console.log(`\nScratch project kept at ${directory}`);
process.exit(failed ? 1 : 0);
