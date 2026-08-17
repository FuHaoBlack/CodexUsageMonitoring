import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { createInjectionController } from "../src/injection-controller.mjs";

function selectorMatches(element, selector) {
  return selector.split(",").some((part) => {
    const normalized = part.trim();
    if (normalized === "*") return true;
    const attribute = normalized.match(/^\[([^=\]]+)(?:=["']?([^"'\]]+)["']?)?\]$/);
    if (attribute) {
      const actual = element.getAttribute(attribute[1]);
      return attribute[2] === undefined ? actual !== null : actual === attribute[2];
    }
    return element.tagName.toLowerCase() === normalized.toLowerCase();
  });
}

class FakeElement {
  constructor(tagName, rect = {}, computed = {}) {
    this.tagName = tagName.toUpperCase();
    this.rect = { x: 0, y: 0, width: 200, height: 24, ...rect };
    this.computed = computed;
    this.attributes = new Map();
    this.children = [];
    this.parentElement = null;
    this.style = { cssText: "" };
    this.hidden = false;
    this.textContent = "";
  }

  get isConnected() {
    let current = this;
    while (current) {
      if (current.tagName === "HTML") return true;
      current = current.parentElement;
    }
    return false;
  }

  get nextSibling() {
    if (!this.parentElement) return null;
    const index = this.parentElement.children.indexOf(this);
    return this.parentElement.children[index + 1] ?? null;
  }

  get previousElementSibling() {
    if (!this.parentElement) return null;
    const index = this.parentElement.children.indexOf(this);
    return index > 0 ? this.parentElement.children[index - 1] : null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  append(...elements) {
    for (const element of elements) this.insertBefore(element, null);
  }

  insertBefore(element, reference) {
    element.remove();
    const index = reference === null ? this.children.length : this.children.indexOf(reference);
    if (index < 0) throw new Error("reference element is not a child");
    this.children.splice(index, 0, element);
    element.parentElement = this;
    return element;
  }

  remove() {
    if (!this.parentElement) return;
    const index = this.parentElement.children.indexOf(this);
    if (index >= 0) this.parentElement.children.splice(index, 1);
    this.parentElement = null;
  }

  matches(selector) {
    return selectorMatches(this, selector);
  }

  querySelectorAll(selector) {
    const matches = [];
    const visit = (element) => {
      for (const child of element.children) {
        if (child.matches(selector)) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  getBoundingClientRect() {
    const { x, y, width, height } = this.rect;
    return { x, y, width, height, top: y, left: x, right: x + width, bottom: y + height };
  }
}

function createRendererFixture({ includeMenu = true } = {}) {
  const html = new FakeElement("html", { width: 1200, height: 800 });
  const body = new FakeElement("body", { width: 1200, height: 800 });
  html.append(body);
  const topBar = new FakeElement("div", { width: 1200, height: 36 }, { display: "flex" });
  body.append(topBar);
  const brand = new FakeElement("div", { x: 6, y: 4, width: 92, height: 28 }, { display: "flex" });
  topBar.append(brand);
  let menuBranch = null;
  if (includeMenu) {
    menuBranch = new FakeElement("div", { x: 98, y: 6, width: 220, height: 24 });
    const menuBar = new FakeElement("div", { x: 98, y: 6, width: 220, height: 24 }, { display: "flex" });
    menuBar.setAttribute("role", "menubar");
    for (let index = 0; index < 4; index += 1) {
      const item = new FakeElement("button", { x: 98 + index * 50, y: 6, width: 48, height: 24 });
      item.setAttribute("role", "menuitem");
      menuBar.append(item);
    }
    menuBranch.append(menuBar);
    topBar.append(menuBranch);
  }
  const contentHeader = new FakeElement("header", { x: 300, y: 36, width: 900, height: 46 }, { display: "flex" });
  body.append(contentHeader);

  const document = {
    documentElement: html,
    body,
    createElement(tagName) {
      return new FakeElement(tagName);
    },
    querySelectorAll(selector) {
      const matches = html.matches(selector) ? [html] : [];
      return matches.concat(html.querySelectorAll(selector));
    },
  };
  const getComputedStyle = (element) => ({
    display: element.computed.display ?? "block",
    visibility: element.computed.visibility ?? "visible",
    flexDirection: element.computed.flexDirection ?? "row",
    borderLeftWidth: "0",
    borderRightWidth: "0",
    paddingLeft: "0",
    paddingRight: "0",
    marginLeft: "0",
    marginRight: "0",
    columnGap: "0",
  });
  class Observer {
    observe() {}
    disconnect() {}
  }
  const context = {
    document,
    innerWidth: 1200,
    getComputedStyle,
    ResizeObserver: Observer,
    MutationObserver: Observer,
    queueMicrotask,
  };
  context.window = context;
  return { context, topBar, menuBranch, contentHeader };
}

async function executeInjection(fixture) {
  const source = await readFile(new URL("../src/inject.js", import.meta.url), "utf8");
  vm.runInNewContext(source, fixture.context);
  return fixture.context.__codexUsageToolbarV1.update({ fullText: "FULL", compactText: "SHORT" });
}

test("renderer injection is non-networked, non-interactive, and uniquely marked", async () => {
  const source = await readFile(
    new URL("../src/inject.js", import.meta.url),
    "utf8",
  );

  assert.match(source, /data-codex-usage-toolbar/);
  assert.match(source, /__codexUsageToolbarV1/);
  assert.match(source, /ResizeObserver/);
  assert.match(source, /MutationObserver/);
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

test("renderer mounts after the top semantic menu branch without text, ids, classes, or a fixed nesting level", async () => {
  const fixture = createRendererFixture();

  const status = await executeInjection(fixture);

  const root = fixture.context.document.querySelectorAll('[data-codex-usage-toolbar="v1"]')[0];
  assert.deepEqual({ ...status }, { mounted: true, mode: "full" });
  assert.equal(root?.parentElement, fixture.topBar);
  assert.equal(root?.previousElementSibling, fixture.menuBranch);
  assert.equal(fixture.contentHeader.children.length, 0);
});

test("renderer refuses a content header when no semantic menu bar exists", async () => {
  const fixture = createRendererFixture({ includeMenu: false });

  const status = await executeInjection(fixture);

  assert.deepEqual({ ...status }, { mounted: false, mode: null });
  assert.equal(fixture.context.document.querySelectorAll('[data-codex-usage-toolbar="v1"]').length, 0);
  assert.equal(fixture.contentHeader.children.length, 0);
});

test("controller reports a missing anchor only after an update attempts to mount", async () => {
  const events = [];
  const session = {
    async send(method, params) {
      if (method !== "Runtime.evaluate") return {};
      assert.equal(typeof params.expression, "string");
      return { result: { value: { mounted: false, mode: null } } };
    },
  };
  const controller = createInjectionController(session, "void 0", (event) => events.push(event));

  assert.deepEqual(await controller.install(), { mounted: false, mode: null });
  assert.deepEqual(events, []);
  assert.deepEqual(await controller.update({ fullText: "FULL", compactText: "SHORT" }), { mounted: false, mode: null });
  assert.deepEqual(events, ["toolbar_anchor_not_found"]);
});
