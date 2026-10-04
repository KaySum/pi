// Disposable stand-in for Pi. Tests kill this process, never the running agent.
import { launchNvimService } from '../service.mjs';

const options = JSON.parse(process.argv[2]);
const service = launchNvimService(options);
const keepAlive = options.mode === 'natural-exit' ? undefined : setInterval(() => {}, 60000);
const send = message => console.log(JSON.stringify(message));
service.spawned.then(info => send({ type: 'spawned', info })).catch(() => {});
service.ready.then(info => send({ type: 'ready', info })).catch(error => send({ type: 'error', message: error.message }));
service.exited.then(result => {
  send({ type: 'exited', error: result.error?.message });
  clearInterval(keepAlive);
  process.stdin.destroy();
});
if (options.mode !== 'natural-exit') {
  process.stdin.on('data', async data => {
    switch (data.toString().trim()) {
      case 'stop': await service.stop(); break;
      case 'exit': process.exit(0); break;
      case 'crash': throw new Error('Deliberate test-owner crash');
    }
  });
}
