const running = new WeakMap<HTMLElement, Animation>();

/** Updates visibility immediately while keeping an inert exit surface until motion finishes. */
export function setPaneOpen(pane: HTMLElement, open: boolean, edge: "left" | "right"): void {
  if (pane.hidden === !open) return;

  const previous = running.get(pane);
  const current = previous ? window.getComputedStyle(pane) : null;
  const from = current ? { transform: current.transform, opacity: current.opacity } : null;
  if (previous) {
    previous.onfinish = null;
    previous.oncancel = null;
    previous.cancel();
    running.delete(pane);
  }

  pane.hidden = !open;
  pane.toggleAttribute("inert", !open);
  if (open) pane.removeAttribute("aria-hidden");
  else pane.setAttribute("aria-hidden", "true");
  pane.removeAttribute("data-pane-exit");
  if (typeof pane.animate !== "function") return;

  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const rootStyle = window.getComputedStyle(document.documentElement);
  const duration = Number.parseFloat(rootStyle.getPropertyValue(reduced ? "--motion-surface" : "--motion-pane")) || 180;
  const overlay = edge === "right" || window.getComputedStyle(pane).position === "absolute";
  const offscreen = { transform: reduced || !overlay ? "none" : `translateX(${edge === "left" ? "-" : ""}100%)`, opacity: "0" };
  const onscreen = { transform: "none", opacity: "1" };
  pane.toggleAttribute("data-pane-exit", !open);
  const animation = pane.animate([from || (open ? offscreen : onscreen), open ? onscreen : offscreen], {
    duration,
    easing: rootStyle.getPropertyValue("--motion-easing").trim() || "ease-out",
    fill: "both",
  });
  running.set(pane, animation);
  const finish = () => {
    if (running.get(pane) !== animation) return;
    running.delete(pane);
    pane.removeAttribute("data-pane-exit");
    animation.onfinish = null;
    animation.oncancel = null;
    animation.cancel();
  };
  animation.onfinish = finish;
  animation.oncancel = finish;
}
