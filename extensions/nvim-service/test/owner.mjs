// Stands in for Pi: owns a service, reports it, then ends the way the test asks.
import { launch } from '../service.mjs';

const [mode, init] = process.argv.slice(2);
const service = launch({ cwd: process.cwd(), init, graceMs: 100, killMs: 300 });
const report = info => process.stdout.write(JSON.stringify(info) + '\n');
if (mode === 'startup') {
  report(await service.spawned);
  setInterval(() => {}, 1000);
} else {
  report(await service.ready);
  if (mode === 'crash') throw new Error('owner crashed');
  if (mode === 'wait') setInterval(() => {}, 1000);
  // 'exit': nothing left to do; an idle service must not keep this process alive.
}
