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
const HEALTH_WINDOW_MS = 2000;
const RECOVERY_POLL_MS = 100;
const CLEANUP_TIMEOUT_MS = 500;
const NOT_MOUNTED = Object.freeze({ mounted: false, mode: null });

function nodeMajorOf(value) {
  const major = Number.parseInt(String(value).split(".")[0], 10);
  return Number.isInteger(major) ? major : 0;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function removeSocketListener(socket, event, listener) {
  if (socket.removeEventListener) socket.removeEventListener(event, listener);
  else if (socket.off) socket.off(event, listener);
  else socket.removeListener?.(event, listener);
}

function promiseForSocketOpen(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      removeSocketListener(socket, "open", opened);
      removeSocketListener(socket, "error", failed);
      removeSocketListener(socket, "close", failed);
    };
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
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
      return;
    }
    timer = setTimeout(() => settle(reject, new Error("CDP WebSocket 连接超时")), timeoutMs);
  });
}

export async function connectGlobalWebSocket(url, { WebSocketImpl = globalThis.WebSocket, timeoutMs = STARTUP_TIMEOUT_MS } = {}) {
  if (typeof WebSocketImpl !== "function") throw new Error("Node.js WebSocket 不可用");
  const socket = new WebSocketImpl(url);
  try {
    return await promiseForSocketOpen(socket, timeoutMs);
  } catch (error) {
    try { socket.close?.(); } catch { /* 仅清理辅助连接。 */ }
    throw error;
  }
}

function noOp() {}

function withinDeadline(factory, timeoutMs, onLateValue = noOp, cancelled = null) {
  let callerEnded = false;
  let lateHandled = false;
  let timer;
  const markCallerEnded = () => { callerEnded = true; };
  const handleLateValue = (value) => {
    if (!callerEnded || lateHandled) return;
    lateHandled = true;
    try { onLateValue(value); } catch { /* 迟到资源清理不得产生未处理拒绝。 */ }
  };
  const operation = Promise.resolve().then(factory);
  operation.then(handleLateValue, noOp);
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      markCallerEnded();
      reject(new Error("CDP 连接超时"));
    }, timeoutMs);
  });
  cancelled?.catch(markCallerEnded).catch(noOp);
  return Promise.race(cancelled ? [operation, deadline, cancelled] : [operation, deadline]).finally(() => clearTimeout(timer));
}

export async function runLauncher(options = {}, deps = {}) {
  const monotonicNow = globalThis.performance?.now?.bind(globalThis.performance) ?? Date.now;
  const runtime = { now: monotonicNow, sleep, ...deps };
  const startupTimeoutMs = options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
  const healthWindowMs = options.healthWindowMs ?? HEALTH_WINDOW_MS;
  const recoveryPollMs = options.recoveryPollMs ?? RECOVERY_POLL_MS;
  const cleanupTimeoutMs = options.cleanupTimeoutMs ?? CLEANUP_TIMEOUT_MS;
  let logger;
  let child = null;
  let port = null;
  let session = null;
  let controller = null;
  let observer = null;
  let currentSnapshot = null;
  let topFrameId = null;
  let awaitingTopContext = false;
  let childExited = false;
  let childExitedAt = null;
  let unavailableSince = null;
  let cdpAlive = false;
  let finished = false;
  let reinstalling = false;
  let nextGeneration = 0;
  let activeGeneration = 0;
  let cancelConnectionAttempt = noOp;
  let supervisorPromise = null;
  let eventQueue = Promise.resolve();
  let finishPromise = null;
  let resolveCompletion;
  const completion = new Promise((resolve) => { resolveCompletion = resolve; });
  const registeredSignals = [];

  const safeInfo = async (event, metadata = {}) => {
    try { await logger?.info?.(event, metadata); } catch { /* 日志故障不得影响 Codex。 */ }
  };
  const isActive = (generation) => !finished && generation === activeGeneration;
  const removeSignals = () => {
    for (const [signal, handler] of registeredSignals) runtime.signals?.off?.(signal, handler);
    registeredSignals.length = 0;
  };
  const boundedClear = async () => {
    let timer;
    const deadline = new Promise((resolve) => { timer = setTimeout(resolve, cleanupTimeoutMs); });
    try {
      await Promise.race([Promise.resolve().then(() => controller?.clear?.()), deadline]);
    } catch {
      // renderer 已离开或清理异常均不阻断会话关闭。
    } finally {
      clearTimeout(timer);
    }
  };
  const finish = (exitCode) => {
    if (finishPromise) return finishPromise;
    finishPromise = (async () => {
      finished = true;
      activeGeneration = ++nextGeneration;
      cancelConnectionAttempt();
      removeSignals();
      await boundedClear();
      try { session?.close?.(); } catch { /* 仅关闭辅助 CDP 会话。 */ }
      await safeInfo("codex_session_ended");
      try { await logger?.close?.(); } catch { /* 保持既定退出码。 */ }
      resolveCompletion(exitCode);
      return exitCode;
    })();
    return finishPromise;
  };
  const fatal = async (exitCode, message) => {
    try { await logger?.writeFatal?.(message); } catch { /* 仍使用受控退出码。 */ }
    return finish(exitCode);
  };
  const restoreRenderer = async (generation, clearFirst) => {
    if (!isActive(generation) || reinstalling || !controller) return;
    reinstalling = true;
    try {
      if (clearFirst) await controller.clear();
      if (!isActive(generation)) return;
      await controller.install();
      if (currentSnapshot && isActive(generation)) await controller.update(buildDisplayText(currentSnapshot));
    } finally {
      reinstalling = false;
    }
  };
  const handleUsagePayload = async (generation, payload) => {
    if (!isActive(generation)) return;
    const next = parseUsagePayload(payload);
    if (!next) {
      currentSnapshot = null;
      await controller?.clear?.();
      await safeInfo("usage_payload_missing_weekly_window");
      return;
    }
    const accountChanged = Boolean(currentSnapshot?.accountKey && next.accountKey && currentSnapshot.accountKey !== next.accountKey);
    if (accountChanged) await controller?.clear?.();
    if (!isActive(generation)) return;
    currentSnapshot = mergeObservedUsage(currentSnapshot, { type: "usage", value: next });
    const status = await controller?.update?.(buildDisplayText(currentSnapshot)) ?? NOT_MOUNTED;
    await safeInfo("usage_response_observed");
    if (status.mounted) await safeInfo("toolbar_injection_verified", { mounted: true, mode: status.mode ?? null });
  };
  const handleResetCreditsPayload = async (generation, payload) => {
    if (!isActive(generation)) return;
    currentSnapshot = mergeObservedUsage(currentSnapshot, { type: "expiry", value: parseResetCreditsPayload(payload, Date.now()) });
    if (currentSnapshot) {
      const status = await controller?.update?.(buildDisplayText(currentSnapshot)) ?? NOT_MOUNTED;
      if (status.mounted) await safeInfo("toolbar_injection_verified", { mounted: true, mode: status.mode ?? null });
    }
    await safeInfo("reset_credits_response_observed");
  };
  const dispatchEvent = (generation, localObserver, method, params) => {
    eventQueue = eventQueue.then(async () => {
      if (!isActive(generation)) return;
      await localObserver?.handleEvent?.(method, params);
      if (!isActive(generation)) return;
      const topNavigation = method === "Page.frameNavigated" && params?.frame && !Object.hasOwn(params.frame, "parentId");
      if (topNavigation) {
        topFrameId = params.frame.id ?? null;
        awaitingTopContext = true;
        await controller?.clear?.();
        return;
      }
      const frameId = params?.context?.auxData?.frameId;
      const isDefaultContext = method === "Runtime.executionContextCreated" && params?.context?.auxData?.isDefault === true;
      const topContext = isDefaultContext && (topFrameId === null || frameId === topFrameId);
      if (topContext) {
        const clearFirst = !awaitingTopContext;
        awaitingTopContext = false;
        await restoreRenderer(generation, clearFirst);
      }
    }).catch(noOp);
    return eventQueue;
  };

  async function establishConnection({ timeoutMs }) {
    cancelConnectionAttempt();
    const generation = ++nextGeneration;
    activeGeneration = generation;
    let rejectCancelled;
    const cancelled = new Promise((_, reject) => { rejectCancelled = reject; });
    const cancelThisAttempt = () => rejectCancelled(new Error("CDP 连接已取消"));
    cancelConnectionAttempt = cancelThisAttempt;
    let localSocket = null;
    let localSession = null;
    const canPublish = () => isActive(generation) && !childExited;
    const discardLocal = () => {
      if (session === localSession) {
        session = null;
        observer = null;
        controller = null;
      }
      if (!finished) {
        try { localSession?.close?.(); } catch { /* 局部会话清理。 */ }
        try { localSocket?.close?.(); } catch { /* 局部 socket 清理。 */ }
      }
    };
    try {
      const target = await withinDeadline(
        () => runtime.waitForCdpTarget(port, { timeoutMs }),
        timeoutMs,
        noOp,
        cancelled,
      );
      if (!canPublish()) return false;
      localSocket = await withinDeadline(
        () => runtime.connectWebSocket(target.webSocketDebuggerUrl, { timeoutMs }),
        timeoutMs,
        (socket) => { try { socket?.close?.(); } catch { /* 迟到 socket 清理。 */ } },
        cancelled,
      );
      if (!canPublish()) return false;
      let localObserver = null;
      localSession = runtime.sessionFactory(localSocket, {
        onEvent: (method, params) => dispatchEvent(generation, localObserver, method, params),
        onClose: () => {
          if (!isActive(generation)) return;
          cdpAlive = false;
          scheduleSupervisor();
        },
      });
      if (!canPublish()) return false;
      localObserver = runtime.observerFactory(localSession, {
        onUsagePayload: (payload) => handleUsagePayload(generation, payload),
        onResetCreditsPayload: (payload) => handleResetCreditsPayload(generation, payload),
        onError: noOp,
      });
      const localController = runtime.injectionFactory(localSession, options.injectSource ?? "", { info: (event) => safeInfo(event) });
      session = localSession;
      observer = localObserver;
      controller = localController;
      await localObserver.start();
      if (!canPublish()) return false;
      const status = await localController.install();
      if (!canPublish()) return false;
      cdpAlive = true;
      unavailableSince = null;
      if (currentSnapshot) await localController.update(buildDisplayText(currentSnapshot));
      await safeInfo("cdp_connected");
      if (status?.mounted) await safeInfo("toolbar_injection_verified", { mounted: true, mode: status.mode ?? null });
      return true;
    } catch (error) {
      if (isActive(generation)) {
        activeGeneration = ++nextGeneration;
        cdpAlive = false;
      }
      throw error;
    } finally {
      if (cancelConnectionAttempt === cancelThisAttempt) cancelConnectionAttempt = noOp;
      if (!canPublish()) discardLocal();
    }
  }

  function scheduleSupervisor() {
    if (supervisorPromise || finished || port === null || (!childExited && cdpAlive)) return;
    supervisorPromise = (async () => {
      while (!finished && (childExited || !cdpAlive)) {
        const observedAt = runtime.now();
        const baseline = childExited && unavailableSince !== null ? Math.max(childExitedAt, unavailableSince) : null;
        const remaining = baseline === null ? recoveryPollMs : Math.max(0, healthWindowMs - (observedAt - baseline));
        if (baseline !== null && remaining === 0) {
          await finish(0);
          break;
        }
        const cap = Math.min(recoveryPollMs, remaining);
        const timeoutMs = Math.max(1, cap - 1);
        let alive;
        try {
          alive = await runtime.isCdpEndpointAlive(port, { timeoutMs });
        } catch {
          try { await runtime.sleep(Math.min(recoveryPollMs, remaining)); } catch { await finish(5); }
          continue;
        }
        if (finished) break;
        const checkedAt = runtime.now();
        if (alive) {
          unavailableSince = null;
          if (!childExited && !cdpAlive) {
            try {
              if (await establishConnection({ timeoutMs })) await safeInfo("renderer_reconnected");
            } catch {
              cdpAlive = false;
            }
          }
        } else {
          if (unavailableSince === null) unavailableSince = checkedAt;
          const unavailableBaseline = Math.max(childExitedAt ?? unavailableSince, unavailableSince);
          if (childExited && checkedAt - unavailableBaseline >= healthWindowMs) {
            await finish(0);
            break;
          }
        }
        if (!finished && (childExited || !cdpAlive)) {
          const sleepMs = childExited && unavailableSince !== null
            ? Math.min(recoveryPollMs, Math.max(0, healthWindowMs - (runtime.now() - Math.max(childExitedAt, unavailableSince))))
            : recoveryPollMs;
          if (sleepMs === 0) {
            await finish(0);
            break;
          }
          try { await runtime.sleep(sleepMs); } catch { await finish(5); }
        }
      }
    })().catch(noOp).finally(() => {
      supervisorPromise = null;
      if (!finished && (childExited || !cdpAlive)) scheduleSupervisor();
    });
  }

  const bindChild = () => {
    child?.once?.("exit", () => {
      if (finished || childExited) return;
      childExited = true;
      childExitedAt = runtime.now();
      scheduleSupervisor();
    });
    child?.once?.("error", () => { finish(5); });
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
    try { installation = await runtime.discoverCodexInstallation(); } catch { return fatal(3, FATAL_MESSAGES.codexNotInstalled); }
    const existing = await runtime.findRunningCodexMainProcesses();
    if (existing.length > 0) return fatal(2, FATAL_MESSAGES.codexAlreadyRunning);
    port = await runtime.reserveLoopbackPort();
    child = runtime.launchCodex(installation.exePath, port);
    bindChild();
    bindSignals();
    await safeInfo("codex_launched");
    const startup = establishConnection({ timeoutMs: startupTimeoutMs });
    const startupResult = await Promise.race([
      startup.then((connected) => ({ connected })).catch(() => ({ connected: false })),
      completion.then((exitCode) => ({ exitCode })),
    ]);
    if (Object.hasOwn(startupResult, "exitCode")) return startupResult.exitCode;
    if (!startupResult.connected) return childExited ? completion : fatal(4, FATAL_MESSAGES.cdpConnectionFailed);
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
