import { readFileSync } from 'node:fs';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { CallOptions, Remote } from '../nvim-remote/api.ts';

type Lua = Pick<Remote, 'lua'>;

/** kit.lua: installs `remote.kit` in an attachment, once; sent again, it does nothing. */
export const KIT = readFileSync(new URL('./kit.lua', import.meta.url), 'utf8');

/**
 * Install a module of Lua (`source`, run with `remote` in scope) in the attachment of `remote`,
 * the kit first, which it may use: in one call, as the kit's own `return` is kept to its part.
 */
export const install = (remote: Lua, source: string, options?: CallOptions) =>
  remote.lua(`(function(...)\n${KIT}\nend)(...)\n${source}`, [], options);

/**
 * Call into the module `source` installs as `remote[name]`: `call(remote, fn, args)` runs
 * `remote[name][fn](...args)`, installing the module (and the kit) the first time it is needed
 * in an attachment.
 */
export function module(name: string, source: string) {
  const call = `if not remote.${name} then return 'not installed' end
local fn = ...
return remote.${name}[fn](select(2, ...))`;
  return async (remote: Lua, fn: string, args: unknown[] = [], options?: CallOptions): Promise<any> => {
    const result = await remote.lua(call, [fn, ...args], options);
    if (result !== 'not installed') return result;
    await install(remote, source, options);
    return remote.lua(call, [fn, ...args], options);
  };
}

/**
 * Run `code` as `remote.lua` does, with `kit` in scope: the kit installed first, the first time
 * it is needed in an attachment.
 */
export async function withKit(remote: Lua, code: string, args: unknown[] = [], options?: CallOptions): Promise<any> {
  const wrapped = `if not remote.kit then return 'not installed' end
local kit = remote.kit
return (function(...)\n${code}\nend)(...)`;
  const result = await remote.lua(wrapped, args, options);
  if (result !== 'not installed') return result;
  await install(remote, '', options);
  return remote.lua(wrapped, args, options);
}

/** One of what `make` makes for each attachment, made the first time it is asked for. */
export function perAttachment<T>(make: (remote: Remote) => T) {
  const made = new WeakMap<Remote, T>();
  return (remote: Remote): T => {
    if (!made.has(remote)) made.set(remote, make(remote));
    return made.get(remote)!;
  };
}

/** The mode the user is busy in, if `error` is nvim-remote refusing a call while Neovim waits at a prompt. */
export const blocked = (error: unknown): string | undefined =>
  (error as { blocking?: boolean })?.blocking ? (error as { mode: string }).mode : undefined;

/** An error's first line, without Lua's "Lua: ": what to show the user. */
export const errorText = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).split('\n')[0].replace(/^Lua: /, '');

/** Pi's working directory, which its tools' paths are relative to: as of the session's start. */
export function useCwd(pi: ExtensionAPI) {
  let cwd = process.cwd();
  pi.on('session_start', (_event, ctx) => { cwd = ctx.cwd; });
  return () => cwd;
}
