import { appendFile, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const ALLOWED_KEYS = new Set(["codexVersion", "event", "message", "mode", "mounted", "port", "reason", "timestamp"]);
const SENSITIVE_KEY = /(account|authorization|body|cookie|header|token|user|command|env|payload)/i;

function validateMetadata(value) {
  if (Array.isArray(value)) return value.forEach(validateMetadata);
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) throw new Error("敏感日志字段被拒绝");
    if (!ALLOWED_KEYS.has(key)) throw new Error("不允许的日志字段");
    validateMetadata(child);
  }
}

export async function createLogger(logDir, { maxBytes = 1024 * 1024, maxFiles = 5 } = {}) {
  await mkdir(logDir, { recursive: true });
  let sequence = 0;
  let closed = false;
  const nextPath = () => path.join(logDir, `launcher-${Date.now()}-${sequence++}.jsonl`);
  let activePath = nextPath();

  async function rotateIfNeeded(bytes) {
    let size = 0;
    try { size = (await stat(activePath)).size; } catch { /* 新文件 */ }
    if (size && size + bytes > maxBytes) activePath = nextPath();
    const files = (await readdir(logDir)).filter((name) => /^launcher-.*\.jsonl$/.test(name)).sort();
    while (files.length >= maxFiles) await rm(path.join(logDir, files.shift()), { force: true });
  }

  return {
    async info(event, metadata = {}) {
      if (closed) throw new Error("日志已关闭");
      validateMetadata(metadata);
      const line = `${JSON.stringify({ timestamp: new Date().toISOString(), event, ...metadata })}\n`;
      await rotateIfNeeded(Buffer.byteLength(line));
      await appendFile(activePath, line, "utf8");
    },
    async writeFatal(message) {
      if (typeof message !== "string") throw new Error("错误提示必须是中文文本");
      await writeFile(path.join(logDir, "last-error.txt"), message, "utf8");
    },
    async close() { closed = true; },
  };
}
