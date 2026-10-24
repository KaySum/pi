import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { useRemote, type Remote } from './api.ts';

/** A bus and hooks, with nvim-remote answering `get` with `current`. */
function bus() {
  const events = new EventEmitter(), hooks = new EventEmitter();
  const state = { current: undefined as Remote | undefined, asked: 0 };
  events.on('nvim-remote:get', (request: { reply(handle?: Remote): void }) => { state.asked++; request.reply(state.current); });
  const pi = {
    events: { on: (channel: string, handler: (data: unknown) => void) => events.on(channel, handler), emit: (channel: string, data: unknown) => events.emit(channel, data) },
    on: (event: string, handler: () => void) => hooks.on(event, handler),
  } as unknown as ExtensionAPI;
  return { pi, state, emit: (channel: string, data?: unknown) => events.emit(channel, data), start: () => hooks.emit('session_start') };
}
const handle = (channel: number) => ({ channel, info: { channel } }) as unknown as Remote;

test('a handle announced later is adopted, once, and dropped when it stops', () => {
  const { pi, emit } = bus();
  const seen: Remote[] = [];
  const nvim = useRemote(pi, h => seen.push(h));
  assert.equal(nvim(), undefined);
  const a = handle(1);
  emit('nvim-remote:ready', a);
  emit('nvim-remote:ready', a); // The same one again is not new.
  assert.equal(nvim(), a);
  assert.deepEqual(seen, [a]);
  emit('nvim-remote:stopped', a.info);
  const b = handle(2);
  emit('nvim-remote:ready', b);
  assert.equal(nvim(), b);
  assert.deepEqual(seen, [a, b]);
});

test('a handle that exists already is found at session start, or when first asked for', () => {
  const early = bus();
  early.state.current = handle(3);
  const seen: Remote[] = [];
  const nvim = useRemote(early.pi, h => seen.push(h));
  early.start();
  assert.deepEqual(seen, [early.state.current]);
  assert.equal(nvim(), early.state.current);

  const lazy = bus();
  const later = useRemote(lazy.pi);
  assert.equal(later(), undefined);
  lazy.state.current = handle(4);
  assert.equal(later(), lazy.state.current); // Asked again, since it had none.
});

test('without nvim-remote, or outside Neovim, there is simply no handle', () => {
  const { pi, state } = bus();
  const nvim = useRemote(pi);
  assert.equal(nvim(), undefined);
  assert.equal(nvim(), undefined);
  assert.equal(state.asked, 2);
});
