import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createInjectionController } from "../src/injection-controller.mjs";

test("renderer injection is non-networked, non-interactive, and uniquely marked", async () => {
  const source = await readFile(
    new URL("../src/inject.js", import.meta.url),
    "utf8",
  );

  assert.match(source, /data-codex-usage-toolbar/);
  assert.match(source, /__codexUsageToolbarV1/);
  assert.match(source, /ResizeObserver/);
  assert.match(source, /MutationObserver/);
  assert.match(source, /Math\.abs\(window\.innerWidth - rect\.right\) <= 24/);
  assert.match(source, /document\.body \?\? document\.documentElement/);
  assert.match(source, /let mutationTarget = null/);
  assert.match(source, /function ensureMutationObserver\(\)/);
  assert.doesNotMatch(source, /if \(!mutationObserver\) startObservers\(\)/);
  assert.match(source, /fullText !== expectedFullText/);
  assert.match(source, /pointer-events:\s*none/);
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /XMLHttpRequest/);
  assert.doesNotMatch(source, /\/wham\//);
  assert.doesNotMatch(source, /addEventListener\s*\(\s*["']click/);
});

test("controller treats CDP evaluation exceptions as unavailable without sensitive logging", async () => {
  const events = [];
  const session = {
    async send(method) {
      if (method === "Runtime.evaluate") return { exceptionDetails: { text: "ignored" } };
      return {};
    },
  };
  const controller = createInjectionController(session, "void 0", (event) => events.push(event));

  assert.deepEqual(await controller.install(), { mounted: false, mode: null });
  assert.deepEqual(events, ["toolbar_injection_unavailable"]);
});
