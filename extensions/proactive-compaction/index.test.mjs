import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

// Isolate the extension's config without loading Pi or touching the real policy.
const home = mkdtempSync(join(tmpdir(), "proactive-compaction-test-"));
after(() => rmSync(home, { recursive: true, force: true }));
const configDir = join(home, ".pi", "agent");
mkdirSync(configDir, { recursive: true });
const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const javascript = stripTypeScriptTypes(source);
const homeKey = process.platform === "win32" ? "USERPROFILE" : "HOME";
const originalHome = process.env[homeKey];
let register;
try {
  process.env[homeKey] = home;
  ({ default: register } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`));
} finally {
  if (originalHome === undefined) delete process.env[homeKey];
  else process.env[homeKey] = originalHome;
}

function setup(policy = {}) {
  writeFileSync(join(configDir, "proactive-compaction.json"), JSON.stringify(policy));
  const handlers = new Map();
  const requests = [];
  const notifications = [];
  const state = { idle: true, usage: { tokens: 60_000, contextWindow: 100_000 } };
  const ctx = {
    isIdle: () => state.idle,
    getContextUsage: () => state.usage,
    compact: options => requests.push(options),
    ui: { notify: (message, level) => notifications.push({ message, level }) },
  };
  register({
    on: (name, handler) => handlers.set(name, handler),
    registerCommand: () => {},
  });
  const emit = (name, event = {}) => handlers.get(name)?.({ type: name, ...event }, ctx);
  const input = (event = {}) => emit("input", { text: "Next request", source: "interactive", ...event });
  return { ctx, state, requests, notifications, emit, input };
}

test("waits for the next idle user message, then waits for compaction before continuing", async () => {
  const h = setup();
  h.state.idle = false;
  for (let i = 0; i < 3; i++) {
    await h.emit("turn_end");
    h.state.usage.tokens += 5_000;
  }
  await h.emit("agent_end");
  h.state.idle = true;
  await h.emit("agent_settled");
  assert.equal(h.requests.length, 0);
  assert.equal(h.notifications.length, 0);

  let continued = false;
  const pending = h.input().then(result => {
    continued = true;
    return result;
  });
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].customInstructions, undefined);
  await Promise.resolve();
  assert.equal(continued, false);
  h.requests[0].onComplete({});
  assert.deepEqual(await pending, { action: "continue" });
  assert.equal(continued, true);
});

test("RPC user input can compact an already-over-threshold resumed session", async () => {
  const h = setup();
  await h.emit("session_start");
  const pending = h.input({ source: "rpc" });
  assert.equal(h.requests.length, 1);
  h.requests[0].onComplete({});
  assert.deepEqual(await pending, { action: "continue" });
});

test("extension messages and busy, steering, or follow-up input do not compact", async () => {
  const h = setup();
  assert.deepEqual(await h.input({ source: "extension" }), { action: "continue" });
  for (const streamingBehavior of ["steer", "followUp"]) {
    // Even if the run becomes idle before the handler, this was streaming input.
    assert.deepEqual(await h.input({ streamingBehavior }), { action: "continue" });
  }
  h.state.idle = false;
  assert.deepEqual(await h.input(), { action: "continue" });
  assert.equal(h.requests.length, 0);
  h.state.idle = true;
  const pending = h.input();
  assert.equal(h.requests.length, 1);
  h.requests[0].onComplete({});
  await pending;
});

for (const [name, policy, usage] of [
  ["disabled policy", { enabled: false }, { tokens: 60_000, contextWindow: 100_000 }],
  ["below ratio", {}, { tokens: 49_999, contextWindow: 100_000 }],
  ["below minimum tokens", {}, { tokens: 19_999, contextWindow: 30_000 }],
  ["missing usage", {}, undefined],
  ["unknown tokens", {}, { tokens: null, contextWindow: 100_000 }],
  ["invalid context window", {}, { tokens: 60_000, contextWindow: 0 }],
]) {
  test(`does not compact with ${name}`, async () => {
    const h = setup(policy);
    h.state.usage = usage;
    assert.deepEqual(await h.input(), { action: "continue" });
    assert.equal(h.requests.length, 0);
  });
}

test("includes the exact thresholds and preserves custom instructions and notify policy", async () => {
  const h = setup({ customInstructions: "Preserve decisions", notify: false });
  h.state.usage = { tokens: 20_000, contextWindow: 40_000 };
  const pending = h.input();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].customInstructions, "Preserve decisions");
  h.requests[0].onError(new Error("Unavailable"));
  assert.deepEqual(await pending, { action: "continue" });
  assert.deepEqual(h.notifications, []);
});

test("rearms at the low-water mark during work without compacting mid-operation", async () => {
  const h = setup();
  const first = h.input();
  h.requests[0].onComplete({});
  await first;
  h.state.usage.tokens = 45_000;
  await h.emit("turn_end");
  h.state.usage.tokens = 60_000;
  await h.input();
  assert.equal(h.requests.length, 1, "stays disarmed until usage reaches the low-water mark");

  h.state.idle = false;
  h.state.usage.tokens = 40_000;
  await h.emit("turn_end");
  h.state.usage.tokens = 60_000;
  await h.emit("turn_end");
  assert.equal(h.requests.length, 1);
  h.state.idle = true;
  const second = h.input();
  assert.equal(h.requests.length, 2);
  h.requests[1].onComplete({});
  await second;
});

test("failure warns but releases the original input and clears the in-flight guard", async () => {
  const h = setup();
  const first = h.input();
  await h.emit("turn_end");
  assert.equal(h.requests.length, 1);
  h.requests[0].onError(new Error("Provider unavailable"));
  assert.deepEqual(await first, { action: "continue" });
  assert.deepEqual(h.notifications.at(-1), {
    message: "Automatic compaction failed: Provider unavailable",
    level: "warning",
  });

  h.state.usage.tokens = 40_000;
  await h.input();
  h.state.usage.tokens = 60_000;
  const second = h.input();
  assert.equal(h.requests.length, 2);
  h.requests[1].onComplete({});
  await second;
});

test("synchronous compaction errors also release the input and clear the guard", async () => {
  const h = setup();
  const compact = h.ctx.compact;
  h.ctx.compact = () => { throw new Error("Cannot compact"); };
  assert.deepEqual(await h.input(), { action: "continue" });
  assert.equal(h.notifications.at(-1).level, "warning");
  h.ctx.compact = compact;
  h.state.usage.tokens = 40_000;
  await h.emit("turn_end");
  h.state.usage.tokens = 60_000;
  const pending = h.input();
  assert.equal(h.requests.length, 1);
  h.requests[0].onComplete({});
  await pending;
});

test("a new session resets the high-water guard without compacting on session start", async () => {
  const h = setup();
  const first = h.input();
  h.requests[0].onComplete({});
  await first;
  await h.emit("session_start");
  assert.equal(h.requests.length, 1);
  const second = h.input();
  assert.equal(h.requests.length, 2);
  h.requests[1].onComplete({});
  await second;
});
