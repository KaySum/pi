import { Type } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { launch } from './service.mjs';
import { openNvim, describeState } from './nvim.mjs';

type Service = ReturnType<typeof launch>;
type Info = Awaited<Service['ready']>;
type Handle = Awaited<ReturnType<typeof openNvim>> & { apiVersion: 1; info: Info; restart(): Promise<Handle> };

const OUTPUT_LIMIT = 16384;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const timeoutMs = Type.Optional(Type.Integer({ minimum: 100, maximum: 60000, description: 'Default 10000.' }));

function result(text: string) {
  const clipped = text.length > OUTPUT_LIMIT
    ? `${text.slice(0, OUTPUT_LIMIT)}\n[Truncated: ${OUTPUT_LIMIT} of ${text.length} characters shown. Ask for less.]` : text;
  return { content: [{ type: 'text' as const, text: clipped }], details: {} };
}

export default function (pi: ExtensionAPI) {
  let service: Service | undefined;
  let handle: Handle | undefined;
  let starting: Promise<void> | undefined;
  let context: ExtensionContext | undefined;
  let lastError: string | undefined;

  function warn(message: string) {
    if (context?.hasUI) context.ui.notify(message, 'warning');
    else console.error(message);
  }

  function unpublish() {
    if (!handle) return;
    const previous = handle;
    handle = undefined;
    previous.close();
    if (process.env.PI_NVIM_SOCKET === previous.info.socket) delete process.env.PI_NVIM_SOCKET;
    pi.events.emit('nvim-service:stopped', previous.info);
  }

  async function start(cwd: string) {
    lastError = undefined;
    // A Pi started from inside another Pi must not advertise its parent's socket.
    delete process.env.PI_NVIM_SOCKET;
    const current = launch({ cwd });
    service = current;
    void current.exited.then(({ error }) => {
      if (service !== current) return; // Stopped on purpose, or startup already reported it.
      service = undefined;
      unpublish();
      lastError = error?.message ?? 'Neovim exited';
      warn(`nvim-service: ${lastError}. Run /nvim-service restart.`);
    });
    try {
      const info = await current.ready;
      const nvim = await openNvim(info);
      if (service !== current) return nvim.close(); // Shutdown raced startup.
      handle = Object.assign(nvim, { apiVersion: 1 as const, info, restart });
      process.env.PI_NVIM_SOCKET = info.socket;
      pi.events.emit('nvim-service:ready', handle);
    } catch (error) {
      if (service !== current) return;
      service = undefined;
      lastError = errorText(error);
      warn(`nvim-service: ${lastError}`);
      await current.stop().catch(() => {});
    }
  }

  async function stop() {
    const current = service;
    service = undefined;
    unpublish();
    await current?.stop();
  }

  async function restart(): Promise<Handle> {
    if (!context) throw new Error('No active Pi session');
    const cwd = context.cwd;
    // A supervisor that outlives its 5 s bound is still enforcing the kill; move on.
    starting = stop().catch(() => {}).then(() => start(cwd));
    await starting;
    if (!handle) throw new Error(`Neovim failed to start: ${lastError}`);
    return handle;
  }

  async function run<T>(ms: number | undefined, signal: AbortSignal | undefined, work: (nvim: Handle, signal: AbortSignal) => Promise<T>) {
    await starting;
    if (!handle) throw new Error(`Neovim is not running${lastError ? `: ${lastError}` : ''}. Use nvim_restart.`);
    const limit = ms ?? 10000;
    const timeout = AbortSignal.timeout(limit);
    try { return await work(handle, signal ? AbortSignal.any([signal, timeout]) : timeout); }
    catch (error) {
      if (timeout.aborted && !signal?.aborted) {
        throw new Error(`Neovim did not answer within ${limit} ms. It is busy or hung; nvim_restart replaces it.`);
      }
      const screen = (error as { screen?: string }).screen;
      throw screen ? new Error(`${errorText(error)}\n${screen}`) : error;
    }
  }

  // Extensions loaded before this one ask; those loaded after hear :ready.
  pi.events.on('nvim-service:get', request => {
    (request as { reply?: (handle?: Handle) => void })?.reply?.(handle);
  });

  pi.on('session_start', (_event, ctx) => {
    context = ctx;
    if (service) return; // /new and session switches reuse the instance.
    // Not awaited: Pi's startup should not wait for the editor's plugins to load.
    starting = start(ctx.cwd);
  });

  pi.on('session_shutdown', async () => {
    try { await stop(); }
    finally { context = undefined; }
  });

  pi.registerCommand('nvim-service', {
    description: 'Show the Pi-owned Neovim (PIDs, socket, working directory); "restart" replaces it',
    handler: async (args, ctx) => {
      context = ctx;
      if (args.trim() === 'restart') await restart().catch(() => {});
      else await starting;
      ctx.ui.notify(handle
        ? `Neovim PID ${handle.info.pid}\nSupervisor PID ${handle.info.supervisorPid}\nSocket: ${handle.info.socket}\nWorking directory: ${handle.info.cwd}`
        : `Neovim service is not running${lastError ? `: ${lastError}` : ''}. Run /nvim-service restart.`,
      handle ? 'info' : 'warning');
    },
  });

  pi.registerTool({
    name: 'nvim_lua',
    label: 'Neovim Lua',
    promptSnippet: 'Run Lua in your own Neovim to query or drive it (buffers, LSP, plugins, Ex commands)',
    description: 'Run Lua in your own Neovim and get its return value (strings as text, anything else as JSON). `...` receives args. Reaches everything: buffers, windows, options, LSP, diagnostics, plugins, and Ex commands through vim.cmd.',
    promptGuidelines: [
      'You own a private Neovim with the user\'s configuration, plugins and LSP servers; it is not the user\'s editor and does not see their unsaved buffers. Prefer nvim_lua and return only the data you need. Use nvim_keys for interactive flows and to answer prompts. Files it writes are real.',
    ],
    executionMode: 'sequential',
    parameters: Type.Object({
      code: Type.String({ minLength: 1, description: 'Lua chunk; use `return` for output.' }),
      args: Type.Optional(Type.Array(Type.Any(), { description: 'Passed to the chunk as `...`.' })),
      timeoutMs,
    }),
    execute: (_id, params, signal) => run(params.timeoutMs, signal, async (nvim, signal) => {
      const value = await nvim.lua(params.code, params.args ?? [], { signal });
      return result(typeof value === 'string' ? value : JSON.stringify(value ?? null));
    }),
  });

  pi.registerTool({
    name: 'nvim_keys',
    label: 'Neovim keys',
    promptSnippet: 'Type keys into your Neovim and see the resulting state or screen',
    description: 'Type keys into your Neovim as a person would, in Neovim notation (<Esc>, <CR>, <C-w>, <lt> for a literal <). Returns mode, buffer, cursor and the message line. The rendered screen is added when screen is true, and always at a prompt. Empty keys just looks.',
    executionMode: 'sequential',
    parameters: Type.Object({
      keys: Type.String({ description: 'Keys to type; may be empty.' }),
      screen: Type.Optional(Type.Boolean({ description: 'Also return the screen text. Default false.' })),
      timeoutMs,
    }),
    execute: (_id, params, signal) => run(params.timeoutMs, signal, async (nvim, signal) => {
      const state = params.keys ? await nvim.keys(params.keys, { signal }) : await nvim.state({ signal });
      const lines = [describeState(state)];
      if (params.screen || state.prompt) lines.push(await nvim.screen({ signal }));
      return result(lines.join('\n'));
    }),
  });

  pi.registerTool({
    name: 'nvim_restart',
    label: 'Restart Neovim',
    promptSnippet: 'Replace your Neovim when it is hung or broken',
    description: 'Replace your Neovim with a fresh instance when it is hung or broken. Unsaved buffers and editor state are lost.',
    executionMode: 'sequential',
    parameters: Type.Object({}),
    async execute() {
      const { info } = await restart();
      return result(`Neovim restarted: PID ${info.pid}, socket ${info.socket}`);
    },
  });
}
