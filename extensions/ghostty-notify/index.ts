import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const SOUND = '/System/Library/Sounds/Funk.aiff';
const DEFAULT_ALERT_VOLUME = 0.75;
const LUA = fileURLToPath(new URL('./notify.lua', import.meta.url));

export default function (pi: ExtensionAPI) {
  // /reload re-runs this in the same process; keeping the toggle on globalThis lets it survive that.
  const state = ((globalThis as Record<symbol, { enabled: boolean } | undefined>)[Symbol.for('ghostty-notify')] ??= { enabled: false });

  // Match macOS's alert volume (Sound settings), which is unset until first changed.
  async function playSound() {
    const { stdout } = await pi.exec('defaults', ['read', '-g', 'com.apple.sound.beep.volume']);
    const volume = parseFloat(stdout);
    await pi.exec('afplay', ['-v', String(Number.isFinite(volume) ? volume : DEFAULT_ALERT_VOLUME), SOUND]);
  }

  // agent_end can be followed by retries, compaction or queued work; agent_settled is the true end.
  pi.on('agent_settled', async (event, ctx) => {
    if (!state.enabled || event.aborted || !ctx.hasUI) return;
    // Posted by the terminal itself (OSC 777), so clicking it brings that terminal forward.
    const osc = `\x1b]777;notify;Pi;Done in ${basename(ctx.cwd)}\x07`;
    if (!process.env.NVIM) process.stdout.write(osc);
    else {
      // JSON is valid Vimscript here, escapes included.
      const args = JSON.stringify([LUA, { osc, pids: [process.pid, process.ppid] }]);
      pi.exec('nvim', ['--server', process.env.NVIM, '--remote-expr', `luaeval('dofile(_A[1])(_A[2])', ${args})`]).catch(() => {});
    }
    if (process.platform === 'darwin') playSound().catch(() => {});
  });

  pi.registerCommand('notify', {
    description: 'Toggle notifications when Pi is done, or set them with on/off',
    getArgumentCompletions: (prefix) => ['on', 'off'].filter((v) => v.startsWith(prefix)).map((v) => ({ value: v, label: v })),
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (arg && arg !== 'on' && arg !== 'off') return ctx.ui.notify('Usage: /notify [on|off]', 'warning');
      state.enabled = arg ? arg === 'on' : !state.enabled;
      ctx.ui.notify(`Notifications ${state.enabled ? 'on' : 'off'}`, 'info');
    },
  });
}
