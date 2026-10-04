import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { encode, decodeMultiStream } from '@msgpack/msgpack';
import { connectRpc } from './rpc.mjs';

async function fixture(t) {
  const dir = await mkdtemp('/tmp/pi-diag-rpc-');
  const path = join(dir, 'socket');
  const sockets = new Set();
  const server = createServer(socket => {
    sockets.add(socket); socket.on('error', () => {});
    void (async () => {
      try {
        for await (const [type, id, method, args] of decodeMultiStream(socket)) {
          if (type !== 0) continue;
          if (method === 'hang') continue;
          if (method === 'drop') { socket.destroy(); continue; }
          if (method === 'fail') { socket.write(encode([1, id, [0, 'bad expression'], null])); continue; }
          if (method === 'late') { setTimeout(() => { if (!socket.destroyed) socket.write(encode([1, id, null, 'late'])); }, 80); continue; }
          const bytes = encode([1, id, null, args]);
          // Fragment across UTF-8 and packet boundaries, interleave a notification.
          socket.write(encode([2, 'irrelevant', []]));
          for (let i = 0; i < bytes.length; i += 3) { socket.write(bytes.subarray(i, i + 3)); await delay(1); }
        }
      } catch { /* Expected when a test disconnects midway through a message. */ }
    })();
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const client = await connectRpc(path, AbortSignal.timeout(1000));
  t.after(() => client.close());
  return { client, path };
}

test('decodes fragmented Unicode responses, notifications, and error responses', async t => {
  const { client } = await fixture(t);
  const value = ['é雪', { text: 'quotes " and \\', array: [1, null, true] }];
  assert.deepEqual(await client.request('echo', value, AbortSignal.timeout(2000)), value);
  await assert.rejects(client.request('fail', [], AbortSignal.timeout(1000)), /bad expression/);
  assert.deepEqual(await client.request('echo', [123], AbortSignal.timeout(1000)), [123]);
});

test('cancellation ignores a late reply without poisoning subsequent requests', async t => {
  const { client } = await fixture(t);
  const controller = new AbortController();
  const promise = client.request('late', [], controller.signal);
  const rejected = assert.rejects(promise, { name: 'AbortError' });
  controller.abort(); await rejected;
  await delay(100);
  assert.deepEqual(await client.request('echo', ['still working'], AbortSignal.timeout(1000)), ['still working']);
});

test('disconnect rejects every pending request and close is idempotent', async t => {
  const { client } = await fixture(t);
  const first = assert.rejects(client.request('hang', [], AbortSignal.timeout(1000)), /closed/);
  const second = assert.rejects(client.request('drop', [], AbortSignal.timeout(1000)), /closed/);
  await Promise.all([first, second]);
  client.close(); client.close();
  await assert.rejects(client.request('echo', []), /closed/);
});

test('missing socket and already-aborted connect fail promptly', async () => {
  await assert.rejects(connectRpc('/no/such/pi-diagnostics.socket', AbortSignal.timeout(1000)), /ENOENT/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(connectRpc('/no/such/pi-diagnostics.socket', controller.signal), { name: 'AbortError' });
});
