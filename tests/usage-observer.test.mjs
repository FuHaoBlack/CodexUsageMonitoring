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
