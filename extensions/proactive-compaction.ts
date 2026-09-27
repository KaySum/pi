import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Policy = {
  enabled: boolean;
  compactAtContextRatio: number;
  compactAgainWhenBelowContextRatio: number;
  minContextTokens: number;
  customInstructions: string;
  notify: boolean;
};

const CONFIG_PATH = join(homedir(), ".pi", "agent", "proactive-compaction.json");
const DEFAULTS: Policy = {
  enabled: true,
  compactAtContextRatio: 0.5,
  compactAgainWhenBelowContextRatio: 0.4,
  minContextTokens: 20_000,
  customInstructions: "",
  notify: true,
};

function loadPolicy(): Policy {
  let raw: Partial<Policy>;
  try {
    raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<Policy>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULTS;
    throw new Error(`Cannot read ${CONFIG_PATH}: ${String(error)}`);
  }

  const policy = { ...DEFAULTS, ...raw };
  if (typeof policy.enabled !== "boolean") throw new Error("enabled must be a boolean");
  for (const key of ["compactAtContextRatio", "compactAgainWhenBelowContextRatio"] as const) {
    if (typeof policy[key] !== "number" || policy[key] < 0 || policy[key] > 1) {
      throw new Error(`${key} must be a number between 0 and 1`);
    }
  }
  if (policy.compactAgainWhenBelowContextRatio >= policy.compactAtContextRatio) {
    throw new Error("compactAgainWhenBelowContextRatio must be less than compactAtContextRatio");
  }
  if (!Number.isSafeInteger(policy.minContextTokens) || policy.minContextTokens < 0) {
    throw new Error("minContextTokens must be a non-negative integer");
  }
  if (typeof policy.customInstructions !== "string") {
    throw new Error("customInstructions must be a string");
  }
  if (typeof policy.notify !== "boolean") throw new Error("notify must be a boolean");
  return policy;
}

export default function (pi: ExtensionAPI) {
  let policy: Policy;
  try {
    policy = loadPolicy();
  } catch (error) {
    policy = DEFAULTS;
    console.error(`[proactive-compaction] ${String(error)}; using defaults`);
  }

  let armed = true;
  let compactionRequested = false;

  pi.on("session_start", () => {
    armed = true;
    compactionRequested = false;
  });

  pi.on("turn_end", (_event, ctx) => {
    if (!policy.enabled || compactionRequested) return;

    const usage = ctx.getContextUsage();
    if (!usage || usage.tokens === null || usage.contextWindow <= 0) return;

    const ratio = usage.tokens / usage.contextWindow;
    if (!armed) {
      if (ratio <= policy.compactAgainWhenBelowContextRatio) armed = true;
      else return;
    }
    if (ratio < policy.compactAtContextRatio || usage.tokens < policy.minContextTokens) return;

    armed = false;
    compactionRequested = true;
    if (policy.notify) {
      ctx.ui.notify(
        `Context is ${(ratio * 100).toFixed(0)}% full; compacting at ${(policy.compactAtContextRatio * 100).toFixed(0)}%.`,
        "info",
      );
    }
    ctx.compact({
      customInstructions: policy.customInstructions || undefined,
      onComplete: () => {
        compactionRequested = false;
      },
      onError: (error) => {
        compactionRequested = false;
        if (policy.notify) ctx.ui.notify(`Automatic compaction failed: ${error.message}`, "warning");
      },
    });
  });

  pi.registerCommand("proactive-compaction", {
    description: "Show or reload the automatic compaction policy",
    handler: async (args, ctx) => {
      if (args.trim() === "reload") {
        try {
          policy = loadPolicy();
          ctx.ui.notify("Reloaded automatic compaction policy.", "info");
        } catch (error) {
          ctx.ui.notify(String(error), "error");
        }
      } else if (args.trim()) {
        ctx.ui.notify("Usage: /proactive-compaction [reload]", "warning");
        return;
      }
      ctx.ui.notify(
        `Policy: ${policy.enabled ? "enabled" : "disabled"}; ` +
          `compactAtContextRatio=${policy.compactAtContextRatio}; ` +
          `compactAgainWhenBelowContextRatio=${policy.compactAgainWhenBelowContextRatio}; ` +
          `minContextTokens=${policy.minContextTokens}; ` +
          `notify=${policy.notify}. Config: ${CONFIG_PATH}`,
        "info",
      );
    },
  });
}
