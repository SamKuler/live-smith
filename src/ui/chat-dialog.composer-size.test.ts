import assert from "node:assert/strict";
import test from "node:test";
import { createDialogHarness, stateFixture } from "./chat-dialog.test-harness.js";

for (const source of ["First idea\nMore detail\nAnother thought", "/compact First idea\nMore detail\nAnother thought"]) {
test(`${source.startsWith("/") ? "command" : "message"} draft sizing preserves selection and shrinks after submission`, async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const h = await createDialogHarness(state);
  try {
    const prompt = h.document.querySelector<HTMLTextAreaElement>("#prompt")!;
    // JSDOM has no layout. Supply browser measurements to exercise the real
    // draft lifecycle; rendered geometry is checked separately in a browser.
    let measuredContent = 36;
    let measuredWidth = 480;
    Object.defineProperties(prompt, {
      clientWidth: { get: () => measuredWidth },
      clientHeight: { get: () => 36 },
      offsetHeight: { get: () => 38 },
      scrollHeight: { get: () => prompt.value ? measuredContent : 36 },
    });
    h.input("#prompt", "First idea");
    prompt.focus();
    prompt.setSelectionRange(2, 5);
    const shortHeight = prompt.style.height;
    measuredContent = 108;
    h.input("#prompt", source);
    prompt.setSelectionRange(2, 5);
    assert.ok(parseFloat(prompt.style.height) > parseFloat(shortHeight));
    assert.equal(h.document.activeElement, prompt);
    measuredWidth = 320;
    measuredContent = 160;
    h.window.dispatchEvent(new h.window.Event("resize"));
    assert.equal(prompt.selectionStart, 2);
    assert.equal(prompt.selectionEnd, 5);
    assert.equal(h.document.activeElement, prompt);
    h.click("#sendButton");
    await h.settle();
    assert.equal(prompt.value, "");
    assert.equal(prompt.style.height, shortHeight);
    measuredContent = 36;
    h.input("#prompt", "Next idea");
    assert.equal(prompt.style.height, shortHeight);
    assert.deepEqual(h.errors, []);
  } finally {
    h.close();
  }
});
}
