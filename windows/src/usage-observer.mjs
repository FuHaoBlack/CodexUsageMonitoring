import { parseUsagePayload } from "./usage-state.mjs";

const ALLOWED_HOST = "chatgpt.com";
const USAGE_PATH = "/backend-api/wham/usage";
const RESET_CREDITS_PATH = "/backend-api/wham/rate-limit-reset-credits";
const NATIVE_BINDING_NAME = "codexUsageObserverV1";
const CANDIDATE_PATH = /(?:usage|quota|rate[-_]?limit|credit|limit)/i;
const MAX_CANDIDATE_BODY_BYTES = 512 * 1024;
const RESPONSE_BODY_KIND = "response-body";

const NATIVE_BRIDGE_SOURCE = `(() => {
  const marker = "__codexUsageObserverV1Installed";
  const responseProbeMarker = "__codexUsageObserverV1ResponseProbe";
  const binding = globalThis[${JSON.stringify(NATIVE_BINDING_NAME)}];
  if (typeof binding !== "function") return false;
  const endpointFor = (value) => {
    try {
      const parsed = new URL(value, "https://chatgpt.com");
      if (parsed.protocol !== "https:" || parsed.hostname !== "chatgpt.com") return null;
      const pathname = parsed.pathname.replace(/\\/+$/, "");
      if (pathname === "/wham/usage" || pathname === "/backend-api/wham/usage") return "usage";
      if (pathname === "/wham/rate-limit-reset-credits" || pathname === "/backend-api/wham/rate-limit-reset-credits") return "resetCredits";
      if (/(?:usage|quota|rate[-_]?limit|credit|limit)/i.test(pathname)) return "candidate";
    } catch {}
    return null;
  };
  const pending = new Set();
  const emit = (value) => {
    try { binding(JSON.stringify(value)); } catch {}
  };
  const candidateBody = (response, value) => {
    if (!response || response.status !== 200) return;
    const body = typeof value === "string" ? value : (() => {
      try { return JSON.stringify(value); } catch { return ""; }
    })();
    if (typeof body !== "string" || body.length > 524288 || !/(?:rate_limit|used_percent|reset_after_seconds|reset_at|available_count|credits)/i.test(body)) return;
    emit({ kind: "response-body", responseType: "success", status: 200, bodyJsonString: body });
  };
  const installResponseProbe = () => {
    if (globalThis[responseProbeMarker]) return;
    const responsePrototype = globalThis.Response?.prototype;
    if (!responsePrototype) return;
    const originalText = responsePrototype.text;
    const originalJson = responsePrototype.json;
    if (typeof originalText !== "function" && typeof originalJson !== "function") return;
    const seenResponses = new WeakSet();
    const wrap = (original, serializer) => {
      if (typeof original !== "function") return null;
      return function (...args) {
        const result = original.apply(this, args);
        Promise.resolve(result).then((value) => {
          const body = serializer(value);
          if (typeof body !== "string" || body.length === 0 || seenResponses.has(this)) return;
          const response = this;
          if (response.status !== 200 || body.length > 524288 || !/(?:rate_limit|used_percent|reset_after_seconds|reset_at|available_count|credits)/i.test(body)) return;
          seenResponses.add(response);
          candidateBody(response, body);
        }).catch(() => {});
        return result;
      };
    };
    let wrappedText = null;
    let wrappedJson = null;
    try {
      wrappedText = wrap(originalText, (value) => typeof value === "string" ? value : "");
      wrappedJson = wrap(originalJson, (value) => {
        try { return JSON.stringify(value); } catch { return ""; }
      });
      if (wrappedText) responsePrototype.text = wrappedText;
      if (wrappedJson) responsePrototype.json = wrappedJson;
      globalThis[responseProbeMarker] = { originalText, originalJson };
    } catch {
      try { if (wrappedText) responsePrototype.text = originalText; } catch {}
      try { if (wrappedJson) responsePrototype.json = originalJson; } catch {}
    }
  };
  installResponseProbe();
  if (globalThis[marker]) return true;
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
  if (typeof url !== "string") return null;
  try {
    const parsed = new URL(url, "https://chatgpt.com");
    if (parsed.protocol !== "https:" || parsed.hostname !== ALLOWED_HOST) return null;
    const pathname = parsed.pathname.replace(/\/+$/, "");
    if (pathname === USAGE_PATH || pathname === "/wham/usage") return "usage";
    if (pathname === RESET_CREDITS_PATH || pathname === "/wham/rate-limit-reset-credits") return "resetCredits";
    return "candidate";
  } catch {
    return null;
  }
}

function endpointForNativeRequest(event) {
  const endpointFromUrl = endpointFor(event?.url);
  const endpointMarker = event?.endpoint;
  if (endpointMarker === "candidate") {
    try {
      if (!CANDIDATE_PATH.test(new URL(event?.url, "https://chatgpt.com").pathname)) return null;
    } catch {
      return null;
    }
  }
  if (
    (endpointMarker === "usage" || endpointMarker === "resetCredits" || endpointMarker === "candidate") &&
    endpointMarker === endpointFromUrl
  ) return endpointMarker;
  return endpointFromUrl === "usage" || endpointFromUrl === "resetCredits" ? endpointFromUrl : null;
}

function hasResetCreditsShape(payload) {
  return Number.isInteger(payload?.available_count)
    || Array.isArray(payload?.credits)
    || Number.isInteger(payload?.rate_limit_reset_credits?.available_count)
    || Array.isArray(payload?.rate_limit_reset_credits?.credits);
}

function classifyPayload(payload) {
  try {
    if (parseUsagePayload(payload)) return "usage";
  } catch {
    // 结构探测失败时忽略该响应。
  }
  return hasResetCreditsShape(payload) ? "resetCredits" : null;
}

function responseMayContainJson(response, endpoint) {
  if (endpoint !== "candidate") return true;
  const mimeType = String(response?.mimeType ?? "").toLowerCase();
  const headers = response?.headers && typeof response.headers === "object" ? response.headers : {};
  const contentType = Object.entries(headers).find(([key]) => key.toLowerCase() === "content-type")?.[1];
  const contentLength = Object.entries(headers).find(([key]) => key.toLowerCase() === "content-length")?.[1];
  const length = Number(contentLength);
  if (Number.isFinite(length) && length > MAX_CANDIDATE_BODY_BYTES) return false;
  return mimeType.includes("json") || String(contentType ?? "").toLowerCase().includes("json");
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
        const endpoint = endpointFor(request.url);
        if (request.method === "GET" && endpoint) this.requests.set(requestId, { method: request.method, url: request.url, endpoint });
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
      const requestEndpoint = request.endpoint ?? endpointFor(request.url);
      const responseEndpoint = endpointFor(response?.url);
      if (
        request.method !== "GET" ||
        response?.status !== 200 ||
        !requestEndpoint ||
        !responseEndpoint ||
        (requestEndpoint !== responseEndpoint && requestEndpoint !== "candidate" && responseEndpoint !== "candidate") ||
        !responseMayContainJson(response, requestEndpoint)
      ) return;

      const { body, base64Encoded } = await this.session.send("Network.getResponseBody", { requestId });
      const decoded = base64Encoded ? Buffer.from(body, "base64").toString("utf8") : body;
      const payload = JSON.parse(decoded);
      const classification = requestEndpoint === "usage"
        ? "usage"
        : requestEndpoint === "resetCredits"
          ? "resetCredits"
          : classifyPayload(payload);
      if (classification === "usage") {
        await this.onUsagePayload(payload);
      } else if (classification === "resetCredits") {
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
    if (event?.kind === RESPONSE_BODY_KIND) {
      if (event.responseType !== "success" || event.status !== 200 || typeof event.bodyJsonString !== "string") return;
      if (Buffer.byteLength(event.bodyJsonString, "utf8") > MAX_CANDIDATE_BODY_BYTES) return;
      try {
        const payload = JSON.parse(event.bodyJsonString);
        const classification = classifyPayload(payload);
        if (classification === "usage") await this.onUsagePayload(payload);
        else if (classification === "resetCredits") await this.onResetCreditsPayload(payload);
      } catch (error) {
        await this.#notifyError(error);
      }
      return;
    }
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
      const classification = endpoint === "usage"
        ? "usage"
        : endpoint === "resetCredits"
          ? "resetCredits"
          : classifyPayload(payload);
      if (classification === "usage") await this.onUsagePayload(payload);
      else if (classification === "resetCredits") await this.onResetCreditsPayload(payload);
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
