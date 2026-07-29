import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, FATAL_MESSAGES } from "../src/logger.mjs";

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

test("requires info metadata to be a plain object", async () => withLogDir(async (dir) => {
  const logger = await createLogger(dir);
  for (const metadata of [null, [], "text", new Date()]) {
    await assert.rejects(logger.info("safe_event", metadata), /元数据/);
  }
  await logger.close();
}));

test("rejects unsafe events, sensitive values, protected-field overrides, and circular metadata", async () => withLogDir(async (dir) => {
  const logger = await createLogger(dir);
  for (const [event, metadata] of [
    ["bad-event", {}],
    ["token_event", {}],
    ["safe_event", { message: "Bearer abc" }],
    ["safe_event", { event: "override" }],
    ["safe_event", { timestamp: "override" }],
  ]) await assert.rejects(logger.info(event, metadata), /日志/);
  const circular = { reason: {} }; circular.reason.reason = circular;
  await assert.rejects(logger.info("safe_event", circular), /循环/);
  await logger.close();
}));

test("rotates bounded JSONL files without retaining more than maxFiles", async () => withLogDir(async (dir) => {
  const logger = await createLogger(dir, { maxBytes: 180, maxFiles: 2 });
  await logger.info("cdp_connected", { message: "a".repeat(40) });
  await logger.info("cdp_connected", { message: "b".repeat(40) });
  await logger.info("cdp_connected", { message: "c".repeat(40) });
  await logger.close();
  const files = await readdir(dir);
  assert.ok(files.filter((name) => name.endsWith(".jsonl")).length <= 2);
}));

test("validates positive logger limits and rejects a line exceeding maxBytes", async () => withLogDir(async (dir) => {
  await assert.rejects(createLogger(dir, { maxBytes: 0 }), /maxBytes/);
  await assert.rejects(createLogger(dir, { maxFiles: 0 }), /maxFiles/);
  const logger = await createLogger(dir, { maxBytes: 40, maxFiles: 2 });
  await assert.rejects(logger.info("safe_event", { message: "a".repeat(200) }), /单行日志/);
  await logger.close();
}));

test("serializes concurrent writes and close waits for an already-started write", async () => withLogDir(async (dir) => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let appends = 0;
  const logger = await createLogger(dir, {
    maxBytes: 180, maxFiles: 2,
    appendFile: async (...args) => { appends += 1; if (appends === 1) await blocked; return (await import("node:fs/promises")).appendFile(...args); },
  });
  const writing = logger.info("safe_event", { message: "first" });
  const closing = logger.close();
  await assert.rejects(logger.info("safe_event", { message: "late" }), /日志已关闭/);
  release();
  await Promise.all([writing, closing]);
  const parallel = await createLogger(dir, { maxBytes: 180, maxFiles: 2 });
  await Promise.all(Array.from({ length: 20 }, (_, index) => parallel.info("safe_event", { message: `line_${index}` })));
  await parallel.close();
  assert.ok((await readdir(dir)).filter((name) => name.endsWith(".jsonl")).length <= 2);
}));

test("writeFatal contains only the Chinese user-facing message and cleanup remains usable", async () => withLogDir(async (dir) => {
  const logger = await createLogger(dir);
  await assert.rejects(logger.writeFatal("English failure"), /中文/);
  await assert.rejects(logger.writeFatal("错误：raw English exception"), /受控/);
  await assert.rejects(logger.writeFatal("令牌 Bearer abc"), /敏感/);
  await assert.rejects(logger.writeFatal("无法连接 sk-abcdefghijklmnop"), /敏感/);
  await assert.rejects(logger.writeFatal("无法连接\nCodex"), /单行/);
  for (const message of Object.values(FATAL_MESSAGES)) await logger.writeFatal(message);
  await logger.close();
  await logger.close();
  assert.equal(await readFile(join(dir, "last-error.txt"), "utf8"), FATAL_MESSAGES.cdpConnectionFailed);
}));
