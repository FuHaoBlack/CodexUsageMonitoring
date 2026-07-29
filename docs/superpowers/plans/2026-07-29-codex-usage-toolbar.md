# Codex Usage Toolbar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a reversible Windows launcher that starts the official Codex Desktop with loopback-only CDP, observes Codex's own quota responses, and displays the approved full or compact weekly remaining-usage text in the renderer toolbar.

**Architecture:** A dependency-free Node.js 24 helper launches the latest installed AppX `Codex.exe`, connects to its loopback CDP endpoint, parses only existing official response events, and sends a sanitized in-memory snapshot to a fail-open DOM injection. PowerShell scripts install a separate Start Menu entry under the current user and remove only the helper's own files.

**Tech Stack:** Windows 11, PowerShell 7, Node.js 24 built-ins (`node:test`, `assert`, `fs`, `net`, `child_process`, global `fetch`, global `WebSocket`), Chrome DevTools Protocol, plain JavaScript and DOM APIs.

**Approved Design:** `docs/superpowers/specs/2026-07-29-codex-usage-toolbar-design.md`

## Global Constraints

- Target current Codex Desktop version for first validation: `26.721.4979.0`.
- Do not modify `C:\Program Files\WindowsApps`, Codex signatures, settings, tasks, account data, or `app.asar`.
- Do not issue requests to `/wham/usage` or `/wham/rate-limit-reset-credits`; observe only responses initiated by Codex.
- Do not create an independent quota refresh timer.
- Bind CDP only to `127.0.0.1` on a random free port.
- Keep raw response bodies, access tokens, cookies, request headers, and account identifiers in memory only; never log them.
- Display weekly remaining percentage as `clamp(round(100 - used_percent), 0, 100)`.
- Display full text when it fits and compact text otherwise; width observation must not trigger network activity.
- Hide all reset-related text when reset count is exactly `0`.
- Omit the reset expiry date when Codex has not itself provided reset-credit details.
- Keep the injected component non-interactive and fail open when no trustworthy toolbar anchor exists.
- Provide a separate `Codex（用量显示）` Start Menu shortcut; keep the official Codex entry unchanged.
- Do not configure Windows-login startup.
- Exit the helper after both the launched Codex main process has ended and the CDP browser endpoint is unavailable; renderer reloads must reconnect instead of exiting.
- Use clear Chinese UI and operational messages.
- Add only focused tests in this project; do not add a third-party test framework or a separate test scaffold.
- Repository: `FuHaoBlack/CodexUsageMonitoring`; local root: `D:\自研软件\Codex用量监控插件`.
- Implement on isolated branch `agent/codex-usage-toolbar` in a Git worktree under the repository's ignored `.worktrees` directory.
- Commit each reviewed task with a concise Chinese commit message; stage only files named by that task.
- Push the feature branch to `origin` and create a draft pull request targeting `main` after the final whole-branch review.
- Do not claim completion until Task 9 finishes the 重启后的真实验收; offline checks and installation alone are not live UI acceptance.

---

## File Structure

Create the implementation at the repository root:

```text

├── README.md
├── src/
│   ├── cdp-session.mjs
│   ├── inject.js
│   ├── injection-controller.mjs
│   ├── launcher.mjs
│   ├── logger.mjs
│   ├── usage-observer.mjs
│   ├── usage-state.mjs
│   └── windows-codex.mjs
├── scripts/
│   ├── install.ps1
│   ├── start.ps1
│   ├── uninstall.ps1
│   └── verify.ps1
└── tests/
    ├── cdp-session.test.mjs
    ├── injection-contract.test.mjs
    ├── logger.test.mjs
    ├── source-policy.test.mjs
    ├── usage-observer.test.mjs
    ├── usage-state.test.mjs
    └── windows-codex.test.mjs
```

Responsibilities:

- `usage-state.mjs`: Pure parsing, merging, date formatting, and approved full/compact copy.
- `cdp-session.mjs`: Minimal request/response/event CDP transport over an injected WebSocket.
- `usage-observer.mjs`: Exact response URL filtering, body retrieval, decoding, and parser dispatch.
- `inject.js`: Self-contained renderer-side DOM component with anchor scoring, theme inheritance, mutation recovery, and responsive text.
- `injection-controller.mjs`: Loads `inject.js`, evaluates it in CDP, and sends sanitized snapshots.
- `windows-codex.mjs`: AppX discovery, existing-process checks, free-port allocation, Codex launch, and lifecycle probes.
- `logger.mjs`: Redacted structured log events, bounded rotation, and fatal-error file handling.
- `launcher.mjs`: Wires lifecycle, CDP discovery, response observation, state clearing, reinjection, and shutdown.
- PowerShell scripts: Install, one-click start, verify, and uninstall without administrator rights.
- Tests: Node built-in focused tests only.

---

### Task 1: Pure Usage State and Approved Display Copy

**Files:**
- Create: `src/usage-state.mjs`
- Create: `tests/usage-state.test.mjs`

**Interfaces:**
- Produces:
  - `parseUsagePayload(payload: unknown): ParsedUsage | null`
  - `parseResetCreditsPayload(payload: unknown, nowMs: number): number | null`
  - `mergeObservedUsage(current: UsageSnapshot | null, event: UsageEvent): UsageSnapshot | null`
  - `buildDisplayText(snapshot: UsageSnapshot, options?: { locale?: string, timeZone?: string }): { fullText: string, compactText: string }`
- `ParsedUsage` shape:

```js
{
  accountKey: string | null,
  remainingPercent: number,
  resetAtMs: number,
  resetCount: number | null
}
```

- `UsageSnapshot` adds `expiresAtMs: number | null`.
- Consumed later by `usage-observer.mjs`, `injection-controller.mjs`, and `launcher.mjs`.

- [ ] **Step 1: Write focused failing tests for weekly selection, remaining percentage, and reset rules**

Create `tests/usage-state.test.mjs` with Node's built-in test runner:

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDisplayText,
  mergeObservedUsage,
  parseResetCreditsPayload,
  parseUsagePayload,
} from "../src/usage-state.mjs";

test("parses the seven-day window and converts used to remaining", () => {
  const parsed = parseUsagePayload({
    account_id: "memory-only-account",
    rate_limit: {
      primary_window: {
        used_percent: 34.2,
        limit_window_seconds: 604800,
        reset_at: 1785902940,
      },
      secondary_window: {
        used_percent: 70,
        limit_window_seconds: 18000,
        reset_at: 1785480000,
      },
    },
    rate_limit_reset_credits: { available_count: 1 },
  });

  assert.deepEqual(parsed, {
    accountKey: "memory-only-account",
    remainingPercent: 66,
    resetAtMs: 1785902940000,
    resetCount: 1,
  });
});

test("returns null instead of labeling a non-weekly window as weekly", () => {
  assert.equal(parseUsagePayload({
    rate_limit: {
      primary_window: {
        used_percent: 40,
        limit_window_seconds: 18000,
        reset_at: 1785480000,
      },
    },
  }), null);
});

test("clamps the computed remaining percentage", () => {
  const payload = (usedPercent) => ({
    rate_limit: {
      primary_window: {
        used_percent: usedPercent,
        limit_window_seconds: 604800,
        reset_at: 1785902940,
      },
    },
  });

  assert.equal(parseUsagePayload(payload(150)).remainingPercent, 0);
  assert.equal(parseUsagePayload(payload(-10)).remainingPercent, 100);
});

test("keeps a missing reset count unknown instead of treating it as zero", () => {
  const parsed = parseUsagePayload({
    rate_limit: {
      primary_window: {
        used_percent: 34,
        limit_window_seconds: 604800,
        reset_at: 1785902940,
      },
    },
  });

  assert.equal(parsed.resetCount, null);
});

test("finds the earliest future expiry among available reset credits", () => {
  const nowMs = Date.parse("2026-07-29T00:00:00+08:00");
  const expiresAtMs = parseResetCreditsPayload({
    credits: [
      { status: "used", expires_at: "2026-07-30T00:00:00+08:00" },
      { status: "available", expires_at: "2026-08-03T00:00:00+08:00" },
      { status: "available", expires_at: "2026-08-01T00:00:00+08:00" },
      { status: "available", expires_at: "2026-07-28T00:00:00+08:00" },
    ],
  }, nowMs);

  assert.equal(expiresAtMs, Date.parse("2026-08-01T00:00:00+08:00"));
});

test("returns no expiry when available credits have no valid future date", () => {
  const nowMs = Date.parse("2026-07-29T00:00:00+08:00");
  assert.equal(parseResetCreditsPayload({
    credits: [
      { status: "available", expires_at: "invalid" },
      { status: "available", expires_at: "2026-07-28T00:00:00+08:00" },
    ],
  }, nowMs), null);
});

test("formats approved full and compact copy and hides resets at zero", () => {
  const options = { locale: "zh-CN", timeZone: "Asia/Shanghai" };
  const base = {
    accountKey: null,
    remainingPercent: 66,
    resetAtMs: Date.parse("2026-08-05T12:09:00+08:00"),
    resetCount: 1,
    expiresAtMs: Date.parse("2026-08-01T00:00:00+08:00"),
  };

  assert.deepEqual(buildDisplayText(base, options), {
    fullText: "用量：每周 66%（8 月 5 日 12:09 重置）｜剩余重置次数：1（最近一次重置到期：8 月 1 日）",
    compactText: "周 66%｜↻（1）",
  });

  assert.deepEqual(buildDisplayText({ ...base, resetCount: 0 }, options), {
    fullText: "用量：每周 66%（8 月 5 日 12:09 重置）",
    compactText: "周 66%",
  });
});

test("keeps a positive reset count when expiry detail has not been observed", () => {
  const text = buildDisplayText({
    accountKey: null,
    remainingPercent: 66,
    resetAtMs: Date.parse("2026-08-05T12:09:00+08:00"),
    resetCount: 1,
    expiresAtMs: null,
  }, { locale: "zh-CN", timeZone: "Asia/Shanghai" });

  assert.equal(
    text.fullText,
    "用量：每周 66%（8 月 5 日 12:09 重置）｜剩余重置次数：1",
  );
});

test("clears expiry when the account changes", () => {
  const previous = {
    accountKey: "account-a",
    remainingPercent: 66,
    resetAtMs: 1,
    resetCount: 1,
    expiresAtMs: 2,
  };

  const next = mergeObservedUsage(previous, {
    type: "usage",
    value: {
      accountKey: "account-b",
      remainingPercent: 90,
      resetAtMs: 3,
      resetCount: 2,
    },
  });

  assert.equal(next.accountKey, "account-b");
  assert.equal(next.expiresAtMs, null);
});
```

- [ ] **Step 2: Run the tests and verify the module does not exist yet**

Run:

```powershell
node --test .\tests\usage-state.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/usage-state.mjs`.

- [ ] **Step 3: Implement the pure parser and formatter**

Implement these rules in `src/usage-state.mjs`:

```js
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
```

Also implement:

- `parseResetCreditsPayload`: filter `status === "available"`, parse valid future `expires_at`, return the minimum timestamp or `null`.
- `mergeObservedUsage`:
  - usage event replaces weekly fields;
  - clear `expiresAtMs` when non-null account keys differ;
  - expiry event updates only `expiresAtMs`;
  - clear event returns `null`.
- `buildDisplayText`:
  - use `Intl.DateTimeFormat`;
  - use Chinese month/day text with spaces exactly as approved;
  - show reset count only when it is a known positive integer;
  - hide reset copy only when the known count is exactly zero;
  - omit expiry when it is `null`.

- [ ] **Step 4: Run focused tests**

Run:

```powershell
node --test .\tests\usage-state.test.mjs
```

Expected: all tests PASS.

- [ ] **Step 5: Record hashes and commit Task 1**

Run:

```powershell
Get-FileHash .\src\usage-state.mjs, .\tests\usage-state.test.mjs -Algorithm SHA256
git add -- src/usage-state.mjs tests/usage-state.test.mjs
git commit -m "实现用量解析与展示文案"
```

Record the two hashes and commit SHA in the execution ledger.

---

### Task 2: Minimal CDP Session and Official-Response Observer

**Files:**
- Create: `src/cdp-session.mjs`
- Create: `src/usage-observer.mjs`
- Create: `tests/cdp-session.test.mjs`
- Create: `tests/usage-observer.test.mjs`

**Interfaces:**
- Produces:
  - `class CdpSession`
  - `new CdpSession(socket, { onEvent, onClose })`
  - `session.send(method: string, params?: object): Promise<unknown>`
  - `session.close(): void`
  - `class UsageObserver`
  - `new UsageObserver(session, { onUsagePayload, onResetCreditsPayload, onError })`
  - `observer.start(): Promise<void>`
  - `observer.handleEvent(method: string, params: object): Promise<void>`
- Dispatches raw JSON payloads to callbacks. `launcher.mjs` in Task 5 consumes the parsers from Task 1 after receiving those callbacks.
- Consumed by `launcher.mjs` in Task 5.

- [ ] **Step 1: Write failing CDP transport tests with a fake socket**

Create `tests/cdp-session.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { CdpSession } from "../src/cdp-session.mjs";

class FakeSocket extends EventEmitter {
  sent = [];
  send(value) { this.sent.push(JSON.parse(value)); }
  close() { this.emit("close"); }
}

test("matches a CDP response to its pending request", async () => {
  const socket = new FakeSocket();
  const session = new CdpSession(socket, {});
  const pending = session.send("Network.enable");
  const request = socket.sent[0];

  socket.emit("message", JSON.stringify({ id: request.id, result: {} }));
  assert.deepEqual(await pending, {});
});

test("forwards CDP events without treating them as responses", () => {
  const socket = new FakeSocket();
  const events = [];
  new CdpSession(socket, { onEvent: (method, params) => events.push({ method, params }) });

  socket.emit("message", JSON.stringify({
    method: "Network.responseReceived",
    params: { requestId: "r1" },
  }));

  assert.deepEqual(events, [{
    method: "Network.responseReceived",
    params: { requestId: "r1" },
  }]);
});
```

- [ ] **Step 2: Write failing observer tests that reject non-official and non-GET traffic**

Create `tests/usage-observer.test.mjs` using a fake session whose `send` method returns response bodies:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { UsageObserver } from "../src/usage-observer.mjs";

function responseEvent(url, requestId = "r1", status = 200) {
  return {
    requestId,
    type: "Fetch",
    response: { url, status },
  };
}

test("reads an existing official usage response body", async () => {
  const calls = [];
  const payloads = [];
  const session = {
    async send(method, params) {
      calls.push({ method, params });
      if (method === "Network.getResponseBody") {
        return { body: JSON.stringify({ rate_limit: {} }), base64Encoded: false };
      }
      return {};
    },
  };
  const observer = new UsageObserver(session, {
    onUsagePayload: (value) => payloads.push(value),
    onResetCreditsPayload: () => {},
    onError: assert.fail,
  });

  await observer.handleEvent("Network.requestWillBeSent", {
    requestId: "r1",
    request: {
      method: "GET",
      url: "https://chatgpt.com/backend-api/wham/usage",
    },
  });
  await observer.handleEvent(
    "Network.responseReceived",
    responseEvent("https://chatgpt.com/backend-api/wham/usage"),
  );

  assert.equal(payloads.length, 1);
  assert.deepEqual(calls.at(-1), {
    method: "Network.getResponseBody",
    params: { requestId: "r1" },
  });
});

test("ignores lookalike hosts and unrelated paths", async () => {
  let bodyReads = 0;
  const observer = new UsageObserver({
    async send() { bodyReads += 1; return {}; },
  }, {
    onUsagePayload: assert.fail,
    onResetCreditsPayload: assert.fail,
    onError: assert.fail,
  });

  await observer.handleEvent("Network.requestWillBeSent", {
    requestId: "r1",
    request: {
      method: "GET",
      url: "https://example.com/wham/usage",
    },
  });
  await observer.handleEvent(
    "Network.responseReceived",
    responseEvent("https://example.com/wham/usage"),
  );
  await observer.handleEvent("Network.requestWillBeSent", {
    requestId: "r2",
    request: {
      method: "GET",
      url: "https://chatgpt.com/backend-api/wham/usage/credit-usage-events",
    },
  });
  await observer.handleEvent(
    "Network.responseReceived",
    responseEvent("https://chatgpt.com/backend-api/wham/usage/credit-usage-events", "r2"),
  );

  assert.equal(bodyReads, 0);
});

test("ignores POST even when the URL is an allowed usage endpoint", async () => {
  let bodyReads = 0;
  const observer = new UsageObserver({
    async send() { bodyReads += 1; return {}; },
  }, {
    onUsagePayload: assert.fail,
    onResetCreditsPayload: assert.fail,
    onError: assert.fail,
  });

  await observer.handleEvent("Network.requestWillBeSent", {
    requestId: "post-1",
    request: {
      method: "POST",
      url: "https://chatgpt.com/backend-api/wham/usage",
    },
  });
  await observer.handleEvent(
    "Network.responseReceived",
    responseEvent("https://chatgpt.com/backend-api/wham/usage", "post-1"),
  );

  assert.equal(bodyReads, 0);
});
```

- [ ] **Step 3: Run both tests and verify missing modules**

Run:

```powershell
node --test .\tests\cdp-session.test.mjs .\tests\usage-observer.test.mjs
```

Expected: FAIL with module-not-found errors.

- [ ] **Step 4: Implement `CdpSession`**

Implementation requirements:

```js
export class CdpSession {
  #nextId = 1;
  #pending = new Map();

  constructor(socket, { onEvent = () => {}, onClose = () => {} } = {}) {
    this.socket = socket;
    this.onEvent = onEvent;
    socket.addEventListener?.("message", (event) => this.#receive(event.data));
    socket.addEventListener?.("close", onClose);
    socket.on?.("message", (data) => this.#receive(data));
    socket.on?.("close", onClose);
  }

  send(method, params = {}) {
    const id = this.#nextId++;
    const promise = new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    return promise;
  }
}
```

Complete `#receive` so that:

- response IDs resolve or reject exactly one pending promise;
- events call `onEvent(method, params)`;
- malformed messages are ignored without crashing;
- `close()` rejects pending promises with a clear error and closes the socket.

- [ ] **Step 5: Implement `UsageObserver`**

Use exact URL parsing:

```js
const ALLOWED_HOST = "chatgpt.com";
const USAGE_PATH = "/backend-api/wham/usage";
const RESET_CREDITS_PATH = "/backend-api/wham/rate-limit-reset-credits";
```

On `start()`, call only:

```js
await session.send("Network.enable");
```

On `Network.responseReceived`:

1. Track `Network.requestWillBeSent` as `requestId -> { method, url }`.
2. Require the tracked request method to be exactly `GET`.
3. Require response status `200`.
4. Parse the tracked request URL and `response.url` with `new URL`; require them to identify the same allowed endpoint.
5. Require HTTPS, hostname `chatgpt.com`, and exact pathname match.
6. Call `Network.getResponseBody` for that already completed request ID.
7. Delete the tracked request entry after response handling or loading failure to prevent unbounded memory growth.
8. Decode base64 when required.
9. Parse JSON and dispatch to the matching callback.
10. Never call `fetch`, `XMLHttpRequest`, or a Wham endpoint.

- [ ] **Step 6: Run Task 2 tests**

Run:

```powershell
node --test .\tests\cdp-session.test.mjs .\tests\usage-observer.test.mjs
```

Expected: all tests PASS.

- [ ] **Step 7: Record hashes and commit Task 2**

Run:

```powershell
Get-FileHash .\src\cdp-session.mjs, .\src\usage-observer.mjs, .\tests\cdp-session.test.mjs, .\tests\usage-observer.test.mjs -Algorithm SHA256
git add -- src/cdp-session.mjs src/usage-observer.mjs tests/cdp-session.test.mjs tests/usage-observer.test.mjs
git commit -m "实现 Codex 用量响应旁听"
```

Record hashes and commit SHA in the execution ledger.

---

### Task 3: Fail-Open Renderer Toolbar Injection

**Files:**
- Create: `src/inject.js`
- Create: `src/injection-controller.mjs`
- Create: `tests/injection-contract.test.mjs`

**Interfaces:**
- Renderer global:
  - `window.__codexUsageToolbarV1.update({ fullText, compactText }): { mounted: boolean, mode: "full" | "compact" | null }`
  - `window.__codexUsageToolbarV1.clear(): void`
  - `window.__codexUsageToolbarV1.destroy(): void`
  - `window.__codexUsageToolbarV1.status(): { mounted: boolean, mode: string | null }`
- Node controller:
  - `createInjectionController(session, injectSource, logger)`
  - `.install(): Promise<{ mounted: boolean, mode: string | null }>`
  - `.update(displayText): Promise<{ mounted: boolean, mode: string | null }>`
  - `.clear(): Promise<void>`
- Consumes display text from Task 1 and `CdpSession` from Task 2.
- Consumed by `launcher.mjs` in Task 5.

- [ ] **Step 1: Write the failing injection contract test**

Create `tests/injection-contract.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("renderer injection is non-networked, non-interactive, and uniquely marked", async () => {
  const source = await readFile(
    new URL("../src/inject.js", import.meta.url),
    "utf8",
  );

  assert.match(source, /data-codex-usage-toolbar/);
  assert.match(source, /__codexUsageToolbarV1/);
  assert.match(source, /ResizeObserver/);
  assert.match(source, /MutationObserver/);
  assert.match(source, /pointer-events:\s*none/);
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /XMLHttpRequest/);
  assert.doesNotMatch(source, /\/wham\//);
  assert.doesNotMatch(source, /addEventListener\s*\(\s*["']click/);
});
```

- [ ] **Step 2: Run the contract test and verify failure**

Run:

```powershell
node --test .\tests\injection-contract.test.mjs
```

Expected: FAIL because `src/inject.js` does not exist.

- [ ] **Step 3: Implement the self-contained injection**

Create `src/inject.js` as one idempotent IIFE.

Required anchor algorithm:

1. Collect visible candidates from `header`, `[role="banner"]`, and elements whose computed `-webkit-app-region` is `drag`.
2. Keep candidates whose bounding rectangle:
   - begins in the top `96px` of the renderer viewport;
   - has height from `28px` through `80px`;
   - has width at least `50%` of the viewport;
   - is not inside an `aside` or navigation sidebar.
3. Score each candidate:
   - `+4` for `header` or `role=banner`;
   - `+3` for flex or grid layout;
   - `+2` when it contains at least one visible button;
   - `+2` when its right edge is within `24px` of the viewport right edge;
   - `-4` when more than half its area overlaps a visible sidebar.
4. Mount only when one candidate has score at least `5` and is the unique highest scorer.
5. If the score is ambiguous, remove any old component and return `{ mounted: false, mode: null }`.

The component root must:

```html
<div data-codex-usage-toolbar="v1" aria-live="polite"></div>
```

Required styles:

```css
pointer-events: none;
user-select: none;
white-space: nowrap;
flex: 0 1 auto;
min-width: 0;
font: inherit;
color: var(--text-primary, currentColor);
-webkit-app-region: drag;
```

Responsive behavior:

- Store full and compact strings in separate spans.
- Use a hidden measurement span with the full text.
- On `ResizeObserver`, choose full only when it fits without reducing the existing toolbar content below its current measured width.
- Fall back to compact when full does not fit.
- Notify no external service; only update the local DOM.

Recovery behavior:

- `MutationObserver` watches `document.body` for the chosen toolbar being replaced.
- Debounce DOM remount work with `queueMicrotask`, not a repeating timer.
- Preserve the last sanitized display strings in memory.
- `clear()` removes text and component.
- `destroy()` disconnects both observers and deletes the global.

- [ ] **Step 4: Implement the CDP-side injection controller**

`src/injection-controller.mjs` must:

1. Read `inject.js` once at startup.
2. Evaluate it using `Runtime.evaluate`.
3. Call the renderer global with JSON-serialized sanitized strings only.
4. Reinstall after `Runtime.executionContextCreated` or `Page.frameNavigated`.
5. Treat missing globals or ambiguous anchors as `mounted: false`, log a non-sensitive event, and leave Codex untouched.

Use:

```js
await session.send("Runtime.enable");
await session.send("Page.enable");
await session.send("Runtime.evaluate", {
  expression,
  awaitPromise: true,
  returnByValue: true,
});
```

- [ ] **Step 5: Run the injection contract and syntax checks**

Run:

```powershell
node --check .\src\inject.js
node --check .\src\injection-controller.mjs
node --test .\tests\injection-contract.test.mjs
```

Expected: all commands succeed.

- [ ] **Step 6: Record hashes and commit Task 3**

Run:

```powershell
Get-FileHash .\src\inject.js, .\src\injection-controller.mjs, .\tests\injection-contract.test.mjs -Algorithm SHA256
git add -- src/inject.js src/injection-controller.mjs tests/injection-contract.test.mjs
git commit -m "实现顶部用量组件注入"
```

Record hashes and commit SHA in the execution ledger.

---

### Task 4: Windows Codex Discovery, Process Lifecycle, and Redacted Logs

**Files:**
- Create: `src/windows-codex.mjs`
- Create: `src/logger.mjs`
- Create: `tests/windows-codex.test.mjs`
- Create: `tests/logger.test.mjs`

**Interfaces:**
- Produces:
  - `parseAppxDiscoveryOutput(text: string): { installLocation: string, version: string }`
  - `discoverCodexInstallation(): Promise<{ exePath: string, version: string }>`
  - `findRunningCodexMainProcesses(): Promise<Array<{ pid: number, executablePath: string | null }>>`
  - `reserveLoopbackPort(): Promise<number>`
  - `launchCodex(exePath: string, port: number): ChildProcess`
  - `waitForCdpTarget(port: number, options): Promise<{ webSocketDebuggerUrl: string }>`
  - `isCdpEndpointAlive(port: number): Promise<boolean>`
  - `createLogger(logDir: string): Promise<Logger>`
- Consumed by `launcher.mjs` and PowerShell install verification.

- [ ] **Step 1: Write failing discovery and loopback tests**

Create `tests/windows-codex.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseAppxDiscoveryOutput,
  reserveLoopbackPort,
} from "../src/windows-codex.mjs";

test("parses one selected AppX package without guessing a version path", () => {
  const parsed = parseAppxDiscoveryOutput(JSON.stringify({
    InstallLocation: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.721.4979.0_x64__2p2nqsd0c76g0",
    Version: "26.721.4979.0",
  }));

  assert.deepEqual(parsed, {
    installLocation: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.721.4979.0_x64__2p2nqsd0c76g0",
    version: "26.721.4979.0",
  });
});

test("reserves a currently free TCP port on loopback", async () => {
  const port = await reserveLoopbackPort();
  assert.ok(Number.isInteger(port));
  assert.ok(port > 0 && port <= 65535);
});
```

- [ ] **Step 2: Write failing logger redaction and rotation tests**

Create `tests/logger.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../src/logger.mjs";

test("logs approved metadata and rejects sensitive keys", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-usage-toolbar-log-"));
  const logger = await createLogger(dir, { maxBytes: 1024, maxFiles: 3 });

  await logger.info("cdp_connected", { codexVersion: "26.721.4979.0" });
  await assert.rejects(
    logger.info("bad_event", { cookie: "secret" }),
    /敏感日志字段/,
  );
  await logger.close();

  const [name] = await readdir(dir);
  const text = await readFile(join(dir, name), "utf8");
  assert.match(text, /cdp_connected/);
  assert.doesNotMatch(text, /secret/);
});
```

- [ ] **Step 3: Run tests and verify missing modules**

Run:

```powershell
node --test .\tests\windows-codex.test.mjs .\tests\logger.test.mjs
```

Expected: FAIL with module-not-found errors.

- [ ] **Step 4: Implement Windows discovery and launch**

`discoverCodexInstallation()` must execute PowerShell 7 non-interactively:

```powershell
Get-AppxPackage -Name OpenAI.Codex |
  Sort-Object Version -Descending |
  Select-Object -First 1 InstallLocation, Version |
  ConvertTo-Json -Compress
```

Then:

1. Parse JSON through `parseAppxDiscoveryOutput`.
2. Build `Join-Path $installLocation 'app\Codex.exe'`.
3. Verify it is a file before returning.

`findRunningCodexMainProcesses()` must query `Win32_Process` for `Codex.exe`, return PID and executable path, and avoid logging command lines.

`reserveLoopbackPort()` must:

```js
server.listen(0, "127.0.0.1");
```

then close the temporary server and return the assigned port.

`launchCodex()` must pass:

```text
--remote-debugging-address=127.0.0.1
--remote-debugging-port=${port}
```

Use `stdio: "ignore"`, `windowsHide: true`, and a non-detached child process.

`waitForCdpTarget()` may poll only the local discovery endpoint:

```text
http://127.0.0.1:${port}/json/list
```

Use a `250ms` retry delay, a `15s` startup deadline, and select a `type === "page"` target whose URL is not a DevTools page. This is startup connection polling, not quota polling.

- [ ] **Step 5: Implement the bounded redacted logger**

Logger rules:

- JSON Lines format.
- Allowed metadata keys:
  - `codexVersion`
  - `event`
  - `message`
  - `mode`
  - `mounted`
  - `port`
  - `reason`
  - `timestamp`
- Explicitly reject case-insensitive keys containing:
  - `account`
  - `authorization`
  - `body`
  - `cookie`
  - `header`
  - `token`
  - `user`
- Default rotation: `1 MiB` per file, at most `5` files.
- `writeFatal(message)` writes only the Chinese user-facing error to `last-error.txt`.
- `close()` flushes and closes the active stream.

- [ ] **Step 6: Run Task 4 tests**

Run:

```powershell
node --test .\tests\windows-codex.test.mjs .\tests\logger.test.mjs
```

Expected: all tests PASS.

- [ ] **Step 7: Run current-machine discovery without launching another Codex**

Add a `--discover-only` branch to `windows-codex.mjs`, then run:

```powershell
node .\src\windows-codex.mjs --discover-only
```

Expected output:

```text
Codex 26.721.4979.0
C:\Program Files\WindowsApps\OpenAI.Codex_26.721.4979.0_x64__2p2nqsd0c76g0\app\Codex.exe
```

Do not print access tokens, command lines, account IDs, or environment variables.

- [ ] **Step 8: Record hashes and commit Task 4**

Run:

```powershell
Get-FileHash .\src\windows-codex.mjs, .\src\logger.mjs, .\tests\windows-codex.test.mjs, .\tests\logger.test.mjs -Algorithm SHA256
git add -- src/windows-codex.mjs src/logger.mjs tests/windows-codex.test.mjs tests/logger.test.mjs
git commit -m "实现 Codex 进程与日志管理"
```

Record hashes and commit SHA in the execution ledger.

---

### Task 5: Launcher Orchestration and Source Policy

**Files:**
- Create: `src/launcher.mjs`
- Create: `tests/source-policy.test.mjs`

**Interfaces:**
- Executable:
  - `node src/launcher.mjs`
- Exit codes:
  - `0`: Codex session ended normally.
  - `2`: An existing Codex main process prevents CDP startup.
  - `3`: Codex installation or Node runtime prerequisite missing.
  - `4`: CDP startup failed; official Codex may still be running.
  - `5`: Internal helper error; Codex must remain usable.
- Consumes every module from Tasks 1–4.
- Produces redacted lifecycle log events:
  - `launcher_started`
  - `codex_launched`
  - `cdp_connected`
  - `usage_response_observed`
  - `reset_credits_response_observed`
  - `toolbar_injection_verified`
  - `toolbar_anchor_not_found`
  - `renderer_reconnected`
  - `codex_session_ended`

- [ ] **Step 1: Write the failing source-policy test**

Create `tests/source-policy.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const files = [
  "../src/launcher.mjs",
  "../src/inject.js",
  "../src/injection-controller.mjs",
  "../src/usage-observer.mjs",
];

test("no source initiates a Wham request", async () => {
  const sources = await Promise.all(
    files.map((file) => readFile(new URL(file, import.meta.url), "utf8")),
  );

  for (const source of sources) {
    assert.doesNotMatch(
      source,
      /fetch\s*\(\s*[`"'][^`"']*\/wham\//,
    );
    assert.doesNotMatch(
      source,
      /https\.request\s*\([^)]*\/wham\//,
    );
    assert.doesNotMatch(source, /XMLHttpRequest/);
  }
});

test("renderer source contains no network primitive", async () => {
  const source = await readFile(
    new URL("../src/inject.js", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /\bWebSocket\b/);
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /\bXMLHttpRequest\b/);
});
```

- [ ] **Step 2: Run the source-policy test and verify launcher absence**

Run:

```powershell
node --test .\tests\source-policy.test.mjs
```

Expected: FAIL because `src/launcher.mjs` does not exist.

- [ ] **Step 3: Implement launcher startup**

Startup order:

```js
const installation = await discoverCodexInstallation();
const existing = await findRunningCodexMainProcesses();
if (existing.length > 0) {
  await logger.writeFatal("Codex 已在运行。请先正常关闭 Codex，再从“Codex（用量显示）”启动。");
  process.exitCode = 2;
  return;
}
const port = await reserveLoopbackPort();
const child = launchCodex(installation.exePath, port);
const target = await waitForCdpTarget(port, { timeoutMs: 15000 });
```

Connect using the Node 24 global `WebSocket`, then:

1. Create `CdpSession`.
2. Create and start `UsageObserver`.
3. Call `createInjectionController(session, injectSource, logger)` and then `install()` it.
4. Keep `currentSnapshot` in memory only.

- [ ] **Step 4: Implement event handling and state clearing**

On `/wham/usage` payload:

1. Call `parseUsagePayload`.
2. If invalid, log `usage_payload_missing_weekly_window` and keep the component hidden.
3. If account key changed, call injection `clear()` before merging the new usage.
4. Build display text and call injection `update()`.
5. Log only observation and mount status, not percentages or account keys.

On `/wham/rate-limit-reset-credits` payload:

1. Call `parseResetCreditsPayload(payload, Date.now())`.
2. Merge expiry into current snapshot only when a current usage snapshot exists.
3. Rebuild and update display text.
4. Never trigger this endpoint.

On renderer execution context or top-frame navigation:

1. Clear renderer-side component state.
2. Reinstall injection.
3. Reapply the current sanitized display strings if available.

- [ ] **Step 5: Implement shutdown without confusing renderer reloads for app exit**

Maintain two signals:

```js
let childExited = false;
let cdpAlive = true;
```

Rules:

1. Child `exit` sets `childExited = true`.
2. CDP socket close sets `cdpAlive = false`.
3. After either signal, check local CDP health for up to `2000ms`.
4. Exit helper only when `childExited === true` and the endpoint remains unavailable.
5. If CDP returns while the main process is still active, reconnect and log `renderer_reconnected`.
6. On process termination signals, close observers and logger without killing Codex.

- [ ] **Step 6: Implement clear Chinese fatal paths**

Exact messages:

- Existing Codex:

```text
Codex 已在运行。请先正常关闭 Codex，再从“Codex（用量显示）”启动。
```

- Missing installation:

```text
没有找到已安装的 Codex。请先从 Microsoft Store 安装或修复 Codex。
```

- Missing Node:

```text
没有找到 Node.js 24。当前用量显示辅助程序无法启动。
```

- CDP timeout:

```text
Codex 已启动，但用量显示未能连接到本地调试端口。你可以继续使用 Codex，或从原官方入口重新启动。
```

- [ ] **Step 7: Run all Node tests and syntax checks**

Run:

```powershell
Get-ChildItem .\src\*.mjs, .\src\inject.js |
  ForEach-Object { node --check $_.FullName }
$testFiles = Get-ChildItem .\tests\*.test.mjs |
  Select-Object -ExpandProperty FullName
node --test $testFiles
```

Expected: every syntax check and test PASS.

- [ ] **Step 8: Record hashes and commit Task 5**

Run:

```powershell
Get-FileHash .\src\launcher.mjs, .\tests\source-policy.test.mjs -Algorithm SHA256
git add -- src/launcher.mjs tests/source-policy.test.mjs
git commit -m "实现 Codex 用量监控启动器"
```

Record hashes, commit SHA, and the full passing test count.

---

### Task 6: One-Click Start, Install, and Safe Uninstall

**Files:**
- Create: `scripts/start.ps1`
- Create: `scripts/install.ps1`
- Create: `scripts/uninstall.ps1`

**Interfaces:**
- `install.ps1 [-SourceRoot <String>] [-WhatIf]`
- Installed root: `%LOCALAPPDATA%\CodexUsageToolbar`
- Installed shortcut: `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Codex（用量显示）.lnk`
- `start.ps1` starts `node.exe %LOCALAPPDATA%\CodexUsageToolbar\src\launcher.mjs`.
- `uninstall.ps1 [-WhatIf]` removes only the installed root and named shortcut.

- [ ] **Step 1: Implement `start.ps1` with hidden one-click lifecycle**

Required behavior:

```powershell
$ErrorActionPreference = 'Stop'
function Show-CodexUsageError([string]$Message) {
    $shell = New-Object -ComObject WScript.Shell
    [void]$shell.Popup($Message.Trim(), 0, 'Codex 用量显示', 16)
}

try {
    $node = Get-Command node.exe -ErrorAction Stop
} catch {
    Show-CodexUsageError '没有找到 Node.js 24。当前用量显示辅助程序无法启动。'
    exit 3
}

$launcher = Join-Path $PSScriptRoot '..\src\launcher.mjs'
& $node.Source $launcher
$exitCode = $LASTEXITCODE

if ($exitCode -ne 0) {
    $errorFile = Join-Path $PSScriptRoot '..\logs\last-error.txt'
    $message = if (Test-Path -LiteralPath $errorFile) {
        Get-Content -LiteralPath $errorFile -Raw
    } else {
        "Codex 用量显示辅助程序已退出，错误代码：$exitCode"
    }
    Show-CodexUsageError $message
}

exit $exitCode
```

The Start Menu shortcut launches:

```text
C:\Program Files\PowerShell\7\pwsh.exe
```

with:

```text
-NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%LOCALAPPDATA%\CodexUsageToolbar\scripts\start.ps1"
```

- [ ] **Step 2: Implement `install.ps1`**

Safety requirements:

1. Resolve `$SourceRoot`.
2. Require these source directories: `src`, `scripts`.
3. Resolve `%LOCALAPPDATA%` and `%APPDATA%`; reject empty values.
4. Use exact child path `CodexUsageToolbar`, never a broad directory.
5. Copy to a temporary sibling directory first.
6. Validate all expected files.
7. Move the validated temporary directory to the exact install path.
8. If an existing install exists, set `$stamp = Get-Date -Format 'yyyyMMddHHmmss'` and rename it to `"CodexUsageToolbar.backup-$stamp"` before replacement.
9. Create the named `.lnk` with WScript Shell.
10. Use the official `Codex.exe` icon discovered from AppX.
11. On success, remove only the exact backup created by this run.
12. Honor `SupportsShouldProcess` so `-WhatIf` performs no writes.

Do not modify the official Start Menu entry, taskbar pins, registry, AppX package, or Windows login startup.

- [ ] **Step 3: Implement `uninstall.ps1`**

Before removal:

```powershell
$localAppData = [Environment]::GetFolderPath('LocalApplicationData')
$appData = [Environment]::GetFolderPath('ApplicationData')
$installRoot = [IO.Path]::GetFullPath((Join-Path $localAppData 'CodexUsageToolbar'))
$expectedParent = [IO.Path]::GetFullPath($localAppData)
if (-not $installRoot.StartsWith($expectedParent, [StringComparison]::OrdinalIgnoreCase)) {
    throw '卸载目标不在当前用户 LocalAppData 中，已停止。'
}
```

Then:

1. Stop only helper processes whose executable/command line resolves under the exact install root.
2. Remove the exact `Codex（用量显示）.lnk`.
3. Remove the exact install root.
4. Never stop or delete official `Codex.exe`.
5. Honor `-WhatIf`.

- [ ] **Step 4: Parse and dry-run all PowerShell scripts**

Run:

```powershell
$scripts = Get-ChildItem .\scripts\*.ps1
foreach ($script in $scripts) {
    $tokens = $null
    $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile(
        $script.FullName,
        [ref]$tokens,
        [ref]$errors
    )
    if ($errors.Count -gt 0) { $errors; exit 1 }
}
& .\scripts\install.ps1 -WhatIf
& .\scripts\uninstall.ps1 -WhatIf
```

Expected: parser reports no errors; both dry runs describe only the intended user-local directory and named shortcut.

- [ ] **Step 5: Record hashes and commit Task 6**

Run:

```powershell
Get-FileHash .\scripts\start.ps1, .\scripts\install.ps1, .\scripts\uninstall.ps1 -Algorithm SHA256
git add -- scripts/start.ps1 scripts/install.ps1 scripts/uninstall.ps1
git commit -m "实现插件安装与卸载脚本"
```

Record hashes and commit SHA. Do not install yet.

---

### Task 7: Unified Offline Verification and Operator Handoff

**Files:**
- Create: `scripts/verify.ps1`
- Create: `README.md`

**Interfaces:**
- `verify.ps1 [-InstalledRoot <String>]`
- Exit `0` only when syntax, focused tests, policy checks, source layout, AppX discovery, and optional installed-file checks pass.

- [ ] **Step 1: Implement `verify.ps1`**

The script must:

1. Resolve the project root from `$PSScriptRoot`.
2. Verify Node major version is `24` or newer.
3. Verify PowerShell major version is `7` or newer.
4. Verify all expected files from the File Structure section exist.
5. Run `node --check` for every `.mjs` and `inject.js`.
6. Resolve and run every test file explicitly:

```powershell
$testFiles = Get-ChildItem (Join-Path $projectRoot 'tests\*.test.mjs') |
  Select-Object -ExpandProperty FullName
node --test $testFiles
```

7. Fail if any `package-lock.json`, `node_modules`, or third-party runtime bundle exists.
8. Run `windows-codex.mjs --discover-only`.
9. Compute SHA-256 for every source, script, and test file and write:

```text
outputs\verification-manifest.sha256
```

10. If `-InstalledRoot` is supplied, compare installed source/script hashes against the project files.
11. Print one Chinese summary with counts and exact failures.

- [ ] **Step 2: Write the concise `README.md`**

Include only:

1. Purpose.
2. One-click start behavior.
3. Exact full and compact copy rules.
4. “No extra Wham request” guarantee and the optional-expiry limitation.
5. Install command.
6. Verify command.
7. Uninstall command.
8. Real restart acceptance boundary.
9. Original official Codex entry as immediate fallback.

Do not duplicate the entire design or implementation plan.

- [ ] **Step 3: Run unified offline verification**

Run:

```powershell
& .\scripts\verify.ps1
```

Expected:

- All Node syntax checks PASS.
- All focused tests PASS.
- No dependency directory or lockfile found.
- Current Codex AppX installation discovered.
- Verification manifest written under `outputs`.

- [ ] **Step 4: Inspect the verification manifest and changed-file scope**

Run:

```powershell
Get-Content .\outputs\verification-manifest.sha256
Get-ChildItem . -Recurse -File |
  Select-Object FullName, Length
```

Expected: only the planned implementation, tests, scripts, README, and manifest exist.

- [ ] **Step 5: Commit unified verification and usage instructions**

Run:

```powershell
git add -- README.md scripts/verify.ps1
git commit -m "完善离线验证与使用说明"
```

Save the unified verification output and commit SHA in the ledger. Do not claim live Codex UI success.

---

### Task 8: User-Local Installation Without Touching Official Codex

**Files:**
- Write outside workspace after explicit execution approval:
  - `%LOCALAPPDATA%\CodexUsageToolbar\...`
  - `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Codex（用量显示）.lnk`
- Do not modify any official Codex file.

**Interfaces:**
- Consumes the verified project from Task 7.
- Produces the installed one-click entry for Task 9.

- [ ] **Step 1: Capture official Codex integrity evidence before installation**

Run:

```powershell
$package = Get-AppxPackage -Name OpenAI.Codex |
  Sort-Object Version -Descending |
  Select-Object -First 1
$asar = Join-Path $package.InstallLocation 'app\resources\app.asar'
Get-FileHash -LiteralPath $asar -Algorithm SHA256
```

Record package version, exact `app.asar` path, and SHA-256.

- [ ] **Step 2: Request approval for user-local installation**

The execution request must name the exact targets:

```text
%LOCALAPPDATA%\CodexUsageToolbar
%APPDATA%\Microsoft\Windows\Start Menu\Programs\Codex（用量显示）.lnk
```

It must state that the official Codex package and original shortcuts are not modified.

- [ ] **Step 3: Install**

After approval, run:

```powershell
& .\scripts\install.ps1
```

Expected: installation succeeds and prints the resolved install root and shortcut path.

- [ ] **Step 4: Verify installed files and shortcut**

Run:

```powershell
$installRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'CodexUsageToolbar'
& .\scripts\verify.ps1 -InstalledRoot $installRoot

$shortcut = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'Microsoft\Windows\Start Menu\Programs\Codex（用量显示）.lnk'
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($shortcut)
[pscustomobject]@{
    TargetPath = $link.TargetPath
    Arguments = $link.Arguments
    IconLocation = $link.IconLocation
}
```

Expected:

- Installed hashes match verified project files.
- Shortcut targets PowerShell 7 with hidden-window arguments.
- Icon points to the current official `Codex.exe`.

- [ ] **Step 5: Recheck official Codex integrity**

Run the same `Get-FileHash` command from Step 1.

Expected: exact same `app.asar` SHA-256 and same installed AppX version.

- [ ] **Step 6: Stop before live restart and report the boundary**

Report:

- Code complete.
- Focused tests and install verification complete.
- Official package unchanged.
- Current Codex window is not injected.
- Live acceptance requires the user to close Codex and launch `Codex（用量显示）`.

Do not claim the UI is complete yet.

---

### Task 9: Restart and Live Codex Acceptance

**Files:**
- Runtime read-only evidence:
  - `%LOCALAPPDATA%\CodexUsageToolbar\logs\launcher-*.jsonl`
- No source changes unless the live evidence reveals a specific defect.

**Interfaces:**
- Uses the installed Start Menu shortcut.
- Produces final runtime acceptance evidence.

- [ ] **Step 1: Ask the user to close Codex normally**

Explain that closing the app pauses the current task temporarily. Do not kill Codex automatically.

- [ ] **Step 2: Start from the new entry**

User action:

```text
开始菜单 → Codex（用量显示）
```

The user then reopens this same task.

- [ ] **Step 3: Inspect redacted runtime evidence**

Run:

```powershell
$logRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'CodexUsageToolbar\logs'
Get-ChildItem -LiteralPath $logRoot -Filter 'launcher-*.jsonl' |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1 |
  Get-Content
```

Required events:

```text
launcher_started
codex_launched
cdp_connected
usage_response_observed
toolbar_injection_verified
```

Confirm the log contains no account ID, token, cookie, response body, percentage, or reset date.

- [ ] **Step 4: Verify loopback-only listening**

Read the port from the approved `cdp_connected` log metadata, then run:

```powershell
$logRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'CodexUsageToolbar\logs'
$latestLog = Get-ChildItem -LiteralPath $logRoot -Filter 'launcher-*.jsonl' |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1
$cdpEvent = Get-Content -LiteralPath $latestLog.FullName |
  ForEach-Object { $_ | ConvertFrom-Json } |
  Where-Object event -eq 'cdp_connected' |
  Select-Object -Last 1
$observedPort = [int]$cdpEvent.port
Get-NetTCPConnection -State Listen -LocalPort $observedPort |
  Select-Object LocalAddress, LocalPort, OwningProcess
```

Expected:

```text
LocalAddress  127.0.0.1
```

No `0.0.0.0`, `[::]`, LAN address, or public address may listen on that port.

- [ ] **Step 5: Verify the rendered text**

Use the launcher's CDP self-check log and user-visible UI:

1. Exactly one `data-codex-usage-toolbar="v1"` root exists.
2. Wide window shows:

```text
用量：每周 {当前真实剩余百分比}%（{当前真实重置时间} 重置）
```

3. If reset count is positive, append:

```text
｜剩余重置次数：{当前真实次数}
```

4. Append the expiry clause only if Codex itself has provided reset-credit details.
5. Narrowing the window switches to:

```text
周 {当前真实剩余百分比}%｜↻（{当前真实次数}）
```

6. If the real reset count is zero, confirm no reset symbol, count, or expiry text appears.

Do not hard-code `66%`; use the value observed at acceptance time.

- [ ] **Step 6: Verify navigation recovery**

Navigate between two Codex tasks and return.

Expected:

- component remains unique;
- text returns after any renderer DOM reconstruction;
- log may show `renderer_reconnected`;
- no additional helper-initiated Wham request appears.

- [ ] **Step 7: Verify synchronized exit**

Close Codex normally, wait no more than two seconds, then run:

```powershell
Get-CimInstance Win32_Process |
  Where-Object {
    $_.CommandLine -like '*CodexUsageToolbar*launcher.mjs*' -or
    $_.CommandLine -like '*CodexUsageToolbar*start.ps1*'
  } |
  Select-Object ProcessId, Name, CommandLine
```

Expected: no matching helper process.

- [ ] **Step 8: Verify immediate fallback**

Start Codex once from the original official entry.

Expected:

- Codex works normally;
- usage toolbar is absent;
- official files require no repair.

Close it, then return to `Codex（用量显示）` for normal use.

- [ ] **Step 9: Final completion report**

Report:

1. Modified/created files.
2. User-local installed paths.
3. Exact focused test count and commands.
4. Official `app.asar` before/after matching SHA-256.
5. Loopback-only port evidence.
6. Live full/compact display evidence.
7. Exit synchronization evidence.
8. Unverified states, especially the zero-reset live state if the real account count was non-zero.
9. Known risk: future Codex toolbar structure or response schema changes may temporarily hide the component.

Only after this step may the task be described as live UI accepted.

