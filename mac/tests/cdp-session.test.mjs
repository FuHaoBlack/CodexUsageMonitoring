import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { CdpSession } from "../src/cdp-session.mjs";

class FakeSocket extends EventEmitter {
  sent = [];
  send(value) { this.sent.push(JSON.parse(value)); }
  close() { this.emit("close"); }
}

class DualApiSocket extends FakeSocket {
  addEventListener(method, listener) {
    if (method === "message") {
      this.on(method, (data) => listener({ data }));
      return;
    }
    this.on(method, listener);
  }
}

test("matches a CDP response to its pending request", async () => {
  const socket = new FakeSocket();
  const session = new CdpSession(socket, {});
  const pending = session.send("Network.enable");
  const request = socket.sent[0];

  socket.emit("message", JSON.stringify({ id: request.id, result: {} }));
  assert.deepEqual(await pending, {});
});

test("forwards CDP events without treating them as responses", () => {
  const socket = new FakeSocket();
  const events = [];
  new CdpSession(socket, { onEvent: (method, params) => events.push({ method, params }) });

  socket.emit("message", JSON.stringify({
    method: "Network.responseReceived",
    params: { requestId: "r1" },
  }));

  assert.deepEqual(events, [{
    method: "Network.responseReceived",
    params: { requestId: "r1" },
  }]);
});

test("prefers addEventListener instead of registering both socket event APIs", () => {
  const socket = new DualApiSocket();
  let eventCount = 0;
  new CdpSession(socket, { onEvent: () => { eventCount += 1; } });

  socket.emit("message", JSON.stringify({ method: "Network.loadingFinished", params: {} }));

  assert.equal(eventCount, 1);
});

test("isolates synchronous onEvent exceptions", () => {
  const socket = new FakeSocket();
  new CdpSession(socket, { onEvent: () => { throw new Error("callback failure"); } });

  assert.doesNotThrow(() => {
    socket.emit("message", JSON.stringify({ method: "Network.loadingFinished", params: {} }));
  });
});

test("isolates rejected onEvent promises", async () => {
  const socket = new FakeSocket();
  const unhandled = [];
  const capture = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", capture);
  new CdpSession(socket, { onEvent: async () => { throw new Error("callback rejection"); } });

  socket.emit("message", JSON.stringify({ method: "Network.loadingFinished", params: {} }));
  await new Promise((resolve) => setImmediate(resolve));
  process.off("unhandledRejection", capture);

  assert.deepEqual(unhandled, []);
});

test("rejects pending requests and closes once when the socket errors", async () => {
  const socket = new FakeSocket();
  let closeCount = 0;
  const session = new CdpSession(socket, { onClose: () => { closeCount += 1; } });
  const first = session.send("Network.enable");
  const second = session.send("Runtime.enable");

  assert.doesNotThrow(() => socket.emit("error", new Error("socket failure")));
  await assert.rejects(first, /CDP 连接发生错误/);
  await assert.rejects(second, /CDP 连接发生错误/);
  assert.equal(closeCount, 1);
});
