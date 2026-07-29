const ALLOWED_HOST = "chatgpt.com";
const USAGE_PATH = "/backend-api/wham/usage";
const RESET_CREDITS_PATH = "/backend-api/wham/rate-limit-reset-credits";

function endpointFor(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.hostname !== ALLOWED_HOST) return null;
    if (parsed.pathname === USAGE_PATH) return "usage";
    if (parsed.pathname === RESET_CREDITS_PATH) return "resetCredits";
  } catch {
    return null;
  }
  return null;
}

export class UsageObserver {
  constructor(session, { onUsagePayload = () => {}, onResetCreditsPayload = () => {}, onError = () => {} } = {}) {
    this.session = session;
    this.onUsagePayload = onUsagePayload;
    this.onResetCreditsPayload = onResetCreditsPayload;
    this.onError = onError;
    this.requests = new Map();
  }

  async start() {
    await this.session.send("Network.enable");
  }

  async handleEvent(method, params) {
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

  async #notifyError(error) {
    try {
      await this.onError(error);
    } catch {
      // 错误回调不应产生未处理拒绝。
    }
  }
}
