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
    Applications: [
      { Executable: "app/ChatGPT.exe", EntryPoint: "Windows.FullTrustApplication" },
    ],
  })), {
    installLocation: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.721.4979.0_x64__2p2nqsd0c76g0",
    version: "26.721.4979.0",
    executable: "app\\ChatGPT.exe",
  });
});

test("discovers the unique FullTrust manifest executable instead of guessing Codex.exe", async () => {
  let invocation;
  const checkedPaths = [];
  const installation = await discoverCodexInstallation({
    execFile: async (...args) => {
      invocation = args;
      return JSON.stringify({
        InstallLocation: "C:\\Apps\\Codex",
        Version: "26.1.0.0",
        Applications: [
          { Executable: "app/ChatGPT.exe", EntryPoint: "Windows.FullTrustApplication" },
        ],
      });
    },
    stat: async (candidate) => {
      checkedPaths.push(candidate);
      return { isFile: () => candidate === "C:\\Apps\\Codex\\app\\ChatGPT.exe" };
    },
  });
  assert.deepEqual(installation, {
    exePath: "C:\\Apps\\Codex\\app\\ChatGPT.exe",
    installLocation: "C:\\Apps\\Codex",
    version: "26.1.0.0",
  });
  assert.deepEqual(checkedPaths, ["C:\\Apps\\Codex\\app\\ChatGPT.exe"]);
  assert.equal(invocation[0], "C:\\Program Files\\PowerShell\\7\\pwsh.exe");
  assert.deepEqual(invocation[1].slice(0, 4), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
  assert.match(invocation[1].at(-1), /Get-AppxPackage -Name OpenAI\.Codex/);
  assert.match(invocation[1].at(-1), /Get-AppxPackageManifest/);
  assert.deepEqual(invocation[2], { windowsHide: true });
});

test("returns only the exact manifest executable process using Windows path semantics", async () => {
  let invocation;
  const result = await findRunningCodexMainProcesses("C:\\Apps\\Codex\\app\\ChatGPT.exe", {
    execFile: async (...args) => {
      invocation = args;
      return JSON.stringify([
        { ProcessId: 42, ExecutablePath: "c:\\apps\\CODEX\\app\\chatgpt.exe" },
        { ProcessId: 43, ExecutablePath: "C:\\Apps\\Codex\\app\\resources\\codex.exe" },
        { ProcessId: 44, ExecutablePath: "C:\\Users\\user\\AppData\\Local\\OpenAI\\Codex\\bin\\codex.exe" },
        { ProcessId: 45, ExecutablePath: "D:\\Other\\ChatGPT.exe" },
        { ProcessId: 46, ExecutablePath: null },
        { ProcessId: 47, ExecutablePath: "app\\ChatGPT.exe" },
      ]);
    },
  });
  assert.deepEqual(result, [{ pid: 42, executablePath: "c:\\apps\\CODEX\\app\\chatgpt.exe" }]);
  assert.match(invocation[1].at(-1), /Get-CimInstance Win32_Process -ErrorAction Stop/);
  assert.match(invocation[1].at(-1), /Select-Object ProcessId, ExecutablePath/);
  assert.doesNotMatch(invocation[1].at(-1), /CommandLine/);
  assert.equal(invocation[0], "C:\\Program Files\\PowerShell\\7\\pwsh.exe");
  assert.deepEqual(invocation[1].slice(0, 4), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
  assert.deepEqual(invocation[2], { windowsHide: true });
});

test("fails closed when process enumeration cannot determine whether Codex is running", async () => {
  await assert.rejects(
    findRunningCodexMainProcesses("C:\\Apps\\Codex\\app\\ChatGPT.exe", {
      execFile: async () => { throw new Error("access denied"); },
    }),
    /access denied/,
  );
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

test("prefers the Codex main page over the in-app browser and overlay targets", async () => {
  const target = await waitForCdpTarget(4567, {
    timeoutMs: 20,
    retryMs: 1,
    fetch: async () => ({ ok: true, json: async () => [
      { type: "page", url: "http://localhost:60954/", webSocketDebuggerUrl: "ws://127.0.0.1:4567/browser" },
      { type: "page", url: "app://-/index.html?initialRoute=%2Favatar-overlay", webSocketDebuggerUrl: "ws://127.0.0.1:4567/overlay" },
      { type: "page", url: "app://-/index.html", webSocketDebuggerUrl: "ws://127.0.0.1:4567/main" },
    ] }),
  });
  assert.deepEqual(target, { webSocketDebuggerUrl: "ws://127.0.0.1:4567/main" });
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

test("clamps a long retry delay to the remaining CDP deadline", async () => {
  const started = Date.now();
  await assert.rejects(waitForCdpTarget(4567, {
    timeoutMs: 15, retryMs: 60000,
    fetch: async () => ({ ok: false }),
  }), /CDP 启动超时/);
  assert.ok(Date.now() - started < 200);
});

test("rejects malformed AppX discovery records and executable paths", async () => {
  for (const value of ["", "not json", "{}", JSON.stringify({ InstallLocation: "relative", Version: "26.1" }), JSON.stringify({ InstallLocation: "C:\\Apps", Version: "v26" })]) {
    assert.throws(() => parseAppxDiscoveryOutput(value), /安装信息/);
  }
  const validBase = {
    InstallLocation: "C:\\Apps\\Codex",
    Version: "26.1.0.0",
    Applications: [{ Executable: "app/ChatGPT.exe", EntryPoint: "Windows.FullTrustApplication" }],
  };
  await assert.rejects(discoverCodexInstallation({ execFile: async () => JSON.stringify(validBase), stat: async () => { throw new Error("missing"); } }), /可执行文件/);
  await assert.rejects(discoverCodexInstallation({ execFile: async () => JSON.stringify(validBase), stat: async () => ({ isFile: () => false }) }), /可执行文件/);
});

test("rejects unsafe, missing, non-FullTrust, and ambiguous manifest executables", () => {
  const record = (Applications) => JSON.stringify({
    InstallLocation: "C:\\Apps\\Codex",
    Version: "26.1.0.0",
    Applications,
  });
  const invalidApplications = [
    [],
    [{ EntryPoint: "Windows.FullTrustApplication" }],
    [{ Executable: "", EntryPoint: "Windows.FullTrustApplication" }],
    [{ Executable: "C:\\evil.exe", EntryPoint: "Windows.FullTrustApplication" }],
    [{ Executable: "\\\\server\\share\\evil.exe", EntryPoint: "Windows.FullTrustApplication" }],
    [{ Executable: "..\\evil.exe", EntryPoint: "Windows.FullTrustApplication" }],
    [{ Executable: "app\\..\\..\\evil.exe", EntryPoint: "Windows.FullTrustApplication" }],
    [{ Executable: ".\\app\\ChatGPT.exe", EntryPoint: "Windows.FullTrustApplication" }],
    [{ Executable: "app\\ChatGPT.exe\u0000", EntryPoint: "Windows.FullTrustApplication" }],
    [{ Executable: "app\\ChatGPT.exe", EntryPoint: "OpenAI.OtherApplication" }],
    [
      { Executable: "app\\ChatGPT.exe", EntryPoint: "Windows.FullTrustApplication" },
      { Executable: "app\\Other.exe", EntryPoint: "Windows.FullTrustApplication" },
    ],
  ];
  for (const applications of invalidApplications) {
    assert.throws(() => parseAppxDiscoveryOutput(record(applications)), /安装信息/);
  }
});

test("treats local CDP discovery failures as unavailable", async () => {
  assert.equal(await isCdpEndpointAlive(4567, { fetch: async () => { throw new Error("unavailable"); } }), false);
});

test("bounds CDP liveness checks when a fetch ignores abort", async () => {
  const started = Date.now();
  assert.equal(await isCdpEndpointAlive(4567, { timeoutMs: 15, fetch: async () => new Promise(() => {}) }), false);
  assert.ok(Date.now() - started < 200);
});
