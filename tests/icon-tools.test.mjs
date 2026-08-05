import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const iconToolsPath = path.join(projectRoot, "scripts", "icon-tools.ps1");
const pwsh = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";

async function runPowerShell(command, environment = {}) {
  return execFileAsync(pwsh, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8",
    env: { ...process.env, ICON_TOOLS_PATH: iconToolsPath, ...environment },
  });
}

async function createPng(filePath, size) {
  await runPowerShell(
    "Add-Type -AssemblyName System.Drawing.Common; "
      + "$bitmap = [Drawing.Bitmap]::new([int]$env:PNG_SIZE, [int]$env:PNG_SIZE); "
      + "try { $bitmap.Save($env:PNG_PATH, [Drawing.Imaging.ImageFormat]::Png) } finally { $bitmap.Dispose() }",
    { PNG_PATH: filePath, PNG_SIZE: String(size) },
  );
}

async function createOfficialAssetFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-icon-tools-"));
  const assets = path.join(root, "assets");
  await mkdir(assets);
  for (const size of [16, 256]) {
    for (const theme of ["unplated", "lightunplated"]) {
      await createPng(path.join(assets, `Square44x44Logo.targetsize-${size}_altform-${theme}.png`), size);
    }
  }
  return root;
}

test("selects only the official light-theme logo frames in numeric size order", async (t) => {
  const root = await createOfficialAssetFixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const { stdout } = await runPowerShell(
    ". $env:ICON_TOOLS_PATH; "
      + "$paths = @(Get-CodexLogoAssetPaths -InstallLocation $env:APPX_ROOT -Square44Logo 'assets/Square44x44Logo.png' -UseLightTheme $true); "
      + "$paths | ForEach-Object { [IO.Path]::GetFileName($_) } | ConvertTo-Json -Compress",
    { APPX_ROOT: root },
  );

  assert.deepEqual(JSON.parse(stdout.trim()), [
    "Square44x44Logo.targetsize-16_altform-lightunplated.png",
    "Square44x44Logo.targetsize-256_altform-lightunplated.png",
  ]);
});

test("selects only the official dark-theme logo frames", async (t) => {
  const root = await createOfficialAssetFixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const { stdout } = await runPowerShell(
    ". $env:ICON_TOOLS_PATH; "
      + "$paths = @(Get-CodexLogoAssetPaths -InstallLocation $env:APPX_ROOT -Square44Logo 'assets/Square44x44Logo.png' -UseLightTheme $false); "
      + "$paths | ForEach-Object { [IO.Path]::GetFileName($_) } | ConvertTo-Json -Compress",
    { APPX_ROOT: root },
  );

  assert.deepEqual(JSON.parse(stdout.trim()), [
    "Square44x44Logo.targetsize-16_altform-unplated.png",
    "Square44x44Logo.targetsize-256_altform-unplated.png",
  ]);
});

test("rejects a manifest logo path outside the AppX installation", async (t) => {
  const root = await createOfficialAssetFixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  await assert.rejects(
    runPowerShell(
      ". $env:ICON_TOOLS_PATH; Get-CodexLogoAssetPaths -InstallLocation $env:APPX_ROOT -Square44Logo '..\\outside.png' -UseLightTheme $true",
      { APPX_ROOT: root },
    ),
    /越出 AppX 安装目录/,
  );
});

test("writes a multi-frame ICO containing the original official PNG bytes", async (t) => {
  const root = await createOfficialAssetFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const png16 = path.join(root, "assets", "Square44x44Logo.targetsize-16_altform-lightunplated.png");
  const png256 = path.join(root, "assets", "Square44x44Logo.targetsize-256_altform-lightunplated.png");
  const destination = path.join(root, "Codex.ico");

  await runPowerShell(
    ". $env:ICON_TOOLS_PATH; Write-PngIcon -PngPaths @($env:PNG_16, $env:PNG_256) -Destination $env:ICO_PATH",
    { PNG_16: png16, PNG_256: png256, ICO_PATH: destination },
  );

  const [ico, source16, source256] = await Promise.all([
    readFile(destination),
    readFile(png16),
    readFile(png256),
  ]);
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), 2);

  const entries = [0, 1].map((index) => {
    const offset = 6 + index * 16;
    return {
      width: ico[offset] || 256,
      height: ico[offset + 1] || 256,
      planes: ico.readUInt16LE(offset + 4),
      bits: ico.readUInt16LE(offset + 6),
      length: ico.readUInt32LE(offset + 8),
      dataOffset: ico.readUInt32LE(offset + 12),
    };
  });
  assert.deepEqual(entries.map(({ width, height, planes, bits }) => ({ width, height, planes, bits })), [
    { width: 16, height: 16, planes: 1, bits: 32 },
    { width: 256, height: 256, planes: 1, bits: 32 },
  ]);
  assert.equal(entries[0].dataOffset, 6 + 16 * 2);
  assert.equal(entries[1].dataOffset, entries[0].dataOffset + entries[0].length);
  assert.deepEqual(ico.subarray(entries[0].dataOffset, entries[0].dataOffset + entries[0].length), source16);
  assert.deepEqual(ico.subarray(entries[1].dataOffset, entries[1].dataOffset + entries[1].length), source256);
});

test("rejects a non-PNG icon frame", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-icon-tools-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const invalid = path.join(root, "invalid.png");
  await writeFile(invalid, "not a png");

  await assert.rejects(
    runPowerShell(
      ". $env:ICON_TOOLS_PATH; Write-PngIcon -PngPaths @($env:PNG_PATH) -Destination $env:ICO_PATH",
      { PNG_PATH: invalid, ICO_PATH: path.join(root, "Codex.ico") },
    ),
    /不是有效的 PNG/,
  );
});
