import { connectRpc } from './rpc.mjs';
import { createScreen, renderScreen } from './screen.mjs';

const STATE = `local b = vim.api.nvim_get_current_buf()
local p = vim.api.nvim_win_get_cursor(0)
return { buffer = b, file = vim.api.nvim_buf_get_name(b), line = p[1], column = p[2] + 1, modified = vim.bo[b].modified,
  cmdheight = vim.o.cmdheight }`;

/** A channel to the owned instance, refusing any other Neovim that answers on the socket. */
export async function connect(info, signal) {
  const rpc = await connectRpc(info.socket, signal);
  try {
    if (await rpc.request('nvim_call_function', ['getpid', []], signal) !== info.pid) {
      throw new Error('The socket does not belong to the Pi-owned Neovim');
    }
    const { id } = await rpc.request('nvim_get_chan_info', [0], signal);
    return Object.assign(rpc, { channel: id });
  } catch (error) { rpc.close(); throw error; }
}

/**
 * Everything a person at the editor can do, without changing this module: run Lua, call
 * any API method, type keys, read the screen, and receive events from Neovim.
 */
export async function openNvim(info, { width = 120, height = 40, signal } = {}) {
  const rpc = await connect(info, signal);
  const screen = createScreen();
  rpc.on('redraw', (...batches) => { screen.apply(batches); });
  try {
    // A UI makes this the editor a person would be looking at: popups, floating windows
    // and prompts are drawn, and can be read back as text.
    await rpc.request('nvim_ui_attach', [width, height, { ext_linegrid: true }], signal);
  } catch (error) { rpc.close(); throw error; }

  // nvim_get_mode answers only after typed keys are consumed, or at once when Neovim is
  // waiting at a prompt; in that state every other request would hang.
  const mode = signal => rpc.request('nvim_get_mode', [], signal);
  async function settle(signal) {
    const current = await mode(signal);
    // Redraw events precede the reply on the socket, so the model is current afterwards.
    if (!current.blocking) await rpc.request('nvim_command', ['redraw'], signal);
    return current;
  }
  async function unblocked(signal) {
    const current = await mode(signal);
    if (!current.blocking) return;
    throw Object.assign(new Error(`Neovim is waiting at a prompt (mode ${current.mode}); answer it with keys first`),
      { blocking: true, screen: renderScreen(screen.lines()) });
  }

  async function state({ signal } = {}) {
    const current = await settle(signal);
    const lines = screen.lines();
    // Hit-enter, more and confirm prompts: what matters is on screen, above the last row.
    const prompt = current.blocking || current.mode.startsWith('r');
    if (current.blocking) return { ...current, prompt, message: lines.findLast(line => line) ?? '' };
    const { cmdheight, ...editor } = await rpc.request('nvim_exec_lua', [STATE, []], signal);
    // With cmdheight=0 the last row is the statusline, not a message.
    const message = prompt ? lines.findLast(line => line) ?? '' : cmdheight ? lines.slice(-cmdheight).join('\n').trim() : '';
    return { ...current, prompt, ...editor, message };
  }

  return {
    channel: rpc.channel,
    on: rpc.on,
    close: rpc.close,
    get closed() { return rpc.closed; },
    /** A separate channel, for consumers that want their own notifications or lifetime. */
    connect: ({ signal } = {}) => connect(info, signal),
    async request(method, args = [], { signal } = {}) {
      await unblocked(signal);
      return rpc.request(method, args, signal);
    },
    async lua(code, args = [], { signal } = {}) {
      await unblocked(signal);
      return rpc.request('nvim_exec_lua', [code, args], signal);
    },
    /** Type keys in Neovim notation (`<Esc>`, `<CR>`, `<lt>` for a literal `<`). */
    async keys(keys, { signal } = {}) {
      await rpc.request('nvim_input', [keys], signal);
      return state({ signal });
    },
    state,
    async screen({ signal } = {}) {
      await settle(signal);
      return renderScreen(screen.lines());
    },
    resize: (columns, rows, { signal } = {}) => rpc.request('nvim_ui_try_resize', [columns, rows], signal),
  };
}

/** One line describing `state()`, for people and models. */
export function describeState(s) {
  if (s.blocking) return `mode ${s.mode} (blocked at a prompt) | ${s.message}`;
  const file = s.file ? JSON.stringify(s.file) : '[No Name]';
  return `mode ${s.mode} | buffer ${s.buffer} ${file}${s.modified ? ' [+]' : ''} | ${s.line}:${s.column}${s.message ? ` | ${s.message}` : ''}`;
}
