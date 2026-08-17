(() => {
  "use strict";

  const GLOBAL_KEY = "__codexUsageToolbarV1";
  const ROOT_SELECTOR = '[data-codex-usage-toolbar="v1"]';
  if (window[GLOBAL_KEY]) return;

  let root = null;
  let toolbar = null;
  let toolbarAnchor = null;
  let resizeObserver = null;
  let mutationObserver = null;
  let mutationTarget = null;
  let remountQueued = false;
  let generation = 0;
  let destroyed = false;
  let fullText = "";
  let compactText = "";
  let mode = null;
  let api = null;

  function isVisible(element) {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }

  function isHorizontalContainer(element, menuRect) {
    if (!isVisible(element)) return false;
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const horizontalLayout = style.display.includes("grid")
      || (style.display.includes("flex") && style.flexDirection !== "column" && style.flexDirection !== "column-reverse");
    return horizontalLayout
      && rect.top >= 0
      && rect.top < 96
      && rect.height >= menuRect.height
      && rect.height <= 80
      && rect.width >= window.innerWidth * 0.5;
  }

  function findMountPoint() {
    const candidates = [];
    for (const menuBar of document.querySelectorAll("[role='menubar']")) {
      if (!isVisible(menuBar)) continue;
      const menuRect = menuBar.getBoundingClientRect();
      const visibleItems = [...menuBar.querySelectorAll("[role='menuitem']")].filter(isVisible);
      if (menuRect.top < 0 || menuRect.top >= 96 || menuRect.height > 80 || visibleItems.length < 2) continue;

      let anchor = menuBar;
      let container = menuBar.parentElement;
      while (container && container !== document.body && container !== document.documentElement) {
        if (isHorizontalContainer(container, menuRect)) {
          candidates.push({ container, anchor });
          break;
        }
        anchor = container;
        container = container.parentElement;
      }
    }
    return candidates.length === 1 ? candidates[0] : null;
  }

  function removeRoot() {
    root?.remove();
    root = null;
    toolbar = null;
    toolbarAnchor = null;
    mode = null;
    document.querySelectorAll(ROOT_SELECTOR).forEach((element) => element.remove());
  }

  function outerWidth(element) {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return rect.width + Number.parseFloat(style.marginLeft || "0") + Number.parseFloat(style.marginRight || "0");
  }

  function availableToolbarWidth(container) {
    const style = window.getComputedStyle(container);
    const contentWidth = container.getBoundingClientRect().width
      - Number.parseFloat(style.borderLeftWidth || "0")
      - Number.parseFloat(style.borderRightWidth || "0")
      - Number.parseFloat(style.paddingLeft || "0")
      - Number.parseFloat(style.paddingRight || "0");
    const otherChildren = [...container.children].filter((child) => child !== root);
    const columnGap = Number.parseFloat(style.columnGap || "0") || 0;
    const occupied = otherChildren.reduce((width, child) => width + outerWidth(child), 0)
      + (otherChildren.length * columnGap);
    return Math.max(0, contentWidth - occupied);
  }

  function syncMenuTypography() {
    if (!root || !toolbarAnchor) return;
    const reference = toolbarAnchor.querySelector?.("[role='menuitem']");
    if (!reference) return;
    try {
      const style = window.getComputedStyle(reference);
      if (style.font) root.style.font = style.font;
      else if (style.fontSize) root.style.fontSize = style.fontSize;
      if (style.color) root.style.color = style.color;
    } catch {
      // 菜单样式读取失败时保留继承样式，不影响用量展示。
    }
  }

  function measureFullWidth(measure) {
    const originalStyle = root.style.cssText;
    try {
      root.style.cssText += "; position: fixed !important; visibility: hidden !important; display: block !important; flex: none !important; width: max-content !important;";
      return measure.getBoundingClientRect().width;
    } finally {
      root.style.cssText = originalStyle;
    }
  }

  function chooseMode() {
    if (!root || !toolbar || !root.isConnected) return;
    syncMenuTypography();
    const measure = root.querySelector("[data-codex-usage-measure]");
    const full = root.querySelector("[data-codex-usage-full]");
    const compact = root.querySelector("[data-codex-usage-compact]");
    if (!measure || !full || !compact) return;
    const available = availableToolbarWidth(toolbar);
    const nextMode = available >= measureFullWidth(measure) ? "full" : "compact";
    full.hidden = nextMode !== "full";
    compact.hidden = nextMode !== "compact";
    mode = nextMode;
  }

  function bindResizeObserver() {
    if (!resizeObserver || !toolbar) return;
    resizeObserver.disconnect();
    resizeObserver.observe(toolbar);
    [...toolbar.children].filter((child) => child !== root).forEach((child) => resizeObserver.observe(child));
  }

  function mount() {
    ensureMutationObserver();
    const mountPoint = findMountPoint();
    if (!mountPoint) {
      removeRoot();
      return false;
    }
    toolbar = mountPoint.container;
    toolbarAnchor = mountPoint.anchor;
    if (!root || root.parentElement !== toolbar || root.previousElementSibling !== toolbarAnchor) {
      root?.remove();
      document.querySelectorAll(ROOT_SELECTOR).forEach((element) => element.remove());
      root = document.createElement("div");
      root.setAttribute("data-codex-usage-toolbar", "v1");
      root.setAttribute("aria-live", "polite");
      root.style.cssText = "pointer-events: none; user-select: none; white-space: nowrap; flex: 0 1 auto; min-width: 0; font: inherit; color: inherit; -webkit-app-region: drag;";
      const full = document.createElement("span");
      full.setAttribute("data-codex-usage-full", "");
      full.style.cssText = "font: inherit; color: inherit;";
      const compact = document.createElement("span");
      compact.setAttribute("data-codex-usage-compact", "");
      compact.style.cssText = "font: inherit; color: inherit;";
      const measure = document.createElement("span");
      measure.setAttribute("data-codex-usage-measure", "");
      measure.style.cssText = "position: fixed; visibility: hidden; white-space: nowrap; width: max-content; font: inherit; color: inherit;";
      root.append(full, compact, measure);
      toolbar.insertBefore(root, toolbarAnchor.nextSibling);
    }
    const full = root.querySelector("[data-codex-usage-full]");
    const compact = root.querySelector("[data-codex-usage-compact]");
    const measure = root.querySelector("[data-codex-usage-measure]");
    full.textContent = fullText;
    compact.textContent = compactText;
    measure.textContent = fullText;
    bindResizeObserver();
    chooseMode();
    return true;
  }

  function scheduleRemount() {
    if (remountQueued || destroyed || !fullText || !compactText) return;
    const expectedFullText = fullText;
    const expectedCompactText = compactText;
    const expectedGeneration = generation;
    remountQueued = true;
    queueMicrotask(() => {
      remountQueued = false;
      if (
        destroyed
        || window[GLOBAL_KEY] !== api
        || generation !== expectedGeneration
        || fullText !== expectedFullText
        || compactText !== expectedCompactText
      ) return;
      if (!root?.isConnected || root.parentElement !== toolbar || root.previousElementSibling !== toolbarAnchor) mount();
      else {
        bindResizeObserver();
        chooseMode();
      }
    });
  }

  function ensureMutationObserver() {
    if (!mutationObserver) mutationObserver = new MutationObserver(() => scheduleRemount());
    const target = document.body ?? document.documentElement;
    if (!target || mutationTarget === target) return Boolean(mutationTarget);
    mutationObserver.disconnect();
    try {
      mutationObserver.observe(target, { childList: true, subtree: true });
      mutationTarget = target;
      return true;
    } catch {
      mutationTarget = null;
      return false;
    }
  }

  function startObservers() {
    if (!resizeObserver) resizeObserver = new ResizeObserver(() => chooseMode());
    ensureMutationObserver();
  }

  function status() {
    return { mounted: Boolean(root?.isConnected), mode: root?.isConnected ? mode : null };
  }

  api = {
    update(display) {
      if (destroyed) return { mounted: false, mode: null };
      generation += 1;
      fullText = typeof display?.fullText === "string" ? display.fullText : "";
      compactText = typeof display?.compactText === "string" ? display.compactText : "";
      startObservers();
      if (!fullText || !compactText || !mount()) return status();
      return status();
    },
    clear() {
      generation += 1;
      fullText = "";
      compactText = "";
      removeRoot();
    },
    destroy() {
      generation += 1;
      destroyed = true;
      fullText = "";
      compactText = "";
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      mutationTarget = null;
      removeRoot();
      delete window[GLOBAL_KEY];
    },
    status,
  };
  window[GLOBAL_KEY] = api;
  startObservers();
})();
