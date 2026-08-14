# 顶部用量文字样式匹配实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让顶部用量完整/缩略文案继承 Codex 菜单按钮的字体和颜色，同时保持现有数据、布局和监听行为不变。

**Architecture:** 继续使用现有 `src/inject.js` 页面注入组件。仅调整组件根节点及三个文本节点的 CSS 继承声明，使它们从顶部菜单承载容器继承当前字体和颜色；不新增运行时模块、不修改官方 Codex 文件、不改变数据流。

**Tech Stack:** 原生 JavaScript、Node.js 内置 `node:test`、CDP 页面注入、PowerShell 7。

## Global Constraints

- 只修改 `src/inject.js` 与 `tests/injection-contract.test.mjs`，并保留已确认规格文件。
- 不改变完整/缩略文案、用量解析、官方刷新监听、挂载锚点、宽度测量和生命周期。
- 不调用额度接口、不新增定时器、不修改 Codex AppX、`app.asar` 或官方菜单节点。
- 不重启正在运行的 Codex；安装副本同步后由用户下次启动“Codex（用量显示）”生效。
- 所有提交信息使用中文；完成前运行聚焦测试和全量 Node 测试。

---

### Task 1: 添加字体与颜色继承回归测试

**Files:**
- Modify: `tests/injection-contract.test.mjs`

**Interfaces:**
- Consumes: `executeInjection()` 返回的注入状态，以及 fixture 中带 `style.cssText` 的 FakeElement。
- Produces: 对根节点、完整节点、缩略节点和测量节点的样式契约断言，防止固定字号/颜色回归。

- [ ] **Step 1: Write the failing test**

在 `renderer injection is non-networked...` 测试之后增加：

```js
test("usage text inherits menu typography and color", async () => {
  const fixture = createRendererFixture();
  await executeInjection(fixture);

  const root = fixture.context.document.querySelectorAll('[data-codex-usage-toolbar="v1"]')[0];
  const full = root.querySelector("[data-codex-usage-full]");
  const compact = root.querySelector("[data-codex-usage-compact]");
  const measure = root.querySelector("[data-codex-usage-measure]");

  for (const element of [root, full, compact, measure]) {
    assert.match(element.style.cssText, /font:\s*inherit/);
    assert.match(element.style.cssText, /color:\s*inherit/);
  }
  assert.doesNotMatch(root.style.cssText, /color:\s*var\(--text-primary/);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run `node --test tests/injection-contract.test.mjs`.

Expected: the new test fails because the current root uses `color: var(--text-primary, currentColor)` and the text/measure nodes have no explicit inherited style.

### Task 2: Implement inherited typography and color

**Files:**
- Modify: `src/inject.js` in the element creation and style assignment block.

**Interfaces:**
- Consumes: existing mount/measure flow and `full`, `compact`, `measure` nodes.
- Produces: same DOM structure and mode selection, with all four nodes explicitly inheriting `font` and `color` from the menu container.

- [ ] **Step 1: Write the minimal implementation**

Keep the existing layout declarations and change only the style declarations:

```js
root.style.cssText = "pointer-events: none; user-select: none; white-space: nowrap; flex: 0 1 auto; min-width: 0; font: inherit; color: inherit; -webkit-app-region: drag;";
full.style.cssText = "font: inherit; color: inherit;";
compact.style.cssText = "font: inherit; color: inherit;";
measure.style.cssText = "position: fixed; visibility: hidden; white-space: nowrap; width: max-content; font: inherit; color: inherit;";
```

Do not change `chooseMode()`, `measureFullWidth()`, text assignment, observer setup, or mount-point selection.

- [ ] **Step 2: Run the focused test and verify it passes**

Run `node --test tests/injection-contract.test.mjs`.

Expected: all injection-contract tests pass, including the new inheritance test.

### Task 3: Synchronize, verify, and publish the focused change

**Files:**
- Source: `src/inject.js`
- Runtime copy: `%LOCALAPPDATA%\CodexUsageToolbar\src\inject.js`

**Interfaces:**
- Consumes: the green focused implementation from Tasks 1-2.
- Produces: matching source/runtime hashes and a clean `master` commit.

- [ ] **Step 1: Run full verification**

Run:

```powershell
$testFiles = @(Get-ChildItem -LiteralPath tests -Filter '*.test.mjs' -File | Sort-Object FullName | Select-Object -ExpandProperty FullName)
node --test $testFiles
git diff --check
```

Expected: all tests pass and `git diff --check` emits no errors.

- [ ] **Step 2: Copy only the changed runtime module without restarting Codex**

Copy the repository `src/inject.js` to `%LOCALAPPDATA%\CodexUsageToolbar\src\inject.js`, then compare SHA-256 hashes. Do not stop or start Codex or the current helper process.

- [ ] **Step 3: Review the final write set**

Run `git status --short`, `git diff --stat`, and `git diff -- src/inject.js tests/injection-contract.test.mjs`.

Expected: only the focused production/test changes plus the approved design/plan documents are present; no official Codex files are modified.

- [ ] **Step 4: Commit on `master`**

```powershell
git add src/inject.js tests/injection-contract.test.mjs docs/superpowers/specs/2026-08-14-usage-toolbar-typography-design.md docs/superpowers/plans/2026-08-14-usage-toolbar-typography.md
git commit -m "调整用量文字样式以匹配菜单"
```

- [ ] **Step 5: Push only if the user explicitly requests publication**

The normal repository instruction is not to push unless requested. If the user requests it, push the existing `master` branch; do not create a branch or PR.
