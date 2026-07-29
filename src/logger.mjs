import { appendFile, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const ALLOWED_KEYS = new Set(["codexVersion", "event", "message", "mode", "mounted", "port", "reason", "timestamp"]);
const SENSITIVE = /(account|authorization|body|cookie|header|token|user|command|env|payload|bearer|\bsk-[A-Za-z0-9_-]{12,}\b)/i;
const MAX_FATAL_LENGTH = 500;

function validateMetadata(value, seen = new Set(), nested = false) {
  if (typeof value === "string" && SENSITIVE.test(value)) throw new Error("敏感日志内容被拒绝");
  if (Array.isArray(value)) return value.forEach((item) => validateMetadata(item, seen, true));
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) throw new Error("循环日志数据被拒绝");
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE.test(key)) throw new Error("敏感日志字段被拒绝");
    if (!ALLOWED_KEYS.has(key)) throw new Error("不允许的日志字段");
    if (!nested && (key === "event" || key === "timestamp")) throw new Error("日志受控字段不可覆盖");
    validateMetadata(child, seen, true);
  }
  seen.delete(value);
}

export async function createLogger(logDir, { maxBytes = 1024 * 1024, maxFiles = 5, appendFile: append = appendFile } = {}) {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) throw new Error("maxBytes 必须为正整数");
  if (!Number.isInteger(maxFiles) || maxFiles <= 0) throw new Error("maxFiles 必须为正整数");
  await mkdir(logDir, { recursive: true });
  let sequence = 0;
  let accepting = true;
  let queue = Promise.resolve();
  const nextPath = () => path.join(logDir, `launcher-${Date.now()}-${sequence++}.jsonl`);
  let activePath = nextPath();

  async function rotateIfNeeded(bytes) {
    let size = 0;
    try { size = (await stat(activePath)).size; } catch { /* 新文件 */ }
    if (size && size + bytes > maxBytes) activePath = nextPath();
    const files = (await readdir(logDir)).filter((name) => /^launcher-.*\.jsonl$/.test(name)).sort();
    while (files.length >= maxFiles) await rm(path.join(logDir, files.shift()), { force: true });
  }

  function enqueue(operation) {
    const pending = queue.then(operation);
    queue = pending.catch(() => {});
    return pending;
  }

  return {
    info(event, metadata = {}) {
      if (!accepting) return Promise.reject(new Error("日志已关闭"));
      if (typeof event !== "string" || !/^[a-z]+(?:_[a-z0-9]+)*$/.test(event) || SENSITIVE.test(event)) return Promise.reject(new Error("日志事件不安全"));
      try {
      validateMetadata(metadata);
      const line = `${JSON.stringify({ timestamp: new Date().toISOString(), event, ...metadata })}\n`;
      if (Buffer.byteLength(line) > maxBytes) return Promise.reject(new Error("单行日志超过 maxBytes"));
      return enqueue(async () => {
        await rotateIfNeeded(Buffer.byteLength(line));
        await append(activePath, line, "utf8");
      });
      } catch (error) { return Promise.reject(error); }
    },
    writeFatal(message) {
      if (!accepting) return Promise.reject(new Error("日志已关闭"));
      if (typeof message !== "string" || message.length > MAX_FATAL_LENGTH || /[\r\n\x00-\x1f]/.test(message)) return Promise.reject(new Error("错误提示必须是单行文本"));
      if (!/\p{Script=Han}/u.test(message)) return Promise.reject(new Error("错误提示必须包含中文"));
      if (SENSITIVE.test(message)) return Promise.reject(new Error("错误提示包含敏感内容"));
      return enqueue(() => writeFile(path.join(logDir, "last-error.txt"), message, "utf8"));
    },
    close() { accepting = false; return queue; },
  };
}
