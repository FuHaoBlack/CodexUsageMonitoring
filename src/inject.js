(() => {
  "use strict";

  const GLOBAL_KEY = "__codexUsageToolbarV1";
  const ROOT_SELECTOR = '[data-codex-usage-toolbar="v1"]';
  if (window[GLOBAL_KEY]) return;

  let root = null;
  let toolbar = null;
  let resizeObserver = null;
  let mutationObserver = null;
  let remountQueued = false;
  let fullText = "";
  let compactText = "";
  let mode = null;

  function isVisible(element) {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }

  function overlapArea(first, second) {
    const width = Math.max(0, Math.min(first.right, second.right) - Math.max(first.left, second.left));
    const height = Math.max(0, Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top));
    return width * height;
  }

  function overlapsSidebar(element, rect) {
    const area = rect.width * rect.height;
    if (!area) return false;
    return [...document.querySelectorAll("aside, nav, [role='navigation']")]
      .filter((sidebar) => sidebar !== element && isVisible(sidebar))
      .some((sidebar) => overlapArea(rect, sidebar.getBoundingClientRect()) / area > 0.5);
  }

  function findToolbar() {
    const candidates = [...document.querySelectorAll("header, [role='banner'], *")]
      .filter((element) => {
        if (!isVisible(element) || element.closest("aside, nav, [role='navigation']")) return false;
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        const isDragRegion = style.webkitAppRegion === "drag" || style.getPropertyValue("-webkit-app-region") === "drag";
        return (element.matches("header, [role='banner']") || isDragRegion)
          && rect.top >= 0
          && rect.top < 96
          && rect.height >= 28
          && rect.height <= 80
          && rect.width >= window.innerWidth * 0.5;
      })
      .map((element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        let score = element.matches("header, [role='banner']") ? 4 : 0;
        if (style.display.includes("flex") || style.display.includes("grid")) score += 3;
        if ([...element.querySelectorAll("button")].some(isVisible)) score += 2;
        if (window.innerWidth - rect.right <= 24) score += 2;
        if (overlapsSidebar(element, rect)) score -= 4;
        return { element, score };
      });
    const highest = Math.max(...candidates.map(({ score }) => score), -Infinity);
    const winners = candidates.filter((candidate) => candidate.score === highest);
    return highest >= 5 && winners.length === 1 ? winners[0].element : null;
  }

  function removeRoot() {
    root?.remove();
    root = null;
    toolbar = null;
    mode = null;
    document.querySelectorAll(ROOT_SELECTOR).forEach((element) => element.remove());
  }

  function existingToolbarWidth(container) {
    return [...container.children]
      .filter((child) => child !== root)
      .reduce((width, child) => width + child.getBoundingClientRect().width, 0);
  }

  function chooseMode() {
    if (!root || !toolbar) return;
    const measure = root.querySelector("[data-codex-usage-measure]");
    const full = root.querySelector("[data-codex-usage-full]");
    const compact = root.querySelector("[data-codex-usage-compact]");
    if (!measure || !full || !compact) return;
    const available = toolbar.getBoundingClientRect().width - existingToolbarWidth(toolbar);
    const nextMode = available >= measure.getBoundingClientRect().width ? "full" : "compact";
    full.hidden = nextMode !== "full";
    compact.hidden = nextMode !== "compact";
    mode = nextMode;
  }

  function mount() {
    const nextToolbar = findToolbar();
    if (!nextToolbar) {
      removeRoot();
      return false;
    }
    toolbar = nextToolbar;
    if (!root || root.parentElement !== toolbar) {
      root?.remove();
      document.querySelectorAll(ROOT_SELECTOR).forEach((element) => element.remove());
      root = document.createElement("div");
      root.setAttribute("data-codex-usage-toolbar", "v1");
      root.setAttribute("aria-live", "polite");
      root.style.cssText = "pointer-events: none; user-select: none; white-space: nowrap; flex: 0 1 auto; min-width: 0; font: inherit; color: var(--text-primary, currentColor); -webkit-app-region: drag;";
      const full = document.createElement("span");
      full.setAttribute("data-codex-usage-full", "");
      const compact = document.createElement("span");
      compact.setAttribute("data-codex-usage-compact", "");
      const measure = document.createElement("span");
      measure.setAttribute("data-codex-usage-measure", "");
      measure.style.cssText = "position: absolute; visibility: hidden; white-space: nowrap;";
      root.append(full, compact, measure);
      toolbar.append(root);
    }
    const full = root.querySelector("[data-codex-usage-full]");
    const compact = root.querySelector("[data-codex-usage-compact]");
    const measure = root.querySelector("[data-codex-usage-measure]");
    full.textContent = fullText;
    compact.textContent = compactText;
    measure.textContent = fullText;
    chooseMode();
    return true;
  }

  function scheduleRemount() {
    if (remountQueued || !fullText) return;
    remountQueued = true;
    queueMicrotask(() => {
      remountQueued = false;
      if (!root?.isConnected || root.parentElement !== toolbar) mount();
    });
  }

  function startObservers() {
    resizeObserver = new ResizeObserver(() => chooseMode());
    mutationObserver = new MutationObserver(() => scheduleRemount());
    mutationObserver.observe(document.body, { childList: true, subtree: true });
  }

  function status() {
    return { mounted: Boolean(root?.isConnected), mode: root?.isConnected ? mode : null };
  }

  window[GLOBAL_KEY] = {
    update(display) {
      fullText = typeof display?.fullText === "string" ? display.fullText : "";
      compactText = typeof display?.compactText === "string" ? display.compactText : "";
      if (!fullText || !compactText || !mount()) return status();
      resizeObserver?.disconnect();
      resizeObserver?.observe(toolbar);
      return status();
    },
    clear() {
      fullText = "";
      compactText = "";
      removeRoot();
    },
    destroy() {
      fullText = "";
      compactText = "";
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      removeRoot();
      delete window[GLOBAL_KEY];
    },
    status,
  };
  startObservers();
})();
