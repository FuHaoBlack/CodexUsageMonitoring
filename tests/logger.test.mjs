import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../src/logger.mjs";

async function withLogDir(run) {
  const dir = await mkdtemp(join(tmpdir(), "codex-usage-toolbar-log-"));
  try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test("logs approved metadata and rejects sensitive keys recursively", async () => withLogDir(async (dir) => {
  const logger = await createLogger(dir, { maxBytes: 1024, maxFiles: 3 });
  await logger.info("cdp_connected", { codexVersion: "26.721.4979.0", mounted: true });
  await assert.rejects(logger.info("bad_event", { reason: { cookie: "secret" } }), /敏感日志字段/);
  await logger.close();
  const [name] = await readdir(dir);
  const text = await readFile(join(dir, name), "utf8");
  assert.match(text, /cdp_connected/);
  assert.doesNotMatch(text, /secret/);
}));

test("rejects metadata outside the approved whitelist", async () => withLogDir(async (dir) => {
  const logger = await createLogger(dir);
  await assert.rejects(logger.info("bad_event", { executablePath: "C:\\private" }), /不允许的日志字段/);
  await logger.close();
}));

test("rotates bounded JSONL files without retaining more than maxFiles", async () => withLogDir(async (dir) => {
  const logger = await createLogger(dir, { maxBytes: 80, maxFiles: 2 });
  await logger.info("cdp_connected", { message: "a".repeat(40) });
  await logger.info("cdp_connected", { message: "b".repeat(40) });
  await logger.info("cdp_connected", { message: "c".repeat(40) });
  await logger.close();
  const files = await readdir(dir);
  assert.ok(files.filter((name) => name.endsWith(".jsonl")).length <= 2);
}));

test("writeFatal contains only the Chinese user-facing message and cleanup remains usable", async () => withLogDir(async (dir) => {
  const logger = await createLogger(dir);
  await logger.writeFatal("无法连接 Codex，请检查是否已正常关闭。");
  await logger.close();
  await logger.close();
  assert.equal(await readFile(join(dir, "last-error.txt"), "utf8"), "无法连接 Codex，请检查是否已正常关闭。");
}));
