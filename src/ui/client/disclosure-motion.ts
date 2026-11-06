/** Marks a reveal without changing native disclosure state or waiting for animation. */
export function revealDisclosure(details: HTMLDetailsElement): void {
  if (details.open) return;
  // Closed details can skip style updates. Resolve the cleared animation before reopening.
  for (const child of details.children) {
    if (!child.matches("summary, style, script, [hidden]")) window.getComputedStyle(child).animationName;
  }
  details.classList.add("motion-disclosure");
}

export function installDisclosureMotion(): void {
  document.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0 || !(event.target instanceof Element)) return;
    const summary = event.target.closest("summary");
    const details = summary?.parentElement;
    if (!(details instanceof HTMLDetailsElement) ||
        event.target.closest('button, a, input, select, textarea, [contenteditable="true"]')) return;
    revealDisclosure(details);
  });
}
