import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CdpSession } from "./cdp-session.mjs";
import { createInjectionController } from "./injection-controller.mjs";
import { createLogger, FATAL_MESSAGES } from "./logger.mjs";
import { buildDisplayText, mergeObservedUsage, parseResetCreditsPayload, parseUsagePayload } from "./usage-state.mjs";
import { UsageObserver } from "./usage-observer.mjs";
import {
  discoverCodexInstallation,
  findRunningCodexMainProcesses,
  isCdpEndpointAlive,
  launchCodex,
  reserveLoopbackPort,
  waitForCdpTarget,
} from "./windows-codex.mjs";

const STARTUP_TIMEOUT_MS = 15000;
const HEALTH_TIMEOUT_MS = 2000;
const NOT_MOUNTED = Object.freeze({ mounted: false, mode: null });

function nodeMajorOf(value) {
  const major = Number.parseInt(String(value).split(".")[0], 10);
  return Number.isInteger(major) ? major : 0;
}

function promiseForSocketOpen(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => settle(reject, new Error("CDP WebSocket 连接超时")), timeoutMs);
    const opened = () => settle(resolve, socket);
    const failed = () => settle(reject, new Error("CDP WebSocket 连接失败"));
    if (socket.addEventListener) {
      socket.addEventListener("open", opened, { once: true });
      socket.addEventListener("error", failed, { once: true });
      socket.addEventListener("close", failed, { once: true });
    } else if (socket.once) {
      socket.once("open", opened);
      socket.once("error", failed);
      socket.once("close", failed);
    } else {
      settle(reject, new Error("CDP WebSocket 不支持事件监听"));
    }
  });
}

async function connectGlobalWebSocket(url, { WebSocketImpl = globalThis.WebSocket, timeoutMs = STARTUP_TIMEOUT_MS } = {}) {
  if (typeof WebSocketImpl !== "function") throw new Error("Node.js WebSocket 不可用");
  const socket = new WebSocketImpl(url);
  try {
    return await promiseForSocketOpen(socket, timeoutMs);
  } catch (error) {
    try { socket.close?.(); } catch { /* 辅助连接清理不能影响 Codex。 */ }
    throw error;
  }
}

function noOp() {}

/**
 * Runs only the helper orchestration. All OS, process, and network boundaries
 * are injected so tests never operate a real Codex instance.
 */
export async function runLauncher(options = {}, deps = {}) {
  const runtime = {
    ...deps,
  };
  const startupTimeoutMs = options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
  const healthTimeoutMs = options.healthTimeoutMs ?? HEALTH_TIMEOUT_MS;
  let logger;
  let child = null;
  let port = null;
  let session = null;
  let controller = null;
  let observer = null;
  let currentSnapshot = null;
  let topFrameId = null;
  let childExited = false;
  let cdpAlive = true;
  let finished = false;
  let reinstalling = false;
  let recoveryQueue = Promise.resolve();
  let eventQueue = Promise.resolve();
  let finishPromise = null;
  let resolveCompletion;
  const completion = new Promise((resolve) => { resolveCompletion = resolve; });
  const registeredSignals = [];

  const safeInfo = async (event, metadata = {}) => {
    try { await logger?.info?.(event, metadata); } catch { /* 日志不可用不得影响官方应用。 */ }
  };
  const removeSignals = () => {
    for (const [signal, handler] of registeredSignals) runtime.signals?.off?.(signal, handler);
    registeredSignals.length = 0;
  };
  const finish = (exitCode) => {
    if (finishPromise) return finishPromise;
    finishPromise = (async () => {
      finished = true;
      removeSignals();
      try { await controller?.clear?.(); } catch { /* renderer 已离开时忽略。 */ }
      try { session?.close?.(); } catch { /* 仅关闭辅助 CDP 会话。 */ }
      await safeInfo("codex_session_ended");
      try { await logger?.close?.(); } catch { /* 日志关闭不能改变返回码。 */ }
      resolveCompletion(exitCode);
      return exitCode;
    })();
    return finishPromise;
  };
  const fatal = async (exitCode, message) => {
    try { await logger?.writeFatal?.(message); } catch { /* 仍返回受控状态码。 */ }
    return finish(exitCode);
  };
  const restoreRenderer = async () => {
    if (reinstalling || finished || !controller) return;
    reinstalling = true;
    try {
      await controller.clear();
      await controller.install();
      if (currentSnapshot) await controller.update(buildDisplayText(currentSnapshot));
    } finally {
      reinstalling = false;
    }
  };
  const dispatchEvent = (method, params) => {
    eventQueue = eventQueue.then(async () => {
      if (finished) return;
      await observer?.handleEvent?.(method, params);
      const topFrameNavigation = method === "Page.frameNavigated"
        && params?.frame
        && !Object.hasOwn(params.frame, "parentId");
      if (topFrameNavigation) topFrameId = params.frame.id ?? null;
      const defaultExecutionContext = method === "Runtime.executionContextCreated"
        && params?.context?.auxData?.isDefault === true
        && topFrameId !== null
        && params.context.auxData.frameId === topFrameId;
      if (topFrameNavigation || defaultExecutionContext) await restoreRenderer();
    }).catch(noOp);
    return eventQueue;
  };
  const handleUsagePayload = async (payload) => {
    const next = parseUsagePayload(payload);
    if (!next) {
      currentSnapshot = null;
      await controller?.clear?.();
      await safeInfo("usage_payload_missing_weekly_window");
      return;
    }
    const accountChanged = Boolean(
      currentSnapshot?.accountKey
      && next.accountKey
      && currentSnapshot.accountKey !== next.accountKey,
    );
    if (accountChanged) await controller?.clear?.();
    currentSnapshot = mergeObservedUsage(currentSnapshot, { type: "usage", value: next });
    const status = await controller?.update?.(buildDisplayText(currentSnapshot)) ?? NOT_MOUNTED;
    await safeInfo("usage_response_observed");
    if (status.mounted) await safeInfo("toolbar_injection_verified", { mounted: true, mode: status.mode ?? null });
  };
  const handleResetCreditsPayload = async (payload) => {
    const expiry = parseResetCreditsPayload(payload, Date.now());
    currentSnapshot = mergeObservedUsage(currentSnapshot, { type: "expiry", value: expiry });
    if (currentSnapshot) {
      const status = await controller?.update?.(buildDisplayText(currentSnapshot)) ?? NOT_MOUNTED;
      if (status.mounted) await safeInfo("toolbar_injection_verified", { mounted: true, mode: status.mode ?? null });
    }
    await safeInfo("reset_credits_response_observed");
  };
  const establishConnection = async () => {
    const target = await runtime.waitForCdpTarget(port, { timeoutMs: startupTimeoutMs });
    const socket = await runtime.connectWebSocket(target.webSocketDebuggerUrl, { timeoutMs: startupTimeoutMs });
    cdpAlive = true;
    session = runtime.sessionFactory(socket, {
      onEvent: dispatchEvent,
      onClose: () => {
        cdpAlive = false;
        scheduleRecovery();
      },
    });
    observer = runtime.observerFactory(session, {
      onUsagePayload: handleUsagePayload,
      onResetCreditsPayload: handleResetCreditsPayload,
      onError: noOp,
    });
    await observer.start();
    controller = runtime.injectionFactory(session, options.injectSource ?? "", { info: (event) => safeInfo(event) });
    const status = await controller.install();
    await safeInfo("cdp_connected");
    if (status?.mounted) await safeInfo("toolbar_injection_verified", { mounted: true, mode: status.mode ?? null });
  };
  const scheduleRecovery = () => {
    recoveryQueue = recoveryQueue.then(async () => {
      if (finished || port === null) return;
      const alive = await runtime.isCdpEndpointAlive(port, { timeoutMs: healthTimeoutMs });
      if (alive && !childExited && !cdpAlive) {
        try {
          await establishConnection();
          await safeInfo("renderer_reconnected");
        } catch {
          // 官方应用仍在运行，不能为辅助连接错误退出或干预它。
        }
      } else if (childExited && !alive) {
        await finish(0);
      }
    }).catch(noOp);
    return recoveryQueue;
  };
  const bindChildExit = () => {
    child?.once?.("exit", () => {
      childExited = true;
      scheduleRecovery();
    });
  };
  const bindSignals = () => {
    for (const signal of ["SIGINT", "SIGTERM"]) {
      const handler = () => { finish(0); };
      runtime.signals?.on?.(signal, handler);
      registeredSignals.push([signal, handler]);
    }
  };

  try {
    logger = await runtime.createLogger(options.logDir);
    await safeInfo("launcher_started");
    if (nodeMajorOf(runtime.nodeMajor) < 24) return fatal(3, FATAL_MESSAGES.node24NotFound);
    let installation;
    try {
      installation = await runtime.discoverCodexInstallation();
    } catch {
      return fatal(3, FATAL_MESSAGES.codexNotInstalled);
    }
    const existing = await runtime.findRunningCodexMainProcesses();
    if (existing.length > 0) return fatal(2, FATAL_MESSAGES.codexAlreadyRunning);
    port = await runtime.reserveLoopbackPort();
    child = runtime.launchCodex(installation.exePath, port);
    await safeInfo("codex_launched");
    try {
      await establishConnection();
    } catch {
      return fatal(4, FATAL_MESSAGES.cdpConnectionFailed);
    }
    bindChildExit();
    bindSignals();
    return completion;
  } catch {
    return finish(5);
  }
}

async function runCli() {
  const injectSource = await readFile(new URL("./inject.js", import.meta.url), "utf8");
  const logDir = path.join(process.env.LOCALAPPDATA || process.cwd(), "CodexUsageToolbar", "logs");
  return runLauncher({ injectSource, logDir }, {
    nodeMajor: nodeMajorOf(process.versions.node),
    createLogger,
    discoverCodexInstallation,
    findRunningCodexMainProcesses,
    reserveLoopbackPort,
    launchCodex,
    waitForCdpTarget,
    isCdpEndpointAlive,
    connectWebSocket: connectGlobalWebSocket,
    sessionFactory: (socket, callbacks) => new CdpSession(socket, callbacks),
    observerFactory: (session, callbacks) => new UsageObserver(session, callbacks),
    injectionFactory: createInjectionController,
    signals: process,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().then((exitCode) => { process.exitCode = exitCode; }).catch(() => { process.exitCode = 5; });
}
