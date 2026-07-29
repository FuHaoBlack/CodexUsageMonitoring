import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { CdpSession } from "../src/cdp-session.mjs";

class FakeSocket extends EventEmitter {
  sent = [];
  send(value) { this.sent.push(JSON.parse(value)); }
  close() { this.emit("close"); }
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
