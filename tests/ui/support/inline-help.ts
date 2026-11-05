import assert from "node:assert/strict";

export function readInlineHelp(trigger: HTMLButtonElement): string {
  const document = trigger.ownerDocument;
  trigger.focus();
  assert.equal(document.activeElement, trigger);
  const tooltip = document.querySelector<HTMLElement>('[role="tooltip"]:not([hidden])');
  assert.ok(tooltip, "Expected help to appear on keyboard focus");
  assert.ok(trigger.getAttribute("aria-describedby")?.split(/\s+/u).includes(tooltip.id));
  return tooltip.textContent ?? "";
}
