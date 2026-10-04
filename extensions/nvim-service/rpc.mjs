import { createConnection } from 'node:net';
import { decodeMultiStream, encode } from '@msgpack/msgpack';

// Only a socket client. Never spawn Nvim or touch its lifetime-controlling stdio.
export async function connectRpc(path, signal) {
  signal?.throwIfAborted();
  const socket = createConnection({ path });
  const pending = new Map();
  let nextId = 0;
  let closed;
  let connected = false;
  const ready = Promise.withResolvers();
  ready.promise.catch(() => {});

  function close(error = new Error('Neovim RPC connection closed')) {
    if (closed) return;
    closed = error;
    ready.reject(error);
    for (const request of [...pending.values()]) request.finish(error);
    socket.destroy();
  }
  socket.on('error', close);
  socket.on('close', () => close());
  socket.once('connect', () => {
    connected = true;
    socket.unref();
    ready.resolve();
  });
  const abortConnect = () => close(signal.reason);
  signal?.addEventListener('abort', abortConnect, { once: true });

  void (async () => {
    try {
      for await (const message of decodeMultiStream(socket, {
        maxStrLength: 16 * 1024 * 1024,
        maxBinLength: 16 * 1024 * 1024,
        maxArrayLength: 100000,
        maxMapLength: 10000,
      })) {
        if (!Array.isArray(message)) throw new Error('Invalid Neovim RPC message');
        if (message[0] === 1) {
          const [, id, error, result] = message;
          pending.get(id)?.finish(error == null ? undefined : new Error(
            `Neovim RPC: ${Array.isArray(error) ? error.join(': ') : String(error)}`), result);
        } else if (message[0] === 0) {
          socket.write(encode([1, message[1], [0, 'Client does not accept RPC requests'], null]));
        } // Unsolicited notifications aren't tool output.
      }
      close();
    } catch (error) { close(error); }
  })();

  try { await ready.promise; }
  finally { signal?.removeEventListener('abort', abortConnect); }

  return {
    get closed() { return Boolean(closed); },
    close,
    notify(method, args) {
      if (!closed && connected) socket.write(encode([2, method, args]));
    },
    async request(method, args, requestSignal) {
      requestSignal?.throwIfAborted();
      if (closed) throw closed;
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const abort = () => finish(requestSignal.reason);
        const finish = (error, result) => {
          if (!pending.delete(id)) return;
          requestSignal?.removeEventListener('abort', abort);
          if (!pending.size) socket.unref();
          if (error) reject(error); else resolve(result);
        };
        pending.set(id, { finish });
        requestSignal?.addEventListener('abort', abort, { once: true });
        socket.ref();
        try { socket.write(encode([0, id, method, args])); }
        catch (error) { finish(error); }
      });
    },
  };
}
