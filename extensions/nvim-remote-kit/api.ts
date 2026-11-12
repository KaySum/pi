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
  const call = `if not remote.${name} then return false end
local fn = ...
return { true, remote.${name}[fn](select(2, ...)) }`;
  return (remote: Lua, fn: string, args: unknown[] = [], options?: CallOptions) =>
    installing(remote, call, [fn, ...args], source, options);
}

// Run `code`, which returns false if what it needs is not installed, else `{ true, result }`:
// apart from anything the result could be, so that the code runs once. If not, install `source`
// (the kit first) and run it again.
async function installing(remote: Lua, code: string, args: unknown[], source: string, options?: CallOptions): Promise<any> {
  let result = await remote.lua(code, args, options);
  if (result === false) {
    await install(remote, source, options);
    result = await remote.lua(code, args, options);
  }
  return result[1] ?? null;
}

/**
 * Run `code` as `remote.lua` does, with `kit` in scope: the kit installed first, the first time
 * it is needed in an attachment.
 */
export function withKit(remote: Lua, code: string, args: unknown[] = [], options?: CallOptions): Promise<any> {
  const wrapped = `if not remote.kit then return false end
local kit = remote.kit
return { true, (function(...)\n${code}\nend)(...) }`;
  return installing(remote, wrapped, args, '', options);
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
