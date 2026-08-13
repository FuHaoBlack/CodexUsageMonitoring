const ALLOWED_HOST = "chatgpt.com";
const USAGE_PATH = "/backend-api/wham/usage";
const RESET_CREDITS_PATH = "/backend-api/wham/rate-limit-reset-credits";
const NATIVE_BINDING_NAME = "codexUsageObserverV1";

const NATIVE_BRIDGE_SOURCE = `(() => {
  const marker = "__codexUsageObserverV1Installed";
  if (globalThis[marker]) return true;
  const binding = globalThis[${JSON.stringify(NATIVE_BINDING_NAME)}];
  if (typeof binding !== "function") return false;
  const endpointFor = (value) => {
    try {
      const parsed = new URL(value, "https://chatgpt.com");
      if (parsed.protocol !== "https:" || parsed.hostname !== "chatgpt.com") return null;
      const pathname = parsed.pathname.replace(/\\/+$/, "");
      if (pathname === "/wham/usage" || pathname === "/backend-api/wham/usage") return "usage";
      if (pathname === "/wham/rate-limit-reset-credits" || pathname === "/backend-api/wham/rate-limit-reset-credits") return "resetCredits";
    } catch {}
    return null;
  };
  const pending = new Set();
  const emit = (value) => {
    try { binding(JSON.stringify(value)); } catch {}
  };
  window.addEventListener("codex-message-from-view", (event) => {
    const data = event?.detail;
    if (data?.type !== "fetch" || data?.method !== "GET" || typeof data?.requestId !== "string" || typeof data?.url !== "string") return;
    const endpoint = endpointFor(data.url);
    if (!endpoint) return;
    pending.add(data.requestId);
    emit({ kind: "request", requestId: data.requestId, method: data.method, url: data.url, endpoint });
  });
  window.addEventListener("message", (event) => {
    const data = event?.data;
    if (data?.type !== "fetch-response" || typeof data?.requestId !== "string" || !pending.has(data.requestId)) return;
    pending.delete(data.requestId);
    emit({
      kind: "response",
      requestId: data.requestId,
      responseType: data.responseType,
      status: data.status,
      bodyJsonString: typeof data.bodyJsonString === "string" ? data.bodyJsonString : "",
    });
  });
  globalThis[marker] = true;
  return true;
})()`;

function endpointFor(url) {
  try {
    const parsed = new URL(url, "https://chatgpt.com");
    if (parsed.protocol !== "https:" || parsed.hostname !== ALLOWED_HOST) return null;
    const pathname = parsed.pathname.replace(/\/+$/, "");
    if (pathname === USAGE_PATH || pathname === "/wham/usage") return "usage";
    if (pathname === RESET_CREDITS_PATH || pathname === "/wham/rate-limit-reset-credits") return "resetCredits";
  } catch {
    return null;
  }
  return null;
}

function endpointForNativeRequest(event) {
  const endpointFromUrl = endpointFor(event?.url);
  const endpointMarker = event?.endpoint;
  if (
    (endpointMarker === "usage" || endpointMarker === "resetCredits") &&
    endpointMarker === endpointFromUrl
  ) return endpointMarker;
  return endpointFromUrl;
}

export class UsageObserver {
  constructor(session, { onUsagePayload = () => {}, onResetCreditsPayload = () => {}, onError = () => {} } = {}) {
    this.session = session;
    this.onUsagePayload = onUsagePayload;
    this.onResetCreditsPayload = onResetCreditsPayload;
    this.onError = onError;
    this.requests = new Map();
    this.nativeRequests = new Map();
  }

  async start() {
    await this.session.send("Network.enable");
    await this.session.send("Runtime.enable");
    await this.session.send("Runtime.addBinding", { name: NATIVE_BINDING_NAME });
    await this.#installNativeBridge();
  }

  async handleEvent(method, params) {
    if (method === "Runtime.bindingCalled") {
      await this.#handleNativeBinding(params);
      return;
    }

    if (method === "Runtime.executionContextCreated") {
      if (params?.context?.auxData?.isDefault === true) await this.#installNativeBridge(params.context.id);
      return;
    }

    if (method === "Network.requestWillBeSent") {
      const requestId = params?.requestId;
      const request = params?.request;
      if (typeof requestId === "string" && request && typeof request.url === "string") {
        this.requests.set(requestId, { method: request.method, url: request.url });
      }
      return;
    }

    if (method === "Network.loadingFailed") {
      const requestId = params?.requestId;
      if (typeof requestId === "string") this.requests.delete(requestId);
      return;
    }

    if (method !== "Network.responseReceived") return;
    const requestId = params?.requestId;
    if (typeof requestId !== "string") return;
    const request = this.requests.get(requestId);
    if (!request) return;
    this.requests.delete(requestId);

    try {
      const response = params.response;
      const requestEndpoint = endpointFor(request.url);
      const responseEndpoint = endpointFor(response?.url);
      if (
        request.method !== "GET" ||
        response?.status !== 200 ||
        !requestEndpoint ||
        requestEndpoint !== responseEndpoint
      ) return;

      const { body, base64Encoded } = await this.session.send("Network.getResponseBody", { requestId });
      const decoded = base64Encoded ? Buffer.from(body, "base64").toString("utf8") : body;
      const payload = JSON.parse(decoded);
      if (requestEndpoint === "usage") {
        await this.onUsagePayload(payload);
      } else {
        await this.onResetCreditsPayload(payload);
      }
    } catch (error) {
      await this.#notifyError(error);
    }
  }

  async #installNativeBridge(contextId) {
    const params = { expression: NATIVE_BRIDGE_SOURCE, awaitPromise: true, returnByValue: true };
    if (Number.isInteger(contextId)) params.contextId = contextId;
    try {
      await this.session.send("Runtime.evaluate", params);
    } catch (error) {
      await this.#notifyError(error);
    }
  }

  async #handleNativeBinding(params) {
    if (params?.name !== NATIVE_BINDING_NAME || typeof params?.payload !== "string") return;
    let event;
    try { event = JSON.parse(params.payload); } catch { return; }
    const requestId = event?.requestId;
    if (event?.kind === "request") {
      const endpoint = endpointForNativeRequest(event);
      if (event.method === "GET" && typeof requestId === "string" && endpoint) {
        this.nativeRequests.set(requestId, endpoint);
      }
      return;
    }
    if (event?.kind !== "response" || typeof requestId !== "string") return;
    const endpoint = this.nativeRequests.get(requestId);
    this.nativeRequests.delete(requestId);
    if (endpoint === null || endpoint === undefined || event.responseType !== "success" || event.status !== 200 || typeof event.bodyJsonString !== "string") return;
    try {
      const payload = JSON.parse(event.bodyJsonString);
      if (endpoint === "usage") await this.onUsagePayload(payload);
      else await this.onResetCreditsPayload(payload);
    } catch (error) {
      await this.#notifyError(error);
    }
  }

  async #notifyError(error) {
    try {
      await this.onError(error);
    } catch {
      // 错误回调不应产生未处理拒绝。
    }
  }
}
