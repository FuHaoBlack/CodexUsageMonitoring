import { execFile as execFileCallback, spawn as spawnChild } from "node:child_process";
import { promisify } from "node:util";
import { stat as statFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const execFileDefault = promisify(execFileCallback);
const posix = path.posix;
const APP_NAMES = ["ChatGPT.app", "Codex.app"];
const EXECUTABLE_NAMES = ["ChatGPT", "Codex"];
const MDFS_QUERY = "kMDItemFSName == 'ChatGPT.app' || kMDItemFSName == 'Codex.app'";

function stdoutOf(result) {
  return typeof result === "string" ? result : result?.stdout;
}

function normalizeMacPath(value) {
  if (typeof value !== "string" || !posix.isAbsolute(value) || value.includes("\0")) return null;
  return posix.normalize(value);
}

function unique(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

async function readPlistValue(appPath, key, execFile) {
  const infoPath = posix.join(appPath, "Contents", "Info.plist");
  try {
    const output = await execFile("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, infoPath]);
    const value = String(stdoutOf(output) ?? "").trim();
    return value || null;
  } catch {
    return null;
  }
}

async function findExecutable(appPath, { execFile = execFileDefault, stat = statFile } = {}) {
  const declaredName = await readPlistValue(appPath, "CFBundleExecutable", execFile);
  const names = unique([declaredName, ...EXECUTABLE_NAMES]);
  for (const name of names) {
    if (!/^[A-Za-z0-9._-]+$/.test(name)) continue;
    const exePath = posix.join(appPath, "Contents", "MacOS", name);
    try {
      const details = await stat(exePath);
      if (details.isFile()) return exePath;
    } catch {
      // 尝试下一个候选应用可执行文件。
    }
  }
  return null;
}

async function discoverCandidateApps({ execFile = execFileDefault, home = os.homedir(), env = process.env } = {}) {
  const canonical = [
    env.CODEX_APP_PATH,
    "/Applications/ChatGPT.app",
    "/Applications/Codex.app",
    posix.join(home, "Applications", "ChatGPT.app"),
    posix.join(home, "Applications", "Codex.app"),
  ];
  const discovered = [];
  for (const root of ["/Applications", posix.join(home, "Applications")]) {
    try {
      const output = await execFile("mdfind", ["-onlyin", root, MDFS_QUERY]);
      discovered.push(...String(stdoutOf(output) ?? "").split(/\r?\n/).map((value) => value.trim()));
    } catch {
      // mdfind 不可用时仍使用固定应用目录。
    }
  }
  return unique([...canonical, ...discovered])
    .map(normalizeMacPath)
    .filter((value) => value && APP_NAMES.includes(posix.basename(value)));
}

export async function discoverCodexInstallation({
  execFile = execFileDefault,
  stat = statFile,
  home = os.homedir(),
  env = process.env,
} = {}) {
  const candidates = await discoverCandidateApps({ execFile, home, env });
  for (const appPath of candidates) {
    try {
      const appDetails = await stat(appPath);
      if (!appDetails.isDirectory()) continue;
    } catch {
      continue;
    }
    const exePath = await findExecutable(appPath, { execFile, stat });
    if (!exePath) continue;
    const version = await readPlistValue(appPath, "CFBundleShortVersionString", execFile) || "unknown";
    return { exePath, installLocation: appPath, version };
  }
  throw new Error("未找到 ChatGPT/Codex macOS 应用，请设置 CODEX_APP_PATH");
}

export function parseProcessList(text, expectedExePath) {
  const expected = normalizeMacPath(expectedExePath);
  if (!expected) throw new Error("Codex 主进程路径无效");
  const expectedName = posix.basename(expected);
  return String(text ?? "").split(/\r?\n/).flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!match) return [];
    const pid = Number.parseInt(match[1], 10);
    const command = match[2].trim();
    const commandPath = normalizeMacPath(command);
    const commandName = posix.basename(commandPath || command);
    const matchesExpected = commandPath ? commandPath === expected : commandName === expectedName;
    if (!Number.isInteger(pid) || !matchesExpected) return [];
    return [{ pid, executablePath: commandPath || command }];
  });
}

export async function findRunningCodexMainProcesses(expectedExePath, { execFile = execFileDefault } = {}) {
  const output = await execFile("ps", ["-axo", "pid=,comm="]);
  return parseProcessList(stdoutOf(output), expectedExePath);
}

export function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

export function launchCodex(exePath, port, { spawn = spawnChild } = {}) {
  validatePort(port);
  return spawn(exePath, ["--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${port}`], {
    detached: false,
    stdio: "ignore",
  });
}

function validatePort(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("CDP 端口必须是 1 到 65535 的整数");
}

function validTarget(target, port) {
  if (target?.type !== "page" || typeof target?.url !== "string" || typeof target?.webSocketDebuggerUrl !== "string") return false;
  if (target.url.startsWith("devtools:")) return false;
  try {
    const url = new URL(target.webSocketDebuggerUrl);
    return url.protocol === "ws:" && url.hostname === "127.0.0.1" && url.port === String(port);
  } catch {
    return false;
  }
}

function targetPriority(target) {
  if (target.url === "app://-/index.html") return 0;
  if (target.url.startsWith("app://-/index.html?")) return 1;
  return 2;
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function beforeDeadline(factory, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("CDP 启动超时");
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => factory(controller.signal)),
      new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("CDP 启动超时")); }, remaining); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function waitForCdpTarget(port, { timeoutMs = 15000, retryMs = 250, fetch: fetchImpl = globalThis.fetch } = {}) {
  validatePort(port);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(retryMs) || retryMs < 0) throw new Error("CDP 超时参数无效");
  const endpoint = `http://127.0.0.1:${port}/json/list`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      const response = await beforeDeadline((signal) => fetchImpl(endpoint, { signal, redirect: "error" }), deadline);
      if (response?.ok) {
        const targets = await beforeDeadline(() => response.json(), deadline);
        const target = Array.isArray(targets)
          ? targets.filter((candidate) => validTarget(candidate, port)).sort((left, right) => targetPriority(left) - targetPriority(right))[0]
          : null;
        if (target) return { webSocketDebuggerUrl: target.webSocketDebuggerUrl };
      }
    } catch (error) {
      if (error?.message === "CDP 启动超时") throw error;
    }
    const remaining = Math.max(0, deadline - Date.now());
    if (remaining === 0) break;
    await delay(Math.min(retryMs, remaining));
  }
  throw new Error("CDP 启动超时");
}

export async function isCdpEndpointAlive(port, { timeoutMs = 1000, fetch: fetchImpl = globalThis.fetch } = {}) {
  validatePort(port);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("CDP 超时参数无效");
  try {
    const response = await beforeDeadline(
      (signal) => fetchImpl(`http://127.0.0.1:${port}/json/version`, { signal, redirect: "error" }),
      Date.now() + timeoutMs,
    );
    return Boolean(response?.ok);
  } catch {
    return false;
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href && process.argv.includes("--discover-only")) {
  discoverCodexInstallation().then(({ exePath, version }) => {
    console.log(`Codex ${version}`);
    console.log(exePath);
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
