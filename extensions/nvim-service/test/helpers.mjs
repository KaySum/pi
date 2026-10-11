import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** True once Neovim, its supervisor and the socket directory are all gone; `ms` 0 checks once. */
export async function gone(info, ms = 4000) {
  for (const end = Date.now() + ms; ; await delay(25)) {
    if (!alive(info.pid) && !alive(info.supervisorPid) && !existsSync(dirname(info.socket))) return true;
    if (Date.now() >= end) return false;
  }
}
