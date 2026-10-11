import { createConnection } from 'node:net';
import { ExtensionCodec, decode, decodeMultiStream, encode } from '@msgpack/msgpack';

// Buffer, Window and Tabpage arrive as EXT types 0-2 wrapping an integer handle.
// Neovim accepts plain integers for them, so only decoding needs a codec.
const extensionCodec = new ExtensionCodec();
for (const type of [0, 1, 2]) extensionCodec.register({ type, encode: () => null, decode: data => decode(data) });

/** Bidirectional Msgpack-RPC with a Neovim listening on a Unix socket. */
export async function connectRpc(path, signal) {
  signal?.throwIfAborted();
  const socket = createConnection({ path });
  const pending = new Map();
  const handlers = new Map();
  const opened = Promise.withResolvers();
  let nextId = 0;
  let closed;

  function close(error = new Error('Neovim RPC connection closed')) {
    if (closed) return;
    closed = error;
    opened.reject(error);
    for (const finish of [...pending.values()]) finish(error);
    socket.destroy();
  }
  const send = message => { if (!closed) socket.write(encode(message)); };

  async function serve(id, method, args) {
    const handler = handlers.get(method)?.values().next().value;
    try {
      if (!handler) throw new Error(`No handler for ${method}`);
      send([1, id, null, await handler(...args) ?? null]);
    } catch (error) { send([1, id, error instanceof Error ? error.message : String(error), null]); }
  }

  socket.on('error', close);
  socket.on('close', () => close());
  socket.once('connect', () => { socket.unref(); opened.resolve(); });
  const abort = () => close(signal.reason);
  signal?.addEventListener('abort', abort, { once: true });

  void (async () => {
    try {
      for await (const message of decodeMultiStream(socket, { extensionCodec })) {
        if (!Array.isArray(message)) throw new Error('Invalid Neovim RPC message');
        const [type, a, b, c] = message;
        if (type === 1) {
          pending.get(a)?.(b == null ? undefined : new Error(Array.isArray(b) ? String(b[1]) : String(b)), c);
        } else if (type === 0) void serve(a, b, c);
        else if (type === 2) {
          // One failing subscriber must not take the connection down with it.
          for (const handler of handlers.get(a) ?? []) try { handler(...b); } catch { /* subscriber's problem */ }
        }
      }
      close();
    } catch (error) { close(error); }
  })();

  try { await opened.promise; }
  finally { signal?.removeEventListener('abort', abort); }

  return {
    get closed() { return Boolean(closed); },
    close: () => close(),
    notify: (method, args = []) => send([2, method, args]),
    /** Subscribe to a notification or serve a request from Neovim; returns an unsubscribe. */
    on(method, handler) {
      if (!handlers.has(method)) handlers.set(method, new Set());
      handlers.get(method).add(handler);
      return () => handlers.get(method)?.delete(handler);
    },
    request(method, args = [], requestSignal) {
      return new Promise((resolve, reject) => {
        requestSignal?.throwIfAborted();
        if (closed) throw closed;
        const id = ++nextId;
        const cancel = () => finish(requestSignal.reason);
        const finish = (error, result) => {
          if (!pending.delete(id)) return;
          requestSignal?.removeEventListener('abort', cancel);
          if (!pending.size) socket.unref();
          if (error) reject(error); else resolve(result);
        };
        pending.set(id, finish);
        requestSignal?.addEventListener('abort', cancel, { once: true });
        socket.ref();
        send([0, id, method, args]);
      });
    },
  };
}
