import { Type } from '@earendil-works/pi-ai';
import { setTimeout as delay } from 'node:timers/promises';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { useRemote, type Remote } from '../nvim-remote/api.ts';

const OUTPUT_LIMIT = 16384;
const timeoutMs = Type.Optional(Type.Integer({ minimum: 100, maximum: 60000, description: 'Default 10000.' }));
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

function result(text: string) {
  const clipped = text.length > OUTPUT_LIMIT
    ? `${text.slice(0, OUTPUT_LIMIT)}\n[Truncated: ${OUTPUT_LIMIT} of ${text.length} characters shown. Ask for less.]` : text;
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

function describe(mode: string, s: State) {
  const file = s.file ? JSON.stringify(s.file) : '[No Name]';
  return `mode ${mode} | buffer ${s.buffer} ${file}${s.modified ? ' [+]' : ''}${s.terminal ? ' (your own terminal)' : ''} | ${s.line}:${s.column}`
    + (s.message ? ` | last message: ${s.message}` : '');
}

export default function (pi: ExtensionAPI) {
  // Outside Neovim there is no editor to control, and no tools to cost the model anything.
  if (!process.env.NVIM) return;
  const nvim = useRemote(pi);

  async function run<T>(ms: number | undefined, signal: AbortSignal | undefined, work: (remote: Remote, options: { timeout: number; signal?: AbortSignal }) => Promise<T>) {
    const remote = nvim();
    if (!remote) throw new Error('Not attached to the user\'s Neovim; /nvim-remote shows why, and /nvim-remote reconnect attaches again.');
    try { return await work(remote, { timeout: ms ?? 10000, signal }); }
    catch (error) {
      const blocking = (error as { blocking?: boolean }).blocking;
      throw blocking ? new Error(`${errorText(error)}. Answer it with editor_keys (often <CR> or <Esc>).`) : error;
    }
  }

  pi.registerTool({
    name: 'editor_lua',
    label: 'Editor Lua',
    promptSnippet: "Run Lua in the user's own Neovim, the editor Pi runs inside (their buffers, windows, plugins)",
    description: "Run Lua in the user's Neovim, the one Pi's terminal is in, and get its return value (strings as text, anything else as JSON). `...` receives args. `remote` is in scope: put what you set up (autocommands, highlights) in remote.group or remote.ns, or remove it in remote.on_detach(fn), so it goes when Pi does; remote.terminal is Pi's own terminal buffer.",
    promptGuidelines: [
      "editor_lua and editor_keys act on the user's real editor: their open buffers, unsaved changes included, their windows and their plugins. nvim_lua and nvim_keys are your private Neovim instead. Use the editor tools to show the user things or when asked to act in their editor; never quit Neovim, close or delete Pi's terminal (remote.terminal), discard unsaved changes, or write buffers the user is editing without being asked.",
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
    name: 'editor_keys',
    label: 'Editor keys',
    promptSnippet: "Type keys into the user's Neovim and see the resulting state",
    description: "Type keys into the focused window of the user's Neovim, as they would, in Neovim notation (<Esc>, <CR>, <C-w>, <lt> for a literal <). Returns mode, buffer, cursor and the last message. Empty keys just looks. Refused while the focused window is Pi's own terminal, where keys would be typed into Pi: focus another window with editor_lua first, or use editor_lua instead.",
    executionMode: 'sequential',
    parameters: Type.Object({
      keys: Type.String({ description: 'Keys to type; may be empty.' }),
      timeoutMs,
    }),
    execute: (_id, params, signal) => run(params.timeoutMs, signal, async (remote, options) => {
      const before = await remote.request('nvim_get_mode', [], options) as { mode: string; blocking: boolean };
      if (params.keys && !before.blocking) {
        const state = await remote.lua(STATE, [], options) as State;
        if (state.terminal) throw new Error("The focused window is Pi's own terminal, where these keys would be typed into Pi. Focus another window with editor_lua first, or use editor_lua.");
      }
      if (params.keys) await remote.request('nvim_input', [params.keys], options);
      // A busy editor (in Lua, a plugin's or a call's that timed out) still answers calls, but
      // takes in typed keys only when it is done: wait for them to be taken, or for a prompt.
      for (const end = Date.now() + options.timeout; params.keys;) {
        const waiting = await remote.lua('return vim.fn.getchar(1) ~= 0', [], options).catch(error => {
          if ((error as { blocking?: boolean }).blocking) return false; // The keys opened a prompt.
          throw error;
        });
        if (!waiting) break;
        if (Date.now() > end) throw new Error(`Neovim did not take in the keys within ${options.timeout} ms; it is busy`);
        await delay(20);
      }
      const mode = await remote.request('nvim_get_mode', [], options) as { mode: string; blocking: boolean };
      if (mode.blocking) return result(`mode ${mode.mode} (waiting at a prompt: answer it with editor_keys, often <CR> or <Esc>)`);
      return result(describe(mode.mode, await remote.lua(STATE, [], options) as State));
    }),
  });
}
