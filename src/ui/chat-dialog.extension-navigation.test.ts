import assert from "node:assert/strict";
import test from "node:test";
import { commandCalls, createDialogHarness } from "./chat-dialog.test-harness.js";
import { audioState, service, selectAudioService } from "./chat-dialog.audio-test-helpers.js";

const categories = ["audio", "mcp", "skills", "plugins"];

test("extension categories expose one capability page without starting tools or saving settings", async () => {
  const h = await createDialogHarness(audioState());
  try {
    h.click("#extensionsTab");
    for (const selected of categories) {
      h.click(`#${selected}ExtensionTab`);
      for (const category of categories) {
        const tab = h.document.querySelector<HTMLButtonElement>(`#${category}ExtensionTab`)!;
        const page = h.document.querySelector<HTMLElement>(`[data-extension-page="${category}"]`)!;
        assert.equal(tab.getAttribute("aria-selected"), String(category === selected));
        assert.equal(tab.tabIndex, category === selected ? 0 : -1);
        assert.equal(page.hidden, category !== selected);
        assert.equal(tab.getAttribute("aria-controls"), page.id);
      }
    }
    assert.ok(h.document.querySelector('#audioServicesSettings #addAudioServiceButton'));
    assert.ok(h.document.querySelector('#mcpSettings #addConnectionButton'));
    assert.equal(h.document.querySelector<HTMLElement>("#audioConnectionsEmpty")!.hidden, true);
    assert.equal(commandCalls(h).length, 0);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("an empty audio page replaces its hint with an editor when adding an account", async () => {
  const h = await createDialogHarness(audioState([]));
  try {
    h.click("#extensionsTab");
    const hint = h.document.querySelector<HTMLElement>("#audioConnectionsEmpty")!;
    const editor = h.document.querySelector<HTMLElement>("#audioSettingsSection")!;
    assert.equal(hint.hidden, false);
    assert.equal(editor.hidden, true);
    h.click("#addAudioServiceButton");
    assert.equal(hint.hidden, true);
    assert.equal(editor.hidden, false);
    h.click("#reloadAudioServiceButton");
    assert.equal(hint.hidden, false);
    assert.equal(editor.hidden, true);
    assert.equal(commandCalls(h).length, 0);
  } finally { h.close(); }
});

test("extension tab keyboard navigation stays inside the capability group", async () => {
  const h = await createDialogHarness();
  try {
    h.click("#extensionsTab");
    h.document.querySelector<HTMLElement>("#audioExtensionTab")!.focus();
    for (const [key, expected] of [
      ["ArrowRight", "mcp"], ["End", "plugins"], ["ArrowRight", "audio"],
      ["ArrowLeft", "plugins"], ["Home", "audio"],
    ] as const) {
      h.document.activeElement!.dispatchEvent(new h.window.KeyboardEvent("keydown", { key, bubbles: true }));
      assert.equal(h.document.activeElement?.id, `${expected}ExtensionTab`);
      assert.equal(h.document.querySelector("#extensionsTab")?.getAttribute("aria-selected"), "true");
    }
    assert.equal(commandCalls(h).length, 0);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("changing capability pages retains audio fields but drops unsaved credential values", async () => {
  const h = await createDialogHarness(audioState());
  try {
    selectAudioService(h, service.id);
    h.input("#audioServiceName", "Draft studio name");
    h.input("#audioServiceApiKey", "synthetic-unsaved-key");
    h.document.querySelector<HTMLElement>("#audioServiceApiKey")!.focus();
    h.click("#mcpExtensionTab");
    assert.equal(h.document.activeElement?.id, "mcpExtensionTab");
    h.click("#audioExtensionTab");
    assert.equal(h.document.querySelector<HTMLInputElement>("#audioServiceName")!.value, "Draft studio name");
    assert.equal(h.document.querySelector<HTMLInputElement>("#audioServiceApiKey")!.value, "");
    assert.equal(h.document.querySelector<HTMLButtonElement>("#saveAudioServiceButton")!.disabled, false);
    h.click("#reloadAudioServiceButton");
    assert.equal(h.document.querySelector<HTMLInputElement>("#audioServiceName")!.value, service.name);
    assert.equal(h.document.querySelector<HTMLButtonElement>("#saveAudioServiceButton")!.disabled, true);
    assert.equal(commandCalls(h).length, 0);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});
