// One entry per kind of file the sweep exercises. To try a new language, add an entry:
//   file     path inside the scratch project
//   bad(i)   contents with a problem; i changes every round so the text is never repeated
//   good(i)  contents without one
//   expect   what a diagnostic line for the bad version must match
//   severity least severe level that counts (default error): the good version must list nothing at it
//   project  other files the servers need, as { path: contents }
export const cases = {
  typescript: {
    file: 'src/app.ts', expect: /error \[2322\]/, project: { 'tsconfig.json': '{ "compilerOptions": { "strict": true } }\n' },
    bad: i => `const n: number = "x";\nexport default n; // ${i}\n`,
    good: i => `const n: string = "x";\nexport default n; // ${i}\n`,
  },
  python: {
    file: 'app.py', expect: /error \[reportAssignmentType\]/,
    bad: i => `x: int = "s"\n# ${i}\n`,
    good: i => `x: int = 1\n# ${i}\n`,
  },
  // What rust-analyzer finds by itself, and what only cargo check finds (a use after move).
  rust: {
    file: 'src/main.rs', expect: /error \[E0(308|382)\]/, project: { 'Cargo.toml': '[package]\nname = "sweep"\nversion = "0.1.0"\nedition = "2021"\n' },
    bad: i => i % 4 < 2 ? `fn main() {\n    let x: i32 = "s";\n    println!("{} ${i}", x);\n}\n`
      : `fn main() {\n    let s = String::from("a");\n    let t = s;\n    println!("{} {} ${i}", s, t);\n}\n`,
    good: i => `fn main() {\n    let x: i32 = ${i};\n    println!("{}", x);\n}\n`,
  },
  c: {
    file: 'main.c', expect: /error \[-Wint-conversion\]/,
    bad: i => `#include <stdio.h>\nint main(void) { int x = "s"; printf("%d", x); return ${i}; }\n`,
    good: i => `#include <stdio.h>\nint main(void) { int x = 1; printf("%d", x); return ${i}; }\n`,
  },
  lua: {
    file: 'mod.lua', expect: /warning \[undefined-global\]/, severity: 'warning',
    bad: i => `local x = undefined_thing -- ${i}\nreturn x\n`,
    good: i => `local x = 1 -- ${i}\nreturn x\n`,
  },
  // Needs a project root (the sweep's scratch directory is a git repository) for link checks.
  markdown: {
    file: 'notes.md', expect: /Link to non-existent document/, severity: 'warning',
    bad: i => `# Title ${i}\n\n[a descriptive link](./nope.md)\n`,
    good: i => `# Title ${i}\n\n[a descriptive link](./notes.md)\n`,
  },
  yaml: {
    file: 'conf.yaml', expect: /error .*\(YAML\)/,
    bad: i => `a: [ # ${i}\n`,
    good: i => `a: ${i}\n`,
  },
  shell: {
    file: 'run.sh', expect: /error \[SC1\d+\]/,
    bad: i => `#!/bin/bash\nfoo( # ${i}\n`,
    good: i => `#!/bin/bash\necho hi # ${i}\n`,
  },
  json: {
    file: 'data.json', expect: /error \[\d+\]/,
    bad: i => `{ "a": ${i},, }\n`,
    good: i => `{ "a": ${i} }\n`,
  },
  dockerfile: {
    file: 'Dockerfile', expect: /Unknown instruction/,
    bad: i => `FROM alpine:3.20\nBOGUS ${i}\n`,
    good: i => `FROM alpine:3.20\nLABEL round="${i}"\n`,
  },
  toml: {
    file: 'conf.toml', expect: /error .*\(Even Better TOML\)/,
    bad: i => `a = ${i}\nb = \n`,
    good: i => `a = ${i}\nb = 1\n`,
  },
};
