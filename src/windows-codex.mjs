import { execFile as execFileCallback, spawn as spawnChild } from "node:child_process";
import { promisify } from "node:util";
import { stat as statFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

const execFileDefault = promisify(execFileCallback);
const POWERSHELL = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
const APPX_COMMAND = "Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1 InstallLocation, Version | ConvertTo-Json -Compress";
const PROCESS_COMMAND = "Get-CimInstance Win32_Process -Filter \\\"Name='Codex.exe'\\\" | Select-Object ProcessId, ExecutablePath | ConvertTo-Json -Compress";

function stdoutOf(result) {
  return typeof result === "string" ? result : result?.stdout;
}

export function parseAppxDiscoveryOutput(text) {
  let parsed;
  try { parsed = JSON.parse(String(text)); } catch { throw new Error("未找到有效的 Codex AppX 安装信息"); }
  if (Array.isArray(parsed)) parsed = parsed[0];
  const installLocation = typeof parsed?.InstallLocation === "string" ? parsed.InstallLocation : null;
  const version = typeof parsed?.Version === "string" ? parsed.Version : null;
  if (!installLocation || !version) throw new Error("未找到有效的 Codex AppX 安装信息");
  return { installLocation, version };
}

export async function discoverCodexInstallation({ execFile = execFileDefault, stat = statFile } = {}) {
  const output = await execFile(POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", APPX_COMMAND], { windowsHide: true });
  const { installLocation, version } = parseAppxDiscoveryOutput(stdoutOf(output));
  const exePath = path.win32.join(installLocation, "app", "Codex.exe");
  let details;
  try { details = await stat(exePath); } catch { throw new Error("未找到 Codex 可执行文件"); }
  if (!details.isFile()) throw new Error("未找到 Codex 可执行文件");
  return { exePath, version };
}

export async function findRunningCodexMainProcesses({ execFile = execFileDefault } = {}) {
  const output = await execFile(POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", PROCESS_COMMAND], { windowsHide: true });
  const text = String(stdoutOf(output) ?? "").trim();
  if (!text) return [];
  let rows;
  try { rows = JSON.parse(text); } catch { throw new Error("无法读取 Codex 进程状态"); }
  return (Array.isArray(rows) ? rows : [rows]).flatMap((row) => Number.isInteger(row?.ProcessId)
    ? [{ pid: row.ProcessId, executablePath: typeof row.ExecutablePath === "string" ? row.ExecutablePath : null }]
    : []);
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
  return spawn(exePath, ["--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${port}`], {
    detached: false,
    stdio: "ignore",
    windowsHide: true,
  });
}

function validTarget(target) {
  if (target?.type !== "page" || typeof target?.url !== "string" || typeof target?.webSocketDebuggerUrl !== "string") return false;
  if (target.url.startsWith("devtools:")) return false;
  try {
    const url = new URL(target.webSocketDebuggerUrl);
    return url.protocol === "ws:" && url.hostname === "127.0.0.1";
  } catch { return false; }
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function waitForCdpTarget(port, { timeoutMs = 15000, retryMs = 250, fetch: fetchImpl = globalThis.fetch } = {}) {
  const endpoint = `http://127.0.0.1:${port}/json/list`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      const response = await fetchImpl(endpoint);
      if (response?.ok) {
        const target = (await response.json()).find(validTarget);
        if (target) return { webSocketDebuggerUrl: target.webSocketDebuggerUrl };
      }
    } catch { /* CDP 尚未可用，继续等待启动窗口。 */ }
    if (Date.now() >= deadline) break;
    await delay(retryMs);
  }
  throw new Error("CDP 启动超时");
}

export async function isCdpEndpointAlive(port, { fetch: fetchImpl = globalThis.fetch } = {}) {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/json/version`);
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
