import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import {
  parseAppxDiscoveryOutput,
  discoverCodexInstallation,
  findRunningCodexMainProcesses,
  reserveLoopbackPort,
  launchCodex,
  waitForCdpTarget,
  isCdpEndpointAlive,
} from "../src/windows-codex.mjs";

test("parses one selected AppX package without guessing a version path", () => {
  assert.deepEqual(parseAppxDiscoveryOutput(JSON.stringify({
    InstallLocation: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.721.4979.0_x64__2p2nqsd0c76g0",
    Version: "26.721.4979.0",
  })), {
    installLocation: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.721.4979.0_x64__2p2nqsd0c76g0",
    version: "26.721.4979.0",
  });
});

test("discovers Codex executable from selected AppX metadata", async () => {
  const installation = await discoverCodexInstallation({
    execFile: async () => JSON.stringify({ InstallLocation: "C:\\Apps\\Codex", Version: "26.1.0.0" }),
    stat: async (path) => ({ isFile: () => path === "C:\\Apps\\Codex\\app\\Codex.exe" }),
  });
  assert.deepEqual(installation, { exePath: "C:\\Apps\\Codex\\app\\Codex.exe", version: "26.1.0.0" });
});

test("returns only Codex process identity without command lines", async () => {
  let invocation;
  const result = await findRunningCodexMainProcesses({
    execFile: async (...args) => {
      invocation = args;
      return JSON.stringify([{ ProcessId: 42, ExecutablePath: "C:\\Apps\\Codex\\app\\Codex.exe" }]);
    },
  });
  assert.deepEqual(result, [{ pid: 42, executablePath: "C:\\Apps\\Codex\\app\\Codex.exe" }]);
  assert.match(invocation[1].join(" "), /-Filter "Name='Codex\.exe'"/);
  assert.doesNotMatch(invocation[1].join(" "), /\\/);
  assert.match(invocation[1].at(-1), /Select-Object ProcessId, ExecutablePath/);
  assert.doesNotMatch(invocation[1].at(-1), /CommandLine/);
});

test("reserves a currently free TCP port on loopback and releases the socket", async () => {
  const port = await reserveLoopbackPort();
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
  const probe = net.createServer();
  await new Promise((resolve, reject) => probe.once("error", reject).listen(port, "127.0.0.1", resolve));
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
});

test("launches with loopback-only CDP arguments and safe child options", () => {
  let captured;
  const child = { pid: 12 };
  assert.equal(launchCodex("C:\\Apps\\Codex.exe", 4567, { spawn: (...args) => { captured = args; return child; } }), child);
  assert.deepEqual(captured, ["C:\\Apps\\Codex.exe", ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=4567"], {
    detached: false, stdio: "ignore", windowsHide: true,
  }]);
});

test("rejects invalid CDP ports before launching or discovering", async () => {
  assert.throws(() => launchCodex("C:\\Apps\\Codex.exe", 0, { spawn: () => { throw new Error("must not spawn"); } }), /端口/);
  await assert.rejects(waitForCdpTarget(65536, { fetch: () => { throw new Error("must not fetch"); } }), /端口/);
  await assert.rejects(isCdpEndpointAlive(1.2, { fetch: () => { throw new Error("must not fetch"); } }), /端口/);
});

test("selects only a non-DevTools local page target", async () => {
  const target = await waitForCdpTarget(4567, {
    timeoutMs: 20,
    retryMs: 1,
    fetch: async (url) => {
      assert.equal(url, "http://127.0.0.1:4567/json/list");
      return { ok: true, json: async () => [
        { type: "page", url: "devtools://devtools/bundled/inspector.html", webSocketDebuggerUrl: "ws://127.0.0.1/devtools" },
        { type: "page", url: "file:///app/index.html", webSocketDebuggerUrl: "ws://192.168.1.2/page" },
        { type: "page", url: "file:///app/index.html", webSocketDebuggerUrl: "ws://127.0.0.1:4567/page" },
      ] };
    },
  });
  assert.deepEqual(target, { webSocketDebuggerUrl: "ws://127.0.0.1:4567/page" });
});

test("times out when no eligible CDP target appears", async () => {
  await assert.rejects(waitForCdpTarget(4567, {
    timeoutMs: 5,
    retryMs: 1,
    fetch: async () => ({ ok: true, json: async () => [{ type: "page", url: "devtools://devtools", webSocketDebuggerUrl: "ws://127.0.0.1/devtools" }] }),
  }), /CDP 启动超时/);
});

test("rejects a target whose loopback WebSocket port differs from discovery", async () => {
  await assert.rejects(waitForCdpTarget(4567, {
    timeoutMs: 5, retryMs: 1,
    fetch: async () => ({ ok: true, json: async () => [{ type: "page", url: "file:///app", webSocketDebuggerUrl: "ws://127.0.0.1:4568/page" }] }),
  }), /CDP 启动超时/);
});

test("enforces the total CDP deadline when fetch or JSON parsing never settles", async () => {
  const pending = new Promise(() => {});
  const started = Date.now();
  await assert.rejects(waitForCdpTarget(4567, { timeoutMs: 15, retryMs: 1, fetch: async () => pending }), /CDP 启动超时/);
  assert.ok(Date.now() - started < 200);
  await assert.rejects(waitForCdpTarget(4567, {
    timeoutMs: 15, retryMs: 1,
    fetch: async () => ({ ok: true, json: async () => pending }),
  }), /CDP 启动超时/);
});

test("rejects malformed AppX discovery records and executable paths", async () => {
  for (const value of ["", "not json", "{}", JSON.stringify({ InstallLocation: "relative", Version: "26.1" }), JSON.stringify({ InstallLocation: "C:\\Apps", Version: "v26" })]) {
    assert.throws(() => parseAppxDiscoveryOutput(value), /安装信息/);
  }
  await assert.rejects(discoverCodexInstallation({ execFile: async () => JSON.stringify({ InstallLocation: "C:\\Apps", Version: "26.1.0.0" }), stat: async () => { throw new Error("missing"); } }), /可执行文件/);
  await assert.rejects(discoverCodexInstallation({ execFile: async () => JSON.stringify({ InstallLocation: "C:\\Apps", Version: "26.1.0.0" }), stat: async () => ({ isFile: () => false }) }), /可执行文件/);
});

test("treats local CDP discovery failures as unavailable", async () => {
  assert.equal(await isCdpEndpointAlive(4567, { fetch: async () => { throw new Error("unavailable"); } }), false);
});
