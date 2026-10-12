#!/usr/bin/env node
// Checks nvim_navigate against answers that are known without asking anyone.
//
// It generates a project in which every symbol has a unique name. For such a name, "every
// reference" is exactly "every whole-word occurrence in the project", which a text search
// finds, and the generator knows where and how it defined each one. The project is then
// changed on disk again and again (lines inserted, symbols renamed and moved, files added
// and removed) and after every change random questions are asked and compared, exactly,
// with that truth. A failure prints the seed that replays it.
//
// Not part of the test suite: it needs your language servers and takes minutes.
//
//   node test/oracle.mjs                    every language, each schedule
//   node test/oracle.mjs rust --seed=7      one language, a given project
//   --rounds=6 --questions=30               changes per schedule, questions after each
//   --keep                                  leave the generated projects in place
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { launch } from '../../nvim-service/service.mjs';
import { openNvim } from '../../nvim-service/nvim.mjs';
import { warmer } from '../../nvim-diagnostics/core.mjs';
import { navigate } from '../core.mjs';

const { values: options, positionals } = parseArgs({ allowPositionals: true, options: {
  seed: { type: 'string', default: String(Date.now() % 100000) }, rounds: { type: 'string', default: '6' },
  questions: { type: 'string', default: '30' }, keep: { type: 'boolean', default: false } } });

// How each language writes the same small program. `sig` is what hover must show wherever
// the symbol is pointed at: a use through an import is described differently from the
// definition ("(alias) fn(a: number)", "constructor Thing()"), so it is only the part
// every description has.
const LANGUAGES = {
  typescript: {
    file: name => `src/${name}.ts`, comment: '//', project: { 'tsconfig.json': '{ "compilerOptions": { "strict": true }, "include": ["src"] }\n' },
    actions: ['definition', 'references', 'hover', 'symbols', 'workspace_symbols', 'type', 'implementation'],
    imports: (from, names) => `import { ${names.join(', ')} } from "./${from}";`,
    fn: (s, calls) => ({ text: `export function ${s}(a: number): number { return a${calls.map(c => ` + ${c}(1)`).join('')}; }`, sig: `${s}(a: number): number` }),
    iface: s => ({ text: `export interface ${s} { size: number }`, sig: s }),
    cls: (s, iface) => ({ text: `export class ${s} implements ${iface} { size = 1; }`, sig: s }),
    val: (s, cls) => ({ text: `export const ${s}: ${cls} = new ${cls}();`, sig: `${s}: ${cls}` }),
  },
  python: {
    file: name => `${name}.py`, comment: '#', project: { 'pyrightconfig.json': '{}\n' },
    actions: ['definition', 'references', 'hover', 'symbols', 'workspace_symbols', 'type'],
    imports: (from, names) => `from ${from} import ${names.join(', ')}`,
    fn: (s, calls) => ({ text: `def ${s}(a: int) -> int:\n    return a${calls.map(c => ` + ${c}(1)`).join('')}`, sig: `${s}(a: int) -> int` }),
    iface: s => ({ text: `class ${s}:\n    size: int = 0`, sig: s }),
    cls: (s, iface) => ({ text: `class ${s}(${iface}):\n    size: int = 1`, sig: s }),
    val: (s, cls) => ({ text: `${s}: ${cls} = ${cls}()`, sig: `${s}: ${cls}` }),
  },
  rust: {
    file: name => `src/${name}.rs`, comment: '//', project: { 'Cargo.toml': '[package]\nname = "oracle"\nversion = "0.1.0"\nedition = "2021"\n' },
    // No `type`: rust-analyzer gives no type definition for the name of a static item, settled or not.
    actions: ['definition', 'references', 'hover', 'symbols', 'workspace_symbols'],
    // The crate root declares every module; nothing else is in it.
    root: modules => ({ path: 'src/main.rs', text: `${modules.map(m => `mod ${m};`).join('\n')}\n\nfn main() {}\n` }),
    imports: (from, names) => `#[allow(unused_imports)]\nuse crate::${from}::{${names.join(', ')}};`,
    fn: (s, calls) => ({ text: `#[allow(dead_code)]\npub fn ${s}(a: i32) -> i32 { a${calls.map(c => ` + ${c}(1)`).join('')} }`, sig: `fn ${s}(a: i32) -> i32` }),
    iface: s => ({ text: `#[allow(dead_code, non_camel_case_types)]\npub trait ${s} { fn size(&self) -> i32 { 0 } }`, sig: s }),
    cls: (s, iface) => ({ text: `#[allow(dead_code, non_camel_case_types)]\npub struct ${s};\nimpl ${iface} for ${s} {}`, sig: s }),
    val: (s, cls) => ({ text: `#[allow(dead_code, non_upper_case_globals)]\npub static ${s}: ${cls} = ${cls};`, sig: `static ${s}: ${cls}` }),
  },
};
const unknown = positionals.filter(name => !LANGUAGES[name]);
if (unknown.length) { console.error(`Unknown language: ${unknown.join(', ')}. Known: ${Object.keys(LANGUAGES).join(', ')}`); process.exit(2); }

// A small seeded generator, so a failing project can be built again.
function random(seed) {
  let a = seed >>> 0;
  const next = () => { a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  return { int: n => Math.floor(next() * n), pick: list => list[Math.floor(next() * list.length)], chance: p => next() < p };
}

// The model: modules in order, each a list of symbols. A function may only call functions
// of earlier modules, and a class or value only names things in its own module or earlier
// ones, so imports never form a cycle whatever is moved where.
function generate(rng) {
  const project = { counter: 0, modules: [] };
  for (let m = 0; m < 5; m++) addModule(project, rng);
  return project;
}
function addModule(project, rng) {
  const module = { name: `mod_${project.counter++}`, pad: rng.int(3), items: [] };
  const earlier = kind => project.modules.flatMap(other => other.items.filter(item => item.kind === kind).map(item => item.name));
  const iface = { kind: 'iface', name: `Shape_${project.counter++}` };
  const cls = { kind: 'cls', name: `Thing_${project.counter++}`, uses: [iface.name] };
  module.items.push(iface, cls, { kind: 'val', name: `value_${project.counter++}`, uses: [cls.name] });
  for (let i = 0; i < 2 + rng.int(3); i++) {
    const calls = earlier('fn').filter(() => rng.chance(0.35)).slice(0, 3);
    module.items.push({ kind: 'fn', name: `fn_${project.counter++}`, uses: calls });
  }
  // A name that contains another, and a function calling both: asked for by its text, the
  // shorter one must not be found inside the longer one standing before it on the line.
  const base = earlier('fn').filter(name => /^fn_\d+$/.test(name));
  if (base.length) {
    const short = rng.pick(base), long = project.modules.flatMap(m => m.items).find(item => item.name.startsWith(`${short}_x`))?.name;
    if (long) module.items.push({ kind: 'fn', name: `fn_${project.counter++}`, uses: [long, short] });
    else module.items.push({ kind: 'fn', name: `${short}_x${project.counter++}`, uses: [] });
  }
  project.modules.push(module);
  return module;
}
const home = (project, name) => project.modules.findIndex(module => module.items.some(item => item.name === name));
const users = (project, name) => project.modules.flatMap((module, index) => module.items.some(item => item.uses?.includes(name)) ? [index] : []);

const MUTATIONS = {
  // Lines appear above everything in a file: every position in it moves.
  pad(project, rng) { rng.pick(project.modules).pad += 1 + rng.int(4); },
  rename(project, rng) {
    const item = rng.pick(rng.pick(project.modules).items), to = `${item.name.replace(/_\d+$/, '')}_${project.counter++}`;
    for (const module of project.modules) for (const other of module.items) other.uses = other.uses?.map(name => name === item.name ? to : name);
    item.name = to;
  },
  // A function goes to another module, wherever the rule about cycles still holds.
  move(project, rng) {
    const functions = project.modules.flatMap(module => module.items.filter(item => item.kind === 'fn'));
    const item = rng.pick(functions), from = home(project, item.name);
    const low = Math.max(-1, ...item.uses.map(name => home(project, name))), high = Math.min(project.modules.length, ...users(project, item.name));
    const targets = project.modules.map((_, index) => index).filter(index => index > low && index < high && index !== from);
    if (!targets.length) return MUTATIONS.pad(project, rng);
    project.modules[from].items = project.modules[from].items.filter(other => other !== item);
    project.modules[rng.pick(targets)].items.push(item);
  },
  reorder(project, rng) { const module = rng.pick(project.modules); module.items.push(module.items.shift()); },
  add(project, rng) { addModule(project, rng); },
  // The last module is used by nobody, so it can go without leaving a dangling import.
  remove(project, rng) { if (project.modules.length > 3) project.modules.pop(); else MUTATIONS.pad(project, rng); },
};

// Files as the language writes them, and from those alone the truth about every symbol.
function render(project, language) {
  const files = new Map(Object.entries(language.project ?? {}));
  const symbols = new Map();
  for (const [index, module] of project.modules.entries()) {
    const needed = new Map();
    for (const item of module.items) for (const name of item.uses ?? []) {
      const from = home(project, name);
      if (from !== index) needed.set(project.modules[from].name, [...needed.get(project.modules[from].name) ?? [], name]);
    }
    // Longer names first: fn_12 then fn_1 on one line is where "fn_1" could be found inside the other.
    const longest = names => [...new Set(names)].sort((a, b) => b.length - a.length || b.localeCompare(a));
    const parts = [...Array(module.pad).fill(`${language.comment} padding`), ...[...needed].map(([from, names]) => language.imports(from, longest(names)))];
    // A class or value is written after what it names; functions call across modules only.
    const order = { iface: 0, cls: 1, val: 2, fn: 3 };
    for (const item of [...module.items].sort((a, b) => order[a.kind] - order[b.kind])) {
      const written = language[item.kind](item.name, item.kind === 'fn' ? longest(item.uses) : item.uses?.[0]);
      parts.push(written.text);
      symbols.set(item.name, { ...item, sig: written.sig, module: module.name });
    }
    files.set(language.file(module.name), `${parts.join('\n')}\n`);
  }
  if (language.root) { const root = language.root(project.modules.map(module => module.name)); files.set(root.path, root.text); }
  // Truth by text search: a unique name's occurrences are its references, and the one in its own module's defining line its definition.
  for (const [name, symbol] of symbols) {
    symbol.occurrences = [];
    for (const [path, text] of files) {
      text.split('\n').forEach((line, row) => {
        for (const match of line.matchAll(new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`, 'g'))) symbol.occurrences.push({ path, line: row + 1, column: match.index + 1 });
      });
    }
    // The first occurrence in its own file that is not an import is where it is defined.
    const own = language.file(symbol.module);
    const importLines = new Set(files.get(own).split('\n').flatMap((line, row) => /^(import |from |use )/.test(line) ? [row + 1] : []));
    symbol.definition = symbol.occurrences.find(o => o.path === own && !importLines.has(o.line));
  }
  return { files, symbols };
}

// What nvim_navigate printed, back as data: it is the text Pi reads that has to be right.
function locations(text) {
  const found = [];
  let path;
  for (const line of text.split('\n').slice(1)) {
    const at = /^  (\d+):(\d+)  /.exec(line);
    if (at) found.push({ path, line: Number(at[1]), column: Number(at[2]) }); else if (line && !line.startsWith('  ')) path = line;
  }
  return found;
}
const key = o => `${o.path}:${o.line}:${o.column}`;
const same = (a, b) => a.length === b.length && new Set([...a.map(key), ...b.map(key)]).size === a.length;

// One random question and its answer by the truth; returns what is wrong with the tool's, if anything.
// `forced` fixes any of the symbol, the action and the place instead of leaving them to chance.
async function question(nvim, directory, truth, language, rng, forced = {}) {
  const symbol = forced.symbol ?? rng.pick([...truth.symbols.values()]);
  const action = forced.action ?? rng.pick(language.actions.filter(a => a !== 'type' || symbol.kind === 'val').filter(a => a !== 'implementation' || symbol.kind === 'iface'));
  const use = forced.use ?? rng.pick(symbol.occurrences);
  // Half the time the symbol is given by its text alone, as Pi gives it; that is only
  // unambiguous for the first place it stands on its line, so those are the ones used.
  const first = !symbol.occurrences.some(o => o.path === use.path && o.line === use.line && o.column < use.column);
  const at = { file: use.path, line: use.line, symbol: symbol.name, column: first && (forced.byText || rng.chance(0.5)) ? undefined : use.column };
  const ask = async params => { try { return await navigate(nvim, { timeoutMs: 30000, ...params }, directory); } catch (error) { return `ERROR ${error.message}`; } };
  let asked, got, expected, wrong;
  if (action === 'definition' || action === 'type' || action === 'implementation') {
    const target = action === 'definition' ? symbol : truth.symbols.get(action === 'type' ? symbol.uses[0]
      : [...truth.symbols.values()].find(other => other.kind === 'cls' && other.uses[0] === symbol.name)?.name);
    // An interface nobody implements any more has no implementation to find.
    expected = target ? [target.definition] : [];
    got = await ask(asked = { action, ...at });
    wrong = !same(locations(got), expected);
  } else if (action === 'references') {
    expected = symbol.occurrences;
    got = await ask(asked = { action, ...at });
    wrong = !same(locations(got), expected);
  } else if (action === 'hover') {
    expected = symbol.sig;
    got = await ask(asked = { action, ...at });
    wrong = !got.replace(/\s+/g, ' ').includes(expected);
  } else if (action === 'symbols') {
    const path = language.file(symbol.module);
    expected = [...truth.symbols.values()].filter(other => other.module === symbol.module).map(other => `  ${other.definition.line}: `.concat('*', ' ', other.name));
    got = await ask(asked = { action, file: path });
    // Every symbol of the file is in the outline, at its line, and only once at the top level.
    wrong = [...truth.symbols.values()].filter(other => other.module === symbol.module)
      .some(other => got.split('\n').filter(line => new RegExp(`^  ${other.definition.line}: \\w+ ${other.name}$`).test(line)).length !== 1);
  } else {
    expected = `${symbol.name}  ${symbol.definition.path}:${symbol.definition.line}`;
    got = await ask(asked = { action, file: use.path, query: symbol.name });
    wrong = !got.split('\n').some(line => new RegExp(`^  \\w+ ${symbol.name}(\\(\\))?( in \\S+)?  ${symbol.definition.path.replace(/[.[\]/]/g, '\\$&')}:${symbol.definition.line}$`).test(line));
  }
  return wrong && { asked, expected, got };
}

// Changes that only touch files the editor has open (every module is, once its outline has
// been asked for). Adding or removing a file also changes ones that are not, which servers
// only learn of from their file watchers.
const OPEN_FILES_ONLY = ['pad', 'rename', 'move', 'reorder'];
const SCHEDULES = {
  // A change from outside (a formatter, git) to open files, and the question at once.
  'asked at once after a change to open files': async () => {},
  // The same for any change, with a moment for the file watchers.
  'asked 1 s after each change': async () => { await delay(1000); },
  // What happens in Pi: its edit starts a background check of the file, and the question follows at once.
  'asked while a diagnostics warm-up runs': async (warm, changed) => { for (const path of changed) void warm.add(path); },
};

let failed = 0;
for (const name of positionals.length ? positionals : Object.keys(LANGUAGES)) {
  const language = LANGUAGES[name];
  for (const [schedule, before] of Object.entries(SCHEDULES)) {
    const rng = random(Number(options.seed)), project = generate(rng);
    const directory = await realpath(await mkdtemp(`/tmp/pi-navigation-oracle-${name}-`));
    execFileSync('git', ['init', '-q', directory]);
    let onDisk = new Map();
    // Write what changed and delete what is gone; returns the paths that were touched.
    const sync = async files => {
      const changed = [];
      for (const [path, text] of files) if (onDisk.get(path) !== text) { await mkdir(dirname(join(directory, path)), { recursive: true }); await writeFile(join(directory, path), text); changed.push(join(directory, path)); }
      for (const path of onDisk.keys()) if (!files.has(path)) await rm(join(directory, path));
      onDisk = files;
      return changed;
    };
    let truth = render(project, language);
    await sync(truth.files);
    const service = launch({ cwd: directory });
    const nvim = await openNvim(await service.ready), warm = warmer(() => nvim);
    let asked = 0, focus;
    const failures = [];
    process.stderr.write(`${name}, ${schedule} `);
    try {
      for (let round = 0; round <= Number(options.rounds); round++) {
        // Round 0 is the cold start: the very first question meets servers that are still loading.
        const mutation = round ? rng.pick(schedule.includes('open files') ? OPEN_FILES_ONLY : Object.keys(MUTATIONS)) : 'cold start';
        if (round) {
          MUTATIONS[mutation](project, rng);
          // The file whose outline was the last thing asked always changes too (see below).
          const again = project.modules.find(module => module.name === focus);
          if (again) again.pad += 1;
          truth = render(project, language);
          await before(warm, await sync(truth.files));
        }
        const all = [...truth.symbols.values()];
        const outlines = [...new Map(all.map(symbol => [symbol.module, symbol])).values()].map(symbol => ({ symbol, action: 'symbols' }));
        // Where a name stands on a line after a longer name that contains it, it is asked for by its text.
        const contained = all.flatMap(symbol => symbol.occurrences.filter(use => all.some(other => other !== symbol && other.name.includes(symbol.name)
          && other.occurrences.some(o => o.path === use.path && o.line === use.line && o.column < use.column))).map(use => ({ symbol, use, action: 'definition', byText: true }))).slice(0, 6);
        // A server may cache the last outline it gave (vtsls keeps one). That only shows if the
        // same file is asked for twice running with a change in between: so the round ends on
        // one file's outline, and the next begins with it.
        const next = rng.pick(outlines);
        const first = outlines.find(o => o.symbol.module === focus);
        focus = next.symbol.module;
        for (const forced of [...(first ? [first] : []), ...contained, ...outlines, ...Array(Number(options.questions)).fill(undefined), next]) {
          const wrong = await question(nvim, directory, truth, language, rng, forced);
          asked++;
          if (wrong) failures.push({ round, mutation, ...wrong });
        }
        process.stderr.write(failures.length ? 'x' : '.');
      }
      const state = await nvim.state();
      if (state.prompt) failures.push({ round: 'end', mutation: 'none', asked: 'editor state', expected: 'no prompt', got: await nvim.screen() });
    } finally {
      process.stderr.write('\n');
      nvim.close();
      await service.stop();
    }
    failed += failures.length;
    const byAction = Object.entries(Object.groupBy(failures, f => f.asked.action ?? 'editor')).map(([action, list]) => `${list.length} ${action}`).join(', ');
    console.log(`${name}, ${schedule}: ${asked} questions, ${failures.length} wrong${failures.length ? ` (${byAction}) — replay with: node test/oracle.mjs ${name} --seed=${options.seed}` : ''}`);
    // One example of each kind of question that went wrong.
    const examples = Object.values(Object.groupBy(failures, f => f.asked.action ?? 'editor')).map(list => list[0]);
    for (const f of examples) {
      // For a set of places, what is missing and what is extra says more than both lists.
      const places = Array.isArray(f.expected) && typeof f.expected[0] !== 'string' && locations(String(f.got));
      const expected = places ? `${f.expected.length} places; missing ${JSON.stringify(f.expected.filter(e => !places.some(p => key(p) === key(e))).map(key))}, extra ${JSON.stringify(places.filter(p => !f.expected.some(e => key(p) === key(e))).map(key))}` : JSON.stringify(f.expected);
      console.log(`  after ${f.mutation} (round ${f.round}): ${JSON.stringify(f.asked)}\n    expected: ${expected}\n    got:      ${String(f.got).split('\n').slice(0, 12).join('\n              ')}`);
    }
    if (options.keep) console.log(`  project kept at ${directory}`); else await rm(directory, { recursive: true, force: true });
  }
}
console.log(`\nseed ${options.seed}`);
process.exit(failed ? 1 : 0);
