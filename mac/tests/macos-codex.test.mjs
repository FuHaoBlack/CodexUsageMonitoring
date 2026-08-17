import test from "node:test";
import assert from "node:assert/strict";
import {
  discoverCodexInstallation,
  findRunningCodexMainProcesses,
  launchCodex,
  parseProcessList,
} from "../src/macos-codex.mjs";

test("discovers ChatGPT.app and its declared macOS executable", async () => {
  const calls = [];
  const installation = await discoverCodexInstallation({
    home: "/Users/tester",
    env: {},
    execFile: async (file, args) => {
      calls.push({ file, args });
      if (file === "mdfind") return { stdout: "/Applications/ChatGPT.app\n" };
      if (file === "/usr/libexec/PlistBuddy" && args[1].includes("CFBundleExecutable")) return { stdout: "ChatGPT\n" };
      if (file === "/usr/libexec/PlistBuddy") return { stdout: "1.2.3\n" };
      throw new Error(`unexpected command: ${file}`);
    },
    stat: async (value) => ({
      isDirectory: () => value.endsWith(".app"),
      isFile: () => value.endsWith("/ChatGPT"),
    }),
  });

  assert.deepEqual(installation, {
    exePath: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
    installLocation: "/Applications/ChatGPT.app",
    version: "1.2.3",
  });
  assert.equal(calls.filter(({ file }) => file === "mdfind").length, 2);
});

test("matches only the selected macOS Codex executable process", async () => {
  const rows = parseProcessList([
    " 101 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
    " 102 /Applications/ChatGPT.app/Contents/Frameworks/ChatGPT Helper.app/Contents/MacOS/ChatGPT Helper",
    " 103 /Applications/Other.app/Contents/MacOS/ChatGPT",
  ].join("\n"), "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT");

  assert.deepEqual(rows, [{
    pid: 101,
    executablePath: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
  }]);

  const running = await findRunningCodexMainProcesses(
    "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
    { execFile: async () => ({ stdout: " 101 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT\n" }) },
  );
  assert.deepEqual(running, rows);
});

test("launches macOS Codex with loopback-only CDP arguments", () => {
  let captured;
  const child = {};
  const result = launchCodex("/Applications/ChatGPT.app/Contents/MacOS/ChatGPT", 4567, {
    spawn: (...args) => { captured = args; return child; },
  });

  assert.equal(result, child);
  assert.deepEqual(captured, [
    "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
    ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=4567"],
    { detached: false, stdio: "ignore" },
  ]);
});
