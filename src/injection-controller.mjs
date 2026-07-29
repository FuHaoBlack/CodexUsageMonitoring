const NOT_MOUNTED = Object.freeze({ mounted: false, mode: null });

function sanitizeText(value) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001F\u007F]/g, "").slice(0, 500) : "";
}

function logEvent(logger, event) {
  try {
    if (typeof logger === "function") logger(event);
    else logger?.info?.(event);
  } catch {
    // 日志失败不能影响 Codex。
  }
}

export function createInjectionController(session, injectSource, logger) {
  let latestDisplay = null;

  async function evaluate(expression) {
    const result = await session.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result?.exceptionDetails) throw new Error("CDP 页面执行失败");
    return result?.result?.value ?? NOT_MOUNTED;
  }

  async function install() {
    try {
      await session.send("Runtime.enable");
      await session.send("Page.enable");
      await evaluate(String(injectSource));
      if (latestDisplay) return update(latestDisplay);
      const result = await evaluate("globalThis.__codexUsageToolbarV1?.status?.() ?? {\"mounted\":false,\"mode\":null}");
      const status = result && typeof result === "object" ? result : NOT_MOUNTED;
      if (!status.mounted) logEvent(logger, "toolbar_anchor_not_found");
      return { mounted: Boolean(status.mounted), mode: status.mode ?? null };
    } catch {
      logEvent(logger, "toolbar_injection_unavailable");
      return NOT_MOUNTED;
    }
  }

  async function update(displayText) {
    const display = {
      fullText: sanitizeText(displayText?.fullText),
      compactText: sanitizeText(displayText?.compactText),
    };
    if (!display.fullText || !display.compactText) return NOT_MOUNTED;
    latestDisplay = display;
    try {
      const expression = `globalThis.__codexUsageToolbarV1?.update?.(${JSON.stringify(display)}) ?? {"mounted":false,"mode":null}`;
      const result = await evaluate(expression);
      const status = result && typeof result === "object" ? result : NOT_MOUNTED;
      if (!status.mounted) logEvent(logger, "toolbar_anchor_not_found");
      else logEvent(logger, "toolbar_injection_verified");
      return { mounted: Boolean(status.mounted), mode: status.mode ?? null };
    } catch {
      logEvent(logger, "toolbar_injection_unavailable");
      return NOT_MOUNTED;
    }
  }

  async function clear() {
    latestDisplay = null;
    try {
      await evaluate("globalThis.__codexUsageToolbarV1?.clear?.()");
    } catch {
      logEvent(logger, "toolbar_injection_unavailable");
    }
  }

  async function handleEvent(method) {
    if (method === "Runtime.executionContextCreated" || method === "Page.frameNavigated") {
      await install();
    }
  }

  return { install, update, clear, handleEvent };
}
