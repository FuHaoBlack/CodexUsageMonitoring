export const WEEK_SECONDS = 7 * 24 * 60 * 60;

function asFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function findWeeklyWindow(rateLimit) {
  return [rateLimit?.primary_window, rateLimit?.secondary_window]
    .filter(Boolean)
    .find((window) => {
      const seconds = asFiniteNumber(window.limit_window_seconds);
      return seconds !== null && Math.abs(seconds - WEEK_SECONDS) <= 60;
    }) ?? null;
}

export function parseUsagePayload(payload) {
  const weekly = findWeeklyWindow(payload?.rate_limit);
  const used = asFiniteNumber(weekly?.used_percent);
  const resetAtSeconds = asFiniteNumber(weekly?.reset_at);
  if (used === null || resetAtSeconds === null) return null;

  const rawCount = payload?.rate_limit_reset_credits?.available_count;
  const resetCount = Number.isInteger(rawCount) && rawCount >= 0 ? rawCount : null;

  return {
    accountKey: typeof payload?.account_id === "string" ? payload.account_id : null,
    remainingPercent: Math.min(Math.max(Math.round(100 - used), 0), 100),
    resetAtMs: resetAtSeconds * 1000,
    resetCount,
  };
}

export function parseResetCreditsPayload(payload, nowMs) {
  const expiresAtMs = payload?.credits
    ?.filter((credit) => credit?.status === "available")
    .map((credit) => Date.parse(credit.expires_at))
    .filter((expiresAt) => Number.isFinite(expiresAt) && expiresAt > nowMs) ?? [];
  return expiresAtMs.length ? Math.min(...expiresAtMs) : null;
}

export function mergeObservedUsage(current, event) {
  if (event?.type === "clear") return null;
  if (event?.type === "usage") {
    const accountChanged = current?.accountKey !== null
      && event.value?.accountKey !== null
      && current?.accountKey !== event.value?.accountKey;
    return { ...event.value, expiresAtMs: accountChanged ? null : (current?.expiresAtMs ?? null) };
  }
  if (event?.type === "expiry") {
    return current ? { ...current, expiresAtMs: event.value } : null;
  }
  return current;
}

function dateParts(timestamp, locale, timeZone, includeTime) {
  const formatter = new Intl.DateTimeFormat(locale, {
    timeZone,
    month: "numeric",
    day: "numeric",
    ...(includeTime ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" } : {}),
  });
  const parts = Object.fromEntries(formatter.formatToParts(timestamp).map(({ type, value }) => [type, value]));
  return includeTime
    ? `${parts.month} 月 ${parts.day} 日 ${parts.hour}:${parts.minute}`
    : `${parts.month} 月 ${parts.day} 日`;
}

export function buildDisplayText(snapshot, options = {}) {
  const { locale = "zh-CN", timeZone = "Asia/Shanghai" } = options;
  const resetAt = dateParts(snapshot.resetAtMs, locale, timeZone, true);
  const knownPositiveCount = Number.isInteger(snapshot.resetCount) && snapshot.resetCount > 0;
  let fullText = `用量：每周 ${snapshot.remainingPercent}%（${resetAt} 重置）`;
  let compactText = `周 ${snapshot.remainingPercent}%`;
  if (knownPositiveCount) {
    fullText += `｜剩余重置次数：${snapshot.resetCount}`;
    compactText += `｜↻（${snapshot.resetCount}）`;
    if (snapshot.expiresAtMs !== null) {
      fullText += `（最近一次重置到期：${dateParts(snapshot.expiresAtMs, locale, timeZone, false)}）`;
    }
  }
  return { fullText, compactText };
}
