import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { runLauncher } from "../src/launcher.mjs";

const files = [
  "../src/launcher.mjs",
  "../src/inject.js",
  "../src/injection-controller.mjs",
  "../src/usage-observer.mjs",
];

test("no source initiates a Wham request", async () => {
  const sources = await Promise.all(
    files.map((file) => readFile(new URL(file, import.meta.url), "utf8")),
  );

  for (const source of sources) {
    assert.doesNotMatch(source, /fetch\s*\(\s*[`"'][^`"']*\/wham\//);
    assert.doesNotMatch(source, /https\.request\s*\([^)]*\/wham\//);
    assert.doesNotMatch(source, /XMLHttpRequest/);
  }
});

test("renderer source contains no network primitive", async () => {
  const source = await readFile(new URL("../src/inject.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\bWebSocket\b/);
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /\bXMLHttpRequest\b/);
});

function usage(accountKey = "account-a", usedPercent = 34) {
  return {
    account_id: accountKey,
    rate_limit: {
      primary_window: {
        used_percent: usedPercent,
        limit_window_seconds: 604800,
        reset_at: 1785902940,
      },
    },
  };
}

function createHarness(overrides = {}) {
  const child = new EventEmitter();
  const sockets = [];
  const logs = [];
  const calls = { reserve: 0, launch: 0, clear: 0, updates: [], installs: 0 };
  const sessions = [];
  const controllers = [];
  const deps = {
    nodeMajor: 24,
    createLogger: async () => ({
      info: async (event, metadata = {}) => { logs.push({ event, metadata }); },
      writeFatal: async (message) => { logs.push({ fatal: message }); },
      close: async () => { calls.closed = (calls.closed ?? 0) + 1; },
    }),
    discoverCodexInstallation: async () => ({ exePath: "C:\\Codex.exe" }),
    findRunningCodexMainProcesses: async () => [],
    reserveLoopbackPort: async () => { calls.reserve += 1; return 4567; },
    launchCodex: () => { calls.launch += 1; return child; },
    waitForCdpTarget: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1:4567/page" }),
    isCdpEndpointAlive: async () => false,
    connectWebSocket: async () => {
      const socket = new EventEmitter();
      sockets.push(socket);
      return socket;
    },
    sessionFactory: (socket, hooks) => {
      const session = {
        send: async () => ({}),
        close: () => socket.emit("close"),
        emitEvent: (method, params) => hooks.onEvent(method, params),
      };
      socket.on("close", hooks.onClose);
      sessions.push(session);
      return session;
    },
    observerFactory: (_session, handlers) => {
      deps.observerFactory.lastHandlers = handlers;
      return { start: async () => {}, handleEvent: async () => {}, handlers };
    },
    injectionFactory: () => {
      const controller = {
        install: async () => { calls.installs += 1; return { mounted: true, mode: "full" }; },
        clear: async () => { calls.clear += 1; },
        update: async (value) => { calls.updates.push(value); return { mounted: true, mode: "full" }; },
      };
      controllers.push(controller);
      return controller;
    },
    signals: new EventEmitter(),
    ...overrides,
  };
  return { child, sockets, logs, calls, sessions, controllers, deps };
}

test("an existing Codex main process prevents port reservation and launch", async () => {
  const harness = createHarness({ findRunningCodexMainProcesses: async () => [{ pid: 1 }] });

  assert.equal(await runLauncher({}, harness.deps), 2);
  assert.equal(harness.calls.reserve, 0);
  assert.equal(harness.calls.launch, 0);
  assert.deepEqual(harness.logs, [
    { event: "launcher_started", metadata: {} },
    { fatal: "Codex 已在运行。请先正常关闭 Codex，再从“Codex（用量显示）”启动。" },
    { event: "codex_session_ended", metadata: {} },
  ]);
});

test("a CDP startup timeout leaves the launched child untouched", async () => {
  const harness = createHarness({ waitForCdpTarget: async () => { throw new Error("CDP 启动超时"); } });
  let touched = false;
  harness.child.on("newListener", (event) => { if (event === "kill") touched = true; });
  harness.child.kill = () => { touched = true; };

  assert.equal(await runLauncher({}, harness.deps), 4);
  assert.equal(harness.calls.launch, 1);
  assert.equal(touched, false);
  assert.equal(harness.child.listenerCount("exit"), 0);
});

test("invalid usage clears the injected toolbar instead of retaining stale text", async () => {
  const harness = createHarness();
  const running = runLauncher({}, harness.deps);
  await new Promise((resolve) => setImmediate(resolve));
  const handlers = harness.deps.observerFactory.lastHandlers;
  await handlers.onUsagePayload(usage());
  await handlers.onUsagePayload({ rate_limit: {} });
  harness.child.emit("exit");

  assert.equal(await running, 0);
  assert.equal(harness.calls.updates.length, 1);
  assert.equal(harness.calls.clear, 2);
  assert.ok(harness.logs.some((entry) => entry.event === "usage_payload_missing_weekly_window"));
});

test("an account key change clears before rendering the replacement snapshot", async () => {
  const harness = createHarness();
  const order = [];
  harness.deps.injectionFactory = () => ({
    install: async () => ({ mounted: true, mode: "full" }),
    clear: async () => { order.push("clear"); },
    update: async () => { order.push("update"); return { mounted: true, mode: "full" }; },
  });
  const originalObserverFactory = harness.deps.observerFactory;
  harness.deps.observerFactory = (session, handlers) => {
    harness.deps.observerFactory.lastHandlers = handlers;
    return originalObserverFactory(session, handlers);
  };
  const running = runLauncher({}, harness.deps);
  await new Promise((resolve) => setImmediate(resolve));
  await harness.deps.observerFactory.lastHandlers.onUsagePayload(usage("account-a"));
  await harness.deps.observerFactory.lastHandlers.onUsagePayload(usage("account-b"));
  harness.child.emit("exit");

  assert.equal(await running, 0);
  assert.deepEqual(order, ["update", "clear", "update", "clear"]);
});

test("a dead child with unavailable local CDP completes normally", async () => {
  const harness = createHarness({ isCdpEndpointAlive: async () => false });
  const running = runLauncher({}, harness.deps);
  await new Promise((resolve) => setImmediate(resolve));
  harness.child.emit("exit");

  assert.equal(await running, 0);
  assert.ok(harness.logs.some((entry) => entry.event === "codex_session_ended"));
});

test("a renderer socket close reconnects while the Codex child remains alive", async () => {
  let alive = true;
  const harness = createHarness({ isCdpEndpointAlive: async () => alive });
  const running = runLauncher({}, harness.deps);
  await new Promise((resolve) => setImmediate(resolve));
  harness.sockets[0].emit("close");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.sockets.length, 2);
  assert.ok(harness.logs.some((entry) => entry.event === "renderer_reconnected"));
  alive = false;
  harness.child.emit("exit");
  assert.equal(await running, 0);
});

test("top-frame recovery reinstalls once and ignores a child-frame execution context", async () => {
  const harness = createHarness();
  const running = runLauncher({}, harness.deps);
  await new Promise((resolve) => setImmediate(resolve));
  await harness.sessions[0].emitEvent("Page.frameNavigated", { frame: { id: "top" } });
  await new Promise((resolve) => setImmediate(resolve));
  const installsAfterTopNavigation = harness.calls.installs;
  await harness.sessions[0].emitEvent("Runtime.executionContextCreated", {
    context: { auxData: { isDefault: true, frameId: "child" } },
  });
  await new Promise((resolve) => setImmediate(resolve));
  harness.child.emit("exit");

  assert.equal(await running, 0);
  assert.equal(installsAfterTopNavigation, 2);
  assert.equal(harness.calls.installs, 2);
});

test("a termination signal cleans helper resources without killing Codex", async () => {
  const harness = createHarness();
  harness.child.kill = () => assert.fail("the launcher must not kill Codex");
  const running = runLauncher({}, harness.deps);
  await new Promise((resolve) => setImmediate(resolve));
  harness.deps.signals.emit("SIGTERM");

  assert.equal(await running, 0);
  assert.equal(harness.calls.closed, 1);
});
