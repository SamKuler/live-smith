let composingTarget: EventTarget | null = null;

document.addEventListener("compositionstart", (event) => { composingTarget = event.target; }, true);
document.addEventListener("compositionend", (event) => {
  if (composingTarget === event.target) composingTarget = null;
}, true);
document.addEventListener("focusout", (event) => {
  if (composingTarget === event.target) composingTarget = null;
}, true);

/** IME boundary keys can have false isComposing while composition is still active. */
export function isImeKeyboardEvent(event: KeyboardEvent): boolean {
  return event.isComposing || event.keyCode === 229 ||
    composingTarget !== null && event.target === composingTarget;
}
