import { readFileSync } from 'node:fs';
import { connectRpc } from '../nvim-service/rpc.mjs';

const MODULE = readFileSync(new URL('./remote.lua', import.meta.url), 'utf8');
const ATTACH = `local source, channel, info = ...
return assert(loadstring(source, '@nvim-remote/remote.lua'))().attach(channel, info)`;

const DEFAULT_TIMEOUT = 10000;
// What answers a prompt, or only looks: everything else waits behind it.
const PROMPT_SAFE = new Set(['nvim_get_mode', 'nvim_input', 'nvim_input_mouse']);

export type CallOptions = {
  signal?: AbortSignal;
  /** Milliseconds to wait for the editor; default 10000, `Infinity` waits as long as it takes. */
  timeout?: number;
};

/** What an autocommand handler receives; `data` is left out when it cannot be sent. */
export type AutocmdEvent = { event: string; buf: number; file: string; match: string; id: number; data?: unknown };

type Rpc = Awaited<ReturnType<typeof connectRpc>>;
type Handler = (...args: any[]) => unknown;

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

function deadline({ signal, timeout = DEFAULT_TIMEOUT }: CallOptions) {
  const signals = signal ? [signal] : [];
  if (timeout !== Infinity) signals.push(AbortSignal.timeout(timeout));
  return { signal: signals.length ? AbortSignal.any(signals) : undefined, timeout };
}

async function within<T>(options: CallOptions, work: (signal?: AbortSignal) => Promise<T>): Promise<T> {
  const { signal, timeout } = deadline(options);
  try { return await work(signal); }
  catch (error) {
    if (signal?.aborted && !options.signal?.aborted) {
      throw new Error(`Neovim did not answer within ${timeout} ms; whatever was asked may still finish there`);
    }
    throw error;
  }
}

/** A raw channel of its own to the editor: no prompt check, no timeout, no cleanup. */
export async function connect(socket: string, { signal }: { signal?: AbortSignal } = {}): Promise<Rpc & { channel: number }> {
  const rpc = await connectRpc(socket, signal);
  try {
    const { id } = await rpc.request('nvim_get_chan_info', [0], signal) as { id: number };
    return Object.assign(rpc, { channel: id });
  } catch (error) { rpc.close(); throw error; }
}

/**
 * Attach to the Neovim at `socket` to control it. There is no UI attachment: one would
 * shrink the user's screen to its size. What Lua run through `lua` sets up with `remote`
 * is undone when this detaches, quits or crashes.
 */
export async function attach(socket: string, { pid = process.pid, cwd = process.cwd(), ...options }: { pid?: number; cwd?: string } & CallOptions = {}) {
  const rpc = await within(options, signal => connect(socket, { signal }));
  try {
    const { channel } = rpc;
    const nvimPid = await within(options, signal => rpc.request('nvim_call_function', ['getpid', []], signal)) as number;
    const { terminal } = await within(options, signal => rpc.request('nvim_exec_lua', [ATTACH, [MODULE, channel, { pid, cwd }]], signal)) as { terminal?: number };

    const autocmds = new Map<number, Handler>();
    let nextAutocmd = 0;
    rpc.on('nvim-remote:autocmd', (id: number, event: AutocmdEvent) => { autocmds.get(id)?.(event); });

    async function call(method: string, args: unknown[], options: CallOptions) {
      return within(options, async signal => {
        if (!PROMPT_SAFE.has(method)) {
          const { mode, blocking } = await rpc.request('nvim_get_mode', [], signal) as { mode: string; blocking: boolean };
          if (blocking) {
            throw Object.assign(new Error(`Neovim is waiting at a prompt (mode ${mode}); answer it with nvim_input first`), { blocking: true, mode });
          }
        }
        return rpc.request(method, args, signal);
      });
    }

    return {
      info: { socket, pid: nvimPid, channel, terminal },
      channel,
      get closed(): boolean { return rpc.closed; },
      /** Any Neovim API method. Fails at once, with `blocking: true`, while the editor waits at a prompt. */
      request: (method: string, args: unknown[] = [], options: CallOptions = {}): Promise<any> => call(method, args, options),
      /**
       * Run Lua: `code` is a function body receiving `args` as `...`, with `remote` in scope:
       * `remote.group` (an augroup) and `remote.ns` (a namespace) are cleared on detach,
       * `remote.on_detach(fn)` runs `fn` then, `remote.notify(name, ...)` reaches `on(name)`,
       * and `remote.terminal` is Pi's terminal buffer, if Pi runs in one of the editor's.
       */
      lua: (code: string, args: unknown[] = [], options: CallOptions = {}): Promise<any> =>
        call('nvim_exec_lua', ['return require("nvim_remote").run(...)', [channel, code, args]], options),
      /** Any Neovim API method, without waiting or checking for a prompt. */
      notify: (method: string, args: unknown[] = []) => rpc.notify(method, args),
      /** Receive `remote.notify(name, ...)`. Returns an unsubscribe. */
      on: (name: string, handler: Handler): (() => void) => rpc.on(name, handler),
      /** Run `handler` on an autocommand, in Pi; `options` as for nvim_create_autocmd. Resolves to an unsubscribe. */
      async autocmd(events: string | string[], handler: (event: AutocmdEvent) => void, autocmdOptions: Record<string, unknown> = {}, options: CallOptions = {}) {
        const id = ++nextAutocmd;
        autocmds.set(id, handler);
        try {
          const autocmd = await call('nvim_exec_lua', ['return require("nvim_remote").autocmd(...)', [channel, id, events, autocmdOptions]], options) as number;
          return async (options: CallOptions = {}) => {
            autocmds.delete(id);
            if (!rpc.closed) await call('nvim_exec_lua', ['pcall(vim.api.nvim_del_autocmd, ...)', [autocmd]], options);
          };
        } catch (error) { autocmds.delete(id); throw error; }
      },
      /** A separate raw channel, for what this one does not cover (a UI, say). The caller closes it. */
      connect: (options: { signal?: AbortSignal } = {}) => connect(socket, options),
      /** Called once the connection ends, by `close` or because the editor went away. Returns an unsubscribe. */
      onClose: (handler: (error: Error) => void): (() => void) => rpc.onClose(handler),
      /** Undo what this Pi set up in the editor, then disconnect. Resolves to the cleanups' errors. */
      async close(options: CallOptions = { timeout: 1000 }): Promise<string[]> {
        try { return await within(options, signal => rpc.request('nvim_exec_lua', ['return require("nvim_remote").detach(...)', [channel]], signal)) ?? []; }
        catch (error) { return rpc.closed ? [] : [errorText(error)]; } // Gone or stuck: the editor cleans up itself.
        finally { rpc.close(); }
      },
    };
  } catch (error) { rpc.close(); throw error; }
}

export type Remote = Awaited<ReturnType<typeof attach>>;
