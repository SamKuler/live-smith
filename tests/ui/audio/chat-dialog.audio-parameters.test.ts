import assert from "node:assert/strict";
import test from "node:test";
import { audioParameterGroups } from "../../../src/plugins/builtins/parameter-panel.js";
import { audioState } from "../support/chat-dialog.audio-test-helpers.js";
import { commandCalls, createDialogHarness, waitForCondition } from "../support/chat-dialog.test-harness.js";

function panelState() {
  const connection = { id: "suno-studio", name: "Suno Studio", provider: "suno" as const, enabled: true, apiKeyConfigured: false };
  const state = audioState([connection]);
  state.openSettingsOnLoad = false;
  const groups = audioParameterGroups({ services: [{ ...connection, pluginId: "live-smith.suno-website" }],
    hasJobs: false, identity: () => "account-owner" }).map((group) => ({ ...group,
    tools: group.tools.map((tool) => ({ ...tool, description: tool.description.slice(0, 512) })) }));
  state.sessionToolCatalog = { sessionId: state.activeSessionId, loadedAt: "2026-09-30T00:00:00.000Z",
    modelToolsSupported: false, truncated: false, groups, issues: [] };
  return state;
}

test("Session audio tool opens canonical controls and sends typed nested parameters without a model request", async () => {
  const state = panelState();
  const h = await createDialogHarness(state, undefined, { toolCatalogResponse: async (snapshot) => ({
    ...snapshot, sessionToolCatalog: { ...state.sessionToolCatalog!, sessionId: snapshot.activeSessionId },
  }) });
  try {
    assert.deepEqual(h.errors, [], "The composed dialog must initialize before opening audio tools.");
    h.click("#sessionInspectorScope"); h.click("#toolsTab");
    h.click('.tool-group[data-connection-id="suno-studio"] > summary');
    const entry = '[data-tool-key$=":builtin_suno_generate_music"]';
    h.click(entry + " > summary");
    h.click(entry + " .audio-open-panel");
    assert.ok(h.document.querySelector(".audio-parameter-dialog"));
    assert.match(h.document.querySelector(".audio-parameter-connection")!.textContent!, /Suno Studio/);
    h.select('.audio-parameter-dialog select', "1");
    assert.equal(h.document.querySelector<HTMLTextAreaElement>('[name=".variant.prompt"]')!.labels[0]!.textContent, "Lyrics");
    h.input('[name=".variant.prompt"]', "Streetlights flicker over the sea");
    h.click('[aria-label="Include Weirdness (%)"]');
    h.input('[name=".variant.options.weirdness"]', "42");
    h.click('.audio-parameter-dialog button[type="submit"]');
    await waitForCondition(() => commandCalls(h).length === 1, "Expected direct audio tool command.");
    const command = commandCalls(h)[0]!.body as Record<string, unknown>;
    assert.equal(command.kind, "run_audio_tool");
    assert.equal(command.sessionId, state.activeSessionId);
    assert.equal(command.toolName, "builtin_suno_generate_music");
    assert.deepEqual(command.arguments, { connectionId: "suno-studio", prompt: "Streetlights flicker over the sea",
      instrumental: false, options: { mode: "custom", weirdness: 42 } });
    assert.equal(h.document.querySelector(".audio-parameter-dialog"), null);
    assert.equal(h.calls.some((call) => call.path === "/send"), false);
    await h.settle();
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("cached audio controls remain editable during a model send and run the prepared draft when idle", async () => {
  const state = panelState();
  const h = await createDialogHarness(state);
  let heldSend = false;
  try {
    h.holdNextSend(); heldSend = true;
    h.input("#prompt", "Inspect this track"); h.click("#sendButton");
    await h.settle();
    h.click("#sessionInspectorScope"); h.click("#toolsTab");
    h.click('.tool-group[data-connection-id="suno-studio"] > summary');
    const entry = '[data-tool-key$=":builtin_suno_generate_music"]';
    h.click(entry + " > summary");
    assert.equal(h.document.querySelector<HTMLButtonElement>(entry + " .audio-open-panel")!.disabled, false);
    h.click(entry + " .audio-open-panel");
    const dialog = h.document.querySelector(".audio-parameter-dialog");
    assert.ok(dialog, "Cached audio controls must open while the model is generating.");
    h.select('.audio-parameter-dialog select', "1");
    const prompt = h.document.querySelector<HTMLTextAreaElement>('[name=".variant.prompt"]')!;
    assert.equal(prompt.matches(":disabled"), false);
    h.input('[name=".variant.prompt"]', "Streetlights flicker over the sea");
    h.click('[aria-label="Include Weirdness (%)"]');
    h.input('[name=".variant.options.weirdness"]', "42");
    const form = dialog.querySelector<HTMLFormElement>("form")!;
    const run = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    assert.equal(run.disabled, true);
    form.dispatchEvent(new h.window.Event("submit", { bubbles: true, cancelable: true }));
    assert.equal(commandCalls(h).length, 0);
    assert.equal(h.calls.filter((call) => call.path === "/session-tools").length, 0);
    h.releaseHeldSend(); heldSend = false;
    await h.settle();
    await waitForCondition(() => !run.disabled, "Expected audio tool execution to resume when the send finishes.");
    assert.equal(h.document.querySelector(".audio-parameter-dialog"), dialog);
    assert.equal(prompt.value, "Streetlights flicker over the sea");
    h.click('.audio-parameter-dialog button[type="submit"]');
    await h.settle();
    assert.deepEqual(commandCalls(h).map((call) => call.body), [{
      kind: "run_audio_tool", sessionId: state.activeSessionId, toolName: "builtin_suno_generate_music",
      signature: state.sessionToolCatalog!.groups.flatMap((group) => group.tools)
        .find((tool) => tool.name === "builtin_suno_generate_music")!.audioPanel!.signature,
      arguments: { connectionId: "suno-studio", prompt: "Streetlights flicker over the sea", instrumental: false,
        options: { mode: "custom", weirdness: 42 } },
    }]);
    assert.equal(h.calls.filter((call) => call.path === "/send").length, 1);
    assert.deepEqual(h.errors, []);
  } finally { if (heldSend) h.releaseHeldSend(); await h.settle(); h.close(); }
});

test("an unsupported audio form leaves other tool discovery usable", async () => {
  const state = panelState();
  const group = state.sessionToolCatalog!.groups.find((entry) => entry.connectionId === "suno-studio")!;
  const tool = group.tools.find((entry) => entry.name === "builtin_suno_generate_music")!;
  tool.audioPanel!.schema = { type: "object", properties: { score: { $ref: "#/$defs/score" } }, additionalProperties: false };
  const h = await createDialogHarness(state);
  try {
    h.click("#sessionInspectorScope"); h.click("#toolsTab");
    h.click('.tool-group[data-connection-id="suno-studio"] > summary');
    const entry = '[data-tool-key$=":builtin_suno_generate_music"]';
    h.click(entry + " > summary"); h.click(entry + " .audio-open-panel");
    assert.match(h.document.querySelector(".audio-parameter-dialog")!.textContent!, /cannot be edited/);
    assert.equal(h.document.querySelector('.audio-parameter-dialog button[type="submit"]'), null);
    assert.ok(h.document.querySelectorAll(".audio-open-panel").length > 1);
    assert.deepEqual(commandCalls(h), []);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("the composed dialog accepts owner-projected suggestions with 160-codepoint emoji labels", async () => {
  const state = panelState();
  const clipId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const tool = state.sessionToolCatalog!.groups.flatMap((group) => group.tools).find((entry) => entry.name === "builtin_suno_cover_music")!;
  tool.audioPanel!.suggestions = { clips: [{ id: clipId, label: "🎵".repeat(160) }] };
  const h = await createDialogHarness(state, undefined, { toolCatalogResponse: async (snapshot) => ({
    ...snapshot, sessionToolCatalog: { ...state.sessionToolCatalog!, sessionId: snapshot.activeSessionId },
  }) });
  try {
    h.click("#sessionInspectorScope"); h.click("#toolsTab");
    h.click('.tool-group[data-connection-id="suno-studio"] > summary');
    const entry = '[data-tool-key$=":builtin_suno_cover_music"]';
    h.click(entry + " > summary"); h.click(entry + " .audio-open-panel");
    const option = h.document.querySelector<HTMLOptionElement>(".audio-parameter-dialog datalist option")!;
    assert.equal(option.value, clipId);
    assert.equal(Array.from(option.label).length, 160);
    assert.ok(h.document.querySelector('.audio-parameter-dialog button[type="submit"]'));
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});
