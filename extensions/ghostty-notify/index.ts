import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const SOUND = '/System/Library/Sounds/Funk.aiff';
const LUA = fileURLToPath(new URL('./notify.lua', import.meta.url));

export default function (pi: ExtensionAPI) {
  let enabled = false;

  // agent_end can be followed by retries, compaction or queued work; agent_settled is the true end.
  pi.on('agent_settled', async (event, ctx) => {
    if (!enabled || event.aborted || !ctx.hasUI) return;
    // Posted by the terminal itself (OSC 777), so clicking it brings that terminal forward.
    const osc = `\x1b]777;notify;Pi;Done in ${basename(ctx.cwd)}\x07`;
    if (!process.env.NVIM) process.stdout.write(osc);
    else {
      // JSON is valid Vimscript here, escapes included.
      const args = JSON.stringify([LUA, { osc, pids: [process.pid, process.ppid] }]);
      pi.exec('nvim', ['--server', process.env.NVIM, '--remote-expr', `luaeval('dofile(_A[1])(_A[2])', ${args})`]).catch(() => {});
    }
    if (process.platform === 'darwin') pi.exec('afplay', [SOUND]).catch(() => {});
  });

  pi.registerCommand('notify', {
    description: 'Toggle notifications when Pi is done, or set them with on/off',
    getArgumentCompletions: (prefix) => ['on', 'off'].filter((v) => v.startsWith(prefix)).map((v) => ({ value: v, label: v })),
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (arg && arg !== 'on' && arg !== 'off') return ctx.ui.notify('Usage: /notify [on|off]', 'warning');
      enabled = arg ? arg === 'on' : !enabled;
      ctx.ui.notify(`Notifications ${enabled ? 'on' : 'off'}`, 'info');
    },
  });
}
