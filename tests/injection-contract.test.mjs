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
