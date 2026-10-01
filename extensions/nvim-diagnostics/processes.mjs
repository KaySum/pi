import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const exec = promisify(execFile);

// Never search/kill by executable name. The caller must own this process group.
export async function liveGroup(pgid) {
  if (!Number.isInteger(pgid) || pgid <= 1) return [];
  const { stdout } = await exec("ps", ["-axo", "pid=,pgid=,stat="], {
    encoding: "utf8", timeout: 1000, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, LC_ALL: "C" },
  });
  return stdout.split("\n").flatMap((line) => {
    const [pid, group, state] = line.trim().split(/\s+/);
    // Zombies are already dead; only their OS parent can reap them.
    return Number(group) === pgid && state && !state.startsWith("Z") ? [Number(pid)] : [];
  });
}

export function signalGroup(pgid, signal) {
  if (!Number.isInteger(pgid) || pgid <= 1) throw new Error("Invalid owned process group");
  try { process.kill(-pgid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
}

export async function waitGroup(pgid, ms) {
  const deadline = Date.now() + ms;
  do {
    if (!(await liveGroup(pgid)).length) return true;
    if (Date.now() >= deadline) return false;
    await delay(40);
  } while (true);
}

export async function terminateGroup(pgid, { graceMs = 750, termMs = 500, killMs = 1500 } = {}) {
  if (!pgid) return { ok: true, escalated: null, remaining: [] };
  if (await waitGroup(pgid, graceMs)) return { ok: true, escalated: null, remaining: [] };
  signalGroup(pgid, "SIGTERM");
  if (await waitGroup(pgid, termMs)) return { ok: true, escalated: "SIGTERM", remaining: [] };
  signalGroup(pgid, "SIGKILL");
  await waitGroup(pgid, killMs);
  const remaining = await liveGroup(pgid);
  return { ok: remaining.length === 0, escalated: "SIGKILL", remaining };
}
