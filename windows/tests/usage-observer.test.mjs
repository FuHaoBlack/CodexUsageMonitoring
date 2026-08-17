import test from "node:test";
import assert from "node:assert/strict";
import { UsageObserver } from "../src/usage-observer.mjs";

function responseEvent(url, requestId = "r1", status = 200) {
  return {
    requestId,
    type: "Fetch",
    response: { url, status },
  };
}

test("reads an existing official usage response body", async () => {
  const calls = [];
  const payloads = [];
  const session = {
    async send(method, params) {
      calls.push({ method, params });
      if (method === "Network.getResponseBody") {
        return { body: JSON.stringify({ rate_limit: {} }), base64Encoded: false };
      }
      return {};
    },
  };
  const observer = new UsageObserver(session, {
    onUsagePayload: (value) => payloads.push(value),
    onResetCreditsPayload: () => {},
    onError: assert.fail,
  });

  await observer.handleEvent("Network.requestWillBeSent", {
    requestId: "r1",
    request: {
      method: "GET",
      url: "https://chatgpt.com/backend-api/wham/usage",
    },
  });
  await observer.handleEvent(
    "Network.responseReceived",
    responseEvent("https://chatgpt.com/backend-api/wham/usage"),
  );

  assert.equal(payloads.length, 1);
  assert.deepEqual(calls.at(-1), {
    method: "Network.getResponseBody",
    params: { requestId: "r1" },
  });
});

test("starts native Codex fetch-response observation without issuing a request", async () => {
  const calls = [];
  const observer = new UsageObserver({
    async send(method, params) {
      calls.push({ method, params });
      return {};
    },
  });

  await observer.start();

  assert.deepEqual(calls.map(({ method }) => method), [
    "Network.enable",
    "Runtime.enable",
    "Runtime.addBinding",
    "Runtime.evaluate",
  ]);
  assert.equal(calls[2].params.name, "codexUsageObserverV1");
  assert.match(calls[3].params.expression, /codex-message-from-view/);
  assert.match(calls[3].params.expression, /fetch-response/);
});

test("routes an official native usage response by its fetch request id", async () => {
  const payloads = [];
  const observer = new UsageObserver({ async send() {} }, {
    onUsagePayload: (payload) => payloads.push(payload),
    onResetCreditsPayload: assert.fail,
    onError: assert.fail,
  });

  await observer.handleEvent("Runtime.bindingCalled", {
    name: "codexUsageObserverV1",
    payload: JSON.stringify({
      kind: "request",
      requestId: "bridge-usage-1",
      method: "GET",
      url: "/wham/usage",
    }),
  });
  const payload = { rate_limit: { primary_window: { used_percent: 79, limit_window_seconds: 604800, reset_at: 1785902940 } } };
  await observer.handleEvent("Runtime.bindingCalled", {
    name: "codexUsageObserverV1",
    payload: JSON.stringify({
      kind: "response",
      requestId: "bridge-usage-1",
      responseType: "success",
      status: 200,
      bodyJsonString: JSON.stringify(payload),
    }),
  });

  assert.deepEqual(payloads, [payload]);
});

test("routes native usage responses when the bridge supplies an endpoint marker", async () => {
  const payloads = [];
  const observer = new UsageObserver({ async send() {} }, {
    onUsagePayload: (payload) => payloads.push(payload),
    onResetCreditsPayload: assert.fail,
    onError: assert.fail,
  });

  await observer.handleEvent("Runtime.bindingCalled", {
    name: "codexUsageObserverV1",
    payload: JSON.stringify({
      kind: "request",
      requestId: "bridge-usage-marker-1",
      method: "GET",
      url: "/wham/usage",
      endpoint: "usage",
    }),
  });
  const payload = { rate_limit: { primary_window: { used_percent: 21, limit_window_seconds: 604800, reset_at: 1786100000 } } };
  await observer.handleEvent("Runtime.bindingCalled", {
    name: "codexUsageObserverV1",
    payload: JSON.stringify({
      kind: "response",
      requestId: "bridge-usage-marker-1",
      responseType: "success",
      status: 200,
      bodyJsonString: JSON.stringify(payload),
    }),
  });

  assert.deepEqual(payloads, [payload]);
});

test("routes an official native reset-credit response by its fetch request id", async () => {
  const payloads = [];
  const observer = new UsageObserver({ async send() {} }, {
    onUsagePayload: assert.fail,
    onResetCreditsPayload: (payload) => payloads.push(payload),
    onError: assert.fail,
  });

  await observer.handleEvent("Runtime.bindingCalled", {
    name: "codexUsageObserverV1",
    payload: JSON.stringify({
      kind: "request",
      requestId: "bridge-reset-1",
      method: "GET",
      url: "/wham/rate-limit-reset-credits",
    }),
  });
  const payload = { available_count: 1, credits: [] };
  await observer.handleEvent("Runtime.bindingCalled", {
    name: "codexUsageObserverV1",
    payload: JSON.stringify({
      kind: "response",
      requestId: "bridge-reset-1",
      responseType: "success",
      status: 200,
      bodyJsonString: JSON.stringify(payload),
    }),
  });

  assert.deepEqual(payloads, [payload]);
});

test("ignores lookalike hosts and unrelated paths", async () => {
  let bodyReads = 0;
  const observer = new UsageObserver({
    async send() { bodyReads += 1; return {}; },
  }, {
    onUsagePayload: assert.fail,
    onResetCreditsPayload: assert.fail,
    onError: assert.fail,
  });

  await observer.handleEvent("Network.requestWillBeSent", {
    requestId: "r1",
    request: {
      method: "GET",
      url: "https://example.com/wham/usage",
    },
  });
  await observer.handleEvent(
    "Network.responseReceived",
    responseEvent("https://example.com/wham/usage"),
  );
  await observer.handleEvent("Network.requestWillBeSent", {
    requestId: "r2",
    request: {
      method: "GET",
      url: "https://chatgpt.com/backend-api/wham/usage/credit-usage-events",
    },
  });
  await observer.handleEvent(
    "Network.responseReceived",
    responseEvent("https://chatgpt.com/backend-api/wham/usage/credit-usage-events", "r2"),
  );

  assert.equal(bodyReads, 0);
});

test("ignores POST even when the URL is an allowed usage endpoint", async () => {
  let bodyReads = 0;
  const observer = new UsageObserver({
    async send() { bodyReads += 1; return {}; },
  }, {
    onUsagePayload: assert.fail,
    onResetCreditsPayload: assert.fail,
    onError: assert.fail,
  });

  await observer.handleEvent("Network.requestWillBeSent", {
    requestId: "post-1",
    request: {
      method: "POST",
      url: "https://chatgpt.com/backend-api/wham/usage",
    },
  });
  await observer.handleEvent(
    "Network.responseReceived",
    responseEvent("https://chatgpt.com/backend-api/wham/usage", "post-1"),
  );

  assert.equal(bodyReads, 0);
});

test("forgets a request when network loading fails", async () => {
  let bodyReads = 0;
  const observer = new UsageObserver({
    async send() { bodyReads += 1; return {}; },
  }, {
    onUsagePayload: assert.fail,
    onResetCreditsPayload: assert.fail,
    onError: assert.fail,
  });

  await observer.handleEvent("Network.requestWillBeSent", {
    requestId: "failed-1",
    request: { method: "GET", url: "https://chatgpt.com/backend-api/wham/usage" },
  });
  await observer.handleEvent("Network.loadingFailed", { requestId: "failed-1" });
  await observer.handleEvent(
    "Network.responseReceived",
    responseEvent("https://chatgpt.com/backend-api/wham/usage", "failed-1"),
  );

  assert.equal(bodyReads, 0);
});

test("reads a response body once when duplicate response events arrive", async () => {
  let bodyReads = 0;
  let releaseBody;
  const body = new Promise((resolve) => { releaseBody = resolve; });
  const observer = new UsageObserver({
    async send(method) {
      if (method === "Network.getResponseBody") {
        bodyReads += 1;
        return body;
      }
      return {};
    },
  }, {
    onUsagePayload: () => {},
    onResetCreditsPayload: assert.fail,
    onError: assert.fail,
  });
  const event = responseEvent("https://chatgpt.com/backend-api/wham/usage", "duplicate-1");

  await observer.handleEvent("Network.requestWillBeSent", {
    requestId: "duplicate-1",
    request: { method: "GET", url: "https://chatgpt.com/backend-api/wham/usage" },
  });
  const first = observer.handleEvent("Network.responseReceived", event);
  const second = observer.handleEvent("Network.responseReceived", event);
  releaseBody({ body: JSON.stringify({ rate_limit: {} }), base64Encoded: false });
  await Promise.all([first, second]);

  assert.equal(bodyReads, 1);
});

test("reports observer errors without leaking an onError rejection", async () => {
  const unhandled = [];
  const capture = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", capture);
  let errorCount = 0;
  const observer = new UsageObserver({
    async send() { throw new Error("body read failure"); },
  }, {
    onUsagePayload: assert.fail,
    onResetCreditsPayload: assert.fail,
    onError: async () => {
      errorCount += 1;
      throw new Error("error callback failure");
    },
  });

  await observer.handleEvent("Network.requestWillBeSent", {
    requestId: "error-1",
    request: { method: "GET", url: "https://chatgpt.com/backend-api/wham/usage" },
  });
  await observer.handleEvent(
    "Network.responseReceived",
    responseEvent("https://chatgpt.com/backend-api/wham/usage", "error-1"),
  );
  await new Promise((resolve) => setImmediate(resolve));
  process.off("unhandledRejection", capture);

  assert.equal(errorCount, 1);
  assert.deepEqual(unhandled, []);
});
