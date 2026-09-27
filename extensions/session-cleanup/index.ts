import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Cleaner } from "./core.mjs";

export default function sessionCleanup(pi: ExtensionAPI) {
  registerSessionCleanup(pi, new Cleaner(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent")));
}

export function registerSessionCleanup(pi: ExtensionAPI, cleaner: Cleaner) {
  let running: Promise<unknown> = Promise.resolve();
  const notify = (ctx: ExtensionContext, message: string, error = false) => {
    if (ctx.hasUI) ctx.ui.notify(message, error ? "warning" : "info");
  };
  const enqueue = (dryRun: boolean) => {
    const next = running.then(() => cleaner.run({ dryRun }));
    running = next.catch(() => {});
    return next;
  };

  // No polling, watchers, or scheduled retries. Cleanup is opportunistic only.
  pi.on("session_start", async (_event, ctx) => {
    await running;
    await cleaner.lease(ctx.sessionManager.getSessionFile());
    try {
      const report = await enqueue(false);
      if (report.errors.length) notify(ctx, `Session cleanup needs attention:\n${report.errors.join("\n")}`, true);
      if (report.expired.length || report.cleaned.length) notify(ctx, `Session cleanup: ${report.expired.length} expired, ${report.cleaned.length} metadata cleanups completed.`);
    } catch (error) {
      notify(ctx, `Session cleanup paused: ${error}`, true);
    }
  });
  pi.on("session_shutdown", async () => {
    await running;
    await cleaner.close();
  });
  pi.registerCommand("session-cleanup", {
    description: "Preview session cleanup, run it now, or show configuration: preview | run | config",
    handler: async (args, ctx) => {
      const action = args.trim() || "preview";
      if (action !== "preview" && action !== "run" && action !== "config") {
        notify(ctx, "Usage: /session-cleanup [preview|run|config]", true);
        return;
      }
      try {
        if (action === "config") notify(ctx, `${cleaner.configPath}\n${JSON.stringify(await cleaner.config(), null, 2)}`);
        else notify(ctx, JSON.stringify(await enqueue(action === "preview"), null, 2));
      } catch (error) { notify(ctx, `Session cleanup: ${error}`, true); }
    },
  });
}
