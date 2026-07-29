import test from "node:test";
import assert from "node:assert/strict";
import { buildDisplayText, mergeObservedUsage, parseResetCreditsPayload, parseUsagePayload } from "../src/usage-state.mjs";

test("parses the seven-day window and converts used to remaining", () => {
  const parsed = parseUsagePayload({ account_id: "memory-only-account", rate_limit: { primary_window: { used_percent: 34.2, limit_window_seconds: 604800, reset_at: 1785902940 }, secondary_window: { used_percent: 70, limit_window_seconds: 18000, reset_at: 1785480000 } }, rate_limit_reset_credits: { available_count: 1 } });
  assert.deepEqual(parsed, { accountKey: "memory-only-account", remainingPercent: 66, resetAtMs: 1785902940000, resetCount: 1 });
});
test("returns null instead of labeling a non-weekly window as weekly", () => assert.equal(parseUsagePayload({ rate_limit: { primary_window: { used_percent: 40, limit_window_seconds: 18000, reset_at: 1785480000 } } }), null));
test("clamps the computed remaining percentage", () => {
  const payload = (usedPercent) => ({ rate_limit: { primary_window: { used_percent: usedPercent, limit_window_seconds: 604800, reset_at: 1785902940 } } });
  assert.equal(parseUsagePayload(payload(150)).remainingPercent, 0); assert.equal(parseUsagePayload(payload(-10)).remainingPercent, 100);
});
test("keeps a missing reset count unknown instead of treating it as zero", () => assert.equal(parseUsagePayload({ rate_limit: { primary_window: { used_percent: 34, limit_window_seconds: 604800, reset_at: 1785902940 } } }).resetCount, null));
test("finds the earliest future expiry among available reset credits", () => {
  const nowMs = Date.parse("2026-07-29T00:00:00+08:00"); const expiresAtMs = parseResetCreditsPayload({ credits: [{ status: "used", expires_at: "2026-07-30T00:00:00+08:00" }, { status: "available", expires_at: "2026-08-03T00:00:00+08:00" }, { status: "available", expires_at: "2026-08-01T00:00:00+08:00" }, { status: "available", expires_at: "2026-07-28T00:00:00+08:00" }] }, nowMs);
  assert.equal(expiresAtMs, Date.parse("2026-08-01T00:00:00+08:00"));
});
test("returns no expiry when available credits have no valid future date", () => {
  const nowMs = Date.parse("2026-07-29T00:00:00+08:00"); assert.equal(parseResetCreditsPayload({ credits: [{ status: "available", expires_at: "invalid" }, { status: "available", expires_at: "2026-07-28T00:00:00+08:00" }] }, nowMs), null);
});
test("formats approved full and compact copy and hides resets at zero", () => {
  const options = { locale: "zh-CN", timeZone: "Asia/Shanghai" }; const base = { accountKey: null, remainingPercent: 66, resetAtMs: Date.parse("2026-08-05T12:09:00+08:00"), resetCount: 1, expiresAtMs: Date.parse("2026-08-01T00:00:00+08:00") };
  assert.deepEqual(buildDisplayText(base, options), { fullText: "用量：每周 66%（8 月 5 日 12:09 重置）｜剩余重置次数：1（最近一次重置到期：8 月 1 日）", compactText: "周 66%｜↻（1）" });
  assert.deepEqual(buildDisplayText({ ...base, resetCount: 0 }, options), { fullText: "用量：每周 66%（8 月 5 日 12:09 重置）", compactText: "周 66%" });
});
test("keeps a positive reset count when expiry detail has not been observed", () => {
  const text = buildDisplayText({ accountKey: null, remainingPercent: 66, resetAtMs: Date.parse("2026-08-05T12:09:00+08:00"), resetCount: 1, expiresAtMs: null }, { locale: "zh-CN", timeZone: "Asia/Shanghai" }); assert.equal(text.fullText, "用量：每周 66%（8 月 5 日 12:09 重置）｜剩余重置次数：1");
});
test("clears expiry when the account changes", () => {
  const previous = { accountKey: "account-a", remainingPercent: 66, resetAtMs: 1, resetCount: 1, expiresAtMs: 2 }; const next = mergeObservedUsage(previous, { type: "usage", value: { accountKey: "account-b", remainingPercent: 90, resetAtMs: 3, resetCount: 2 } }); assert.equal(next.accountKey, "account-b"); assert.equal(next.expiresAtMs, null);
});
