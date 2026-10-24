import { Type } from '@earendil-works/pi-ai';
import { setTimeout as delay } from 'node:timers/promises';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { useRemote, type Remote } from '../nvim-remote/api.ts';

const OUTPUT_LIMIT = 16384;
const timeoutMs = Type.Optional(Type.Integer({ minimum: 100, maximum: 60000, description: 'Default 10000.' }));
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

function result(text: string) {
  // Not between the two halves of a character outside the BMP (an emoji, say).
  const end = /[\uD800-\uDBFF]/.test(text[OUTPUT_LIMIT - 1] ?? '') ? OUTPUT_LIMIT - 1 : OUTPUT_LIMIT;
  const clipped = text.length > OUTPUT_LIMIT
    ? `${text.slice(0, end)}\n[Truncated: ${end} of ${text.length} characters shown. Ask for less.]` : text;
  return { content: [{ type: 'text' as const, text: clipped }], details: {} };
}

// The editor as the user would see it, in one line. The message is the last in :messages:
// without a UI attached, the message line itself cannot be read.
const STATE = `local buf = vim.api.nvim_get_current_buf()
local cursor = vim.api.nvim_win_get_cursor(0)
local messages = vim.split(vim.api.nvim_exec2('messages', { output = true }).output, '\\n', { trimempty = true })
return { buffer = buf, file = vim.api.nvim_buf_get_name(buf), line = cursor[1], column = cursor[2] + 1,
  modified = vim.bo[buf].modified, terminal = buf == remote.terminal, message = messages[#messages] or '' }`;

type State = { buffer: number; file: string; line: number; column: number; modified: boolean; terminal: boolean; message: string };

const PART_BYTES = 4096;
// A key in Neovim notation, kept whole: modifiers (C-, S-, M-, A-, D-, T-), then a key's name
// (Esc, F12, lt, ScrollWheelUp) or any one character, punctuation included (<C-]>, <C-\>,
// <C->>). Anything else is one character.
const KEY = /<(?:[CSMADTcsmadt]-)*(?:[A-Za-z0-9_]+|[^\s])>|[\s\S]/gu;
// Refuses, with -1, while Pi's own terminal has focus; otherwise queues the keys. In one go in
// the editor, so focus cannot move between the look and the typing.
const TYPE = `local part = ...
if vim.api.nvim_get_current_buf() == remote.terminal then return -1 end
return vim.api.nvim_input(part)`;

/** As many whole keys from `keys[from]` on as fit in PART_BYTES (at least one), and where the rest starts. */
function partOf(keys: string[], from: number): [part: string, next: number] {
  let text = '', bytes = 0, next = from;
  for (; next < keys.length; next++) {
    const size = Buffer.byteLength(keys[next]);
    if (bytes + size > PART_BYTES && text) break;
    text += keys[next];
    bytes += size;
  }
  return [text, next];
}

/** `keys` cut into parts of at most PART_BYTES, never inside a key's name or a character. */
export function parts(keys: string): string[] {
  const all = Array.from(keys.matchAll(KEY), ([key]) => key), out: string[] = [];
  for (let at = 0; at < all.length;) {
    const [text, next] = partOf(all, at);
    out.push(text);
    at = next;
  }
  return out;
}

function describe(mode: string, s: State) {
  const file = s.file ? JSON.stringify(s.file) : '[No Name]';
  return `mode ${mode} | buffer ${s.buffer} ${file}${s.modified ? ' [+]' : ''}${s.terminal ? ' (your own terminal)' : ''} | ${s.line}:${s.column}`
    + (s.message ? ` | last message: ${s.message}` : '');
}

const TOOLS = ['nvim_control_lua', 'nvim_control_keys'];
// Pi loads extensions afresh on /reload and for every session, in the same process; the
// setting outlives this module there, and ends with Pi.
const SETTING = Symbol.for('pi.nvim-control');
type Setting = { on: boolean };
const USAGE = 'Usage: /nvim-control [on|off]';

export default function (pi: ExtensionAPI) {
  // Outside Neovim there is no editor to control, and no tools to cost the model anything.
  if (!process.env.NVIM) return;
  // Off until asked for: giving the model the editor the user is working in is their call.
  const setting = ((globalThis as { [SETTING]?: Setting })[SETTING] ??= { on: false });
  let context: ExtensionContext | undefined;
  // Shown only while attached: without an editor there is nothing to control.
  const show = () => context?.ui.setStatus('nvim-control', nvim() ? `control ${setting.on ? 'on' : 'off'}` : undefined);
  const nvim = useRemote(pi, show);
  pi.events.on('nvim-remote:stopped', show);

  // Off, the tools are not declared to the model: it cannot call them, and their descriptions
  // leave the system prompt. Every other tool stays as it was.
  function apply() {
    const others = pi.getActiveTools().filter(name => !TOOLS.includes(name));
    pi.setActiveTools(setting.on ? [...others, ...TOOLS] : others);
  }

  pi.on('session_start', (_event, ctx) => {
    context = ctx;
    if (!setting.on) apply(); // Registered tools start active.
    show();
  });

  pi.registerCommand('nvim-control', {
    description: 'Let the model control the Neovim Pi runs inside (on) or not (off); alone, toggles',
    getArgumentCompletions: prefix => {
      const items = [
        { value: 'on', label: 'on', description: 'Let the model control your editor' },
        { value: 'off', label: 'off', description: 'Take its tools for your editor away' },
      ].filter(item => item.value.startsWith(prefix.trim()));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      const arg = args.trim();
      const on = arg === 'on' ? true : arg === 'off' ? false : arg ? undefined : !setting.on;
      if (on === undefined) return ctx.ui.notify(USAGE, 'warning');
      context = ctx;
      setting.on = on;
      apply();
      show();
      ctx.ui.notify(on ? 'The model can control your editor' : 'The model can no longer control your editor', 'info');
    },
  });

  async function run<T>(ms: number | undefined, signal: AbortSignal | undefined, work: (remote: Remote, options: { timeout: number; signal?: AbortSignal }) => Promise<T>) {
    const remote = nvim();
    if (!remote) throw new Error('Not attached to the user\'s Neovim; /nvim-remote shows why, and /nvim-remote reconnect attaches again.');
    try { return await work(remote, { timeout: ms ?? 10000, signal }); }
    catch (error) {
      const blocking = (error as { blocking?: boolean }).blocking;
      throw blocking ? new Error(`${errorText(error)}. Answer it with nvim_control_keys (often <CR> or <Esc>).`) : error;
    }
  }

  pi.registerTool({
    name: 'nvim_control_lua',
    label: 'Neovim control Lua',
    promptSnippet: "Run Lua in the user's own Neovim, the editor Pi runs inside (their buffers, windows, plugins)",
    description: "Run Lua in the user's Neovim, the one Pi's terminal is in, and get its return value (strings as text, anything else as JSON). `...` receives args. `remote` is in scope: put what you set up (autocommands, highlights) in remote.group or remote.ns, or remove it in remote.on_detach(fn), so it goes when Pi does; remote.terminal is Pi's own terminal buffer.",
    promptGuidelines: [
      "nvim_control_lua and nvim_control_keys act on the user's real editor: their open buffers, unsaved changes included, their windows and their plugins. nvim_lua and nvim_keys are your private Neovim instead. Use the editor tools to show the user things or when asked to act in their editor; never quit Neovim, close or delete Pi's terminal (remote.terminal), discard unsaved changes, or write buffers the user is editing without being asked.",
    ],
    executionMode: 'sequential',
    parameters: Type.Object({
      code: Type.String({ minLength: 1, description: 'Lua chunk; use `return` for output.' }),
      args: Type.Optional(Type.Array(Type.Any(), { description: 'Passed to the chunk as `...`.' })),
      timeoutMs,
    }),
    execute: (_id, params, signal) => run(params.timeoutMs, signal, async (remote, options) => {
      const value = await remote.lua(params.code, params.args ?? [], options);
      return result(typeof value === 'string' ? value : JSON.stringify(value ?? null));
    }),
  });

  pi.registerTool({
    name: 'nvim_control_keys',
    label: 'Neovim control keys',
    promptSnippet: "Type keys into the user's Neovim and see the resulting state",
    description: "Type keys into the focused window of the user's Neovim, as they would, in Neovim notation (<Esc>, <CR>, <C-w>, <lt> for a literal <). Returns mode, buffer, cursor and the last message. Empty keys just looks. Refused while the focused window is Pi's own terminal, where keys would be typed into Pi: focus another window with nvim_control_lua first, or use nvim_control_lua instead.",
    executionMode: 'sequential',
    parameters: Type.Object({
      keys: Type.String({ description: 'Keys to type; may be empty.' }),
      timeoutMs,
    }),
    execute: (_id, params, signal) => run(params.timeoutMs, signal, async (remote, options) => {
      const end = Date.now() + options.timeout;
      // A busy editor (in Lua, a plugin's or a call's that timed out) still answers calls, but
      // takes in typed keys only when it is done: wait for them to be taken, or for a prompt.
      async function taken() {
        for (;;) {
          const waiting = await remote.lua('return vim.fn.getchar(1) ~= 0', [], options).catch(error => {
            if ((error as { blocking?: boolean }).blocking) return false; // The keys opened a prompt.
            throw error;
          });
          if (!waiting) return;
          if (Date.now() > end) throw new Error(`Neovim did not take in the keys within ${options.timeout} ms; it is busy`);
          await delay(20);
        }
      }
      // Neovim's input buffer holds about 16 KB and takes only what fits, so the keys go in
      // parts well below that, each once the one before is taken.
      const total = Buffer.byteLength(params.keys);
      const keys = Array.from(params.keys.matchAll(KEY), ([key]) => key);
      let typed = 0;
      for (let at = 0; at < keys.length;) {
        // At a prompt the editor runs no Lua, so the focus cannot be checked: only the one key
        // that answers it goes in that way. The keys after it may go anywhere once it closes,
        // so they wait for the check, as any others do.
        const { blocking } = await remote.request('nvim_get_mode', [], options) as { blocking: boolean };
        const [part, next] = blocking ? [keys[at], at + 1] : partOf(keys, at);
        at = next;
        const written = blocking ? await remote.request('nvim_input', [part], options) as number : await remote.lua(TYPE, [part], options) as number;
        if (written < 0) {
          throw new Error(typed
            ? `Stopped after typing ${typed} of ${total} bytes of keys: focus moved to Pi's own terminal, where the rest would be typed into Pi`
            : "The focused window is Pi's own terminal, where these keys would be typed into Pi. Focus another window with nvim_control_lua first, or use nvim_control_lua.");
        }
        typed += written;
        if (written < Buffer.byteLength(part)) {
          throw new Error(`Neovim took only ${written} of ${Buffer.byteLength(part)} bytes of keys; the rest were not typed`);
        }
        await taken();
      }
      const mode = await remote.request('nvim_get_mode', [], options) as { mode: string; blocking: boolean };
      if (mode.blocking) return result(`mode ${mode.mode} (waiting at a prompt: answer it with nvim_control_keys, often <CR> or <Esc>)`);
      return result(describe(mode.mode, await remote.lua(STATE, [], options) as State));
    }),
  });
}
