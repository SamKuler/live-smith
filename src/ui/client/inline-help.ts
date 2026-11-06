import { autoUpdate, computePosition, flip, offset, shift, size } from "@floating-ui/dom";
import { isImeKeyboardEvent } from "./ime-keyboard.js";

/** One help surface serves both authored fields and dynamically rendered controls. */
export function createInlineHelp() {
  const tip = document.createElement("div");
  tip.id = "inline-help-content"; tip.className = "inline-help-content";
  tip.setAttribute("role", "tooltip"); tip.hidden = true;
  let active: HTMLButtonElement | undefined;
  let pinned = false;
  let pointerInside = false;
  let leaveTimer: number | undefined;
  let stopPositioning: (() => void) | undefined;
  const buttonAt = (target: EventTarget | null) => target instanceof Element
    ? target.closest<HTMLButtonElement>("button:is(.inline-help, .action-tooltip)[data-tooltip]") ?? undefined : undefined;
  const observer = new MutationObserver(refresh);

  function close() {
    window.clearTimeout(leaveTimer);
    stopPositioning?.(); stopPositioning = undefined; observer.disconnect();
    if (active) {
      if (active.classList.contains("inline-help")) active.setAttribute("aria-expanded", "false");
      const ids = (active.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(id => id && id !== tip.id);
      if (ids.length) active.setAttribute("aria-describedby", ids.join(" ")); else active.removeAttribute("aria-describedby");
    }
    active = undefined; pinned = pointerInside = false; tip.hidden = true;
  }
  function position() {
    const button = active;
    if (!button) return;
    void computePosition(button, tip, {
      strategy: "fixed", placement: "bottom-start",
      middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 }), size({ padding: 8,
        apply({ availableHeight, elements }) {
          if (active === button) elements.floating.style.maxHeight = `${Math.max(0, availableHeight)}px`;
        } })],
    }).then(({ x, y }) => {
      if (active === button) Object.assign(tip.style, { left: `${x}px`, top: `${y}px` });
    });
  }
  function refresh() {
    if (!active) return;
    if (!active.isConnected || active.closest("[hidden], [inert]") || !active.dataset.tooltip) { close(); return; }
    for (let parent = active.parentElement; parent; parent = parent.parentElement) {
      if (parent instanceof HTMLDetailsElement && !parent.open && !parent.querySelector(":scope > summary")?.contains(active)) {
        close(); return;
      }
    }
    if (tip.textContent !== active.dataset.tooltip) tip.textContent = active.dataset.tooltip;
    position();
  }
  function open(button: HTMLButtonElement) {
    window.clearTimeout(leaveTimer);
    if (active === button) return;
    close();
    if (!button.dataset.tooltip || button.disabled) return;
    document.body.append(tip);
    active = button; tip.textContent = button.dataset.tooltip; tip.hidden = false;
    if (button.classList.contains("inline-help")) button.setAttribute("aria-expanded", "true");
    const ids = new Set((button.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean));
    ids.add(tip.id); button.setAttribute("aria-describedby", [...ids].join(" "));
    stopPositioning = autoUpdate(button, tip, position);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "data-tooltip", "inert", "open"] });
  }
  function leave() {
    window.clearTimeout(leaveTimer);
    leaveTimer = window.setTimeout(() => {
      if (!pinned && !pointerInside && document.activeElement !== active) close();
    }, 150);
  }
  function onPointerOver(event: Event) {
    const button = buttonAt(event.target);
    if (button && (!pinned && document.activeElement !== active)) open(button);
    if ((button && button === active) || tip.contains(event.target as Node)) {
      pointerInside = true;
      window.clearTimeout(leaveTimer);
    }
  }
  function onPointerOut(event: PointerEvent) {
    if (!active) return;
    const next = event.relatedTarget as Node | null;
    if (next && (active.contains(next) || tip.contains(next))) return;
    pointerInside = false; leave();
  }
  function onFocusIn(event: FocusEvent) { const button = buttonAt(event.target); if (button) open(button); }
  function onFocusOut(event: FocusEvent) {
    if (active && event.target === active && !pointerInside && !tip.contains(event.relatedTarget as Node | null)) close();
    else leave();
  }
  function onClick(event: MouseEvent) {
    const button = buttonAt(event.target);
    if (!button) return;
    if (button.classList.contains("action-tooltip")) { if (active === button) close(); return; }
    if (active === button && pinned) close();
    else { open(button); pinned = true; }
  }
  function onOutside(event: PointerEvent) {
    if (active && !active.contains(event.target as Node) && !tip.contains(event.target as Node)) close();
  }
  function onKey(event: KeyboardEvent) {
    if (isImeKeyboardEvent(event)) return;
    if (event.key === "Escape" && active) { close(); event.preventDefault(); event.stopImmediatePropagation(); }
  }
  document.addEventListener("pointerover", onPointerOver);
  document.addEventListener("pointerout", onPointerOut);
  document.addEventListener("focusin", onFocusIn);
  document.addEventListener("focusout", onFocusOut);
  document.addEventListener("click", onClick);
  document.addEventListener("pointerdown", onOutside, true);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("pagehide", close);
  return {
    refresh,
    close,
    contains(owner: Element, target: EventTarget | null) {
      return Boolean(active && owner.contains(active) && target instanceof Node && tip.contains(target));
    },
  };
}
