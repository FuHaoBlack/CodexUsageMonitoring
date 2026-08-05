import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const installScript = path.join(projectRoot, "scripts", "install.ps1");
const pwsh = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";

test("install preview generates a fixed local shortcut icon instead of referencing a versioned AppX path", async () => {
  const { stdout, stderr } = await execFileAsync(pwsh, [
    "-NoLogo",
    "-NoProfile",
    "-File",
    installScript,
    "-SourceRoot",
    projectRoot,
    "-WhatIf",
  ], { encoding: "utf8" });

  assert.equal(stderr, "");
  assert.match(stdout, /CodexUsageToolbar\.install-[a-f0-9]+\\assets\\Codex\.ico/i);
  assert.doesNotMatch(stdout, /WindowsApps\\OpenAI\.Codex_/i);
});
