import { execFile as execFileCallback, spawn as spawnChild } from "node:child_process";
import { promisify } from "node:util";
import { stat as statFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

const execFileDefault = promisify(execFileCallback);
const POWERSHELL = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
const APPX_COMMAND = [
  "$package = Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1",
  "if ($null -eq $package) { $null | ConvertTo-Json -Compress; return }",
  "$manifest = Get-AppxPackageManifest -Package $package",
  "$applications = @($manifest.Package.Applications.Application | ForEach-Object { [pscustomobject]@{ Executable = [string]$_.Executable; EntryPoint = [string]$_.EntryPoint } })",
  "[pscustomobject]@{ InstallLocation = $package.InstallLocation; Version = $package.Version.ToString(); Applications = $applications } | ConvertTo-Json -Compress -Depth 4",
].join("; ");
const PROCESS_COMMAND = "Get-CimInstance Win32_Process | Select-Object ProcessId, ExecutablePath | ConvertTo-Json -Compress";

function stdoutOf(result) {
  return typeof result === "string" ? result : result?.stdout;
}

export function parseAppxDiscoveryOutput(text) {
  let parsed;
  try { parsed = JSON.parse(String(text)); } catch { throw new Error("未找到有效的 Codex AppX 安装信息"); }
  if (Array.isArray(parsed)) parsed = parsed[0];
  const installLocation = typeof parsed?.InstallLocation === "string" ? parsed.InstallLocation : null;
  const version = typeof parsed?.Version === "string" ? parsed.Version : null;
  if (!installLocation || !version || !path.win32.isAbsolute(installLocation) || !/^[A-Za-z]:\\/.test(installLocation) || !/^\d+(?:\.\d+)+$/.test(version)) throw new Error("未找到有效的 Codex AppX 安装信息");
  const applications = Array.isArray(parsed?.Applications)
    ? parsed.Applications
    : parsed?.Applications && typeof parsed.Applications === "object"
      ? [parsed.Applications]
      : [];
  const fullTrustApplications = applications.filter((application) => application?.EntryPoint === "Windows.FullTrustApplication");
  if (fullTrustApplications.length !== 1) throw new Error("未找到有效的 Codex AppX 安装信息");
  const manifestExecutable = fullTrustApplications[0]?.Executable;
  if (
    typeof manifestExecutable !== "string"
    || manifestExecutable.length === 0
    || manifestExecutable !== manifestExecutable.trim()
    || manifestExecutable.includes("\0")
  ) throw new Error("未找到有效的 Codex AppX 安装信息");
  const executable = manifestExecutable.replaceAll("/", "\\");
  const segments = executable.split("\\");
  if (
    path.win32.isAbsolute(executable)
    || path.win32.parse(executable).root
    || executable.includes(":")
    || segments.some((segment) => segment === "." || segment === "..")
  ) throw new Error("未找到有效的 Codex AppX 安装信息");
  return { installLocation, version, executable: path.win32.normalize(executable) };
}

export async function discoverCodexInstallation({ execFile = execFileDefault, stat = statFile } = {}) {
  const output = await execFile(POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", APPX_COMMAND], { windowsHide: true });
  const { installLocation, version, executable } = parseAppxDiscoveryOutput(stdoutOf(output));
  const installRoot = path.win32.resolve(installLocation);
  const exePath = path.win32.resolve(installRoot, executable);
  const rootPrefix = `${installRoot.toLocaleLowerCase("en-US")}\\`;
  if (!exePath.toLocaleLowerCase("en-US").startsWith(rootPrefix)) throw new Error("未找到 Codex 可执行文件");
  let details;
  try { details = await stat(exePath); } catch { throw new Error("未找到 Codex 可执行文件"); }
  if (!details.isFile()) throw new Error("未找到 Codex 可执行文件");
  return { exePath, installLocation, version };
}

function normalizedAbsoluteWindowsPath(value) {
  if (typeof value !== "string" || !path.win32.isAbsolute(value) || !/^[A-Za-z]:\\/.test(value)) return null;
  return path.win32.normalize(value).toLocaleLowerCase("en-US");
}

export async function findRunningCodexMainProcesses(expectedExePath, { execFile = execFileDefault } = {}) {
  const expectedIdentity = normalizedAbsoluteWindowsPath(expectedExePath);
  if (!expectedIdentity) throw new Error("Codex 主进程路径无效");
  const output = await execFile(POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", PROCESS_COMMAND], { windowsHide: true });
  const text = String(stdoutOf(output) ?? "").trim();
  if (!text) return [];
  let rows;
  try { rows = JSON.parse(text); } catch { throw new Error("无法读取 Codex 进程状态"); }
  return (Array.isArray(rows) ? rows : [rows]).flatMap((row) => (
    Number.isInteger(row?.ProcessId) && normalizedAbsoluteWindowsPath(row?.ExecutablePath) === expectedIdentity
      ? [{ pid: row.ProcessId, executablePath: row.ExecutablePath }]
      : []
  ));
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
    windowsHide: true,
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
  } catch { return false; }
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
  } finally { clearTimeout(timer); }
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
        const target = Array.isArray(targets) ? targets.find((candidate) => validTarget(candidate, port)) : null;
        if (target) return { webSocketDebuggerUrl: target.webSocketDebuggerUrl };
      }
    } catch (error) {
      if (error?.message === "CDP 启动超时") throw error;
      // CDP 尚未可用，继续等待启动窗口。
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
  } catch { return false; }
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
