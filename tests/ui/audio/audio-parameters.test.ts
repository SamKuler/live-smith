import assert from "node:assert/strict";
import test from "node:test";
import * as esbuild from "esbuild";
import { JSDOM } from "jsdom";
import { audioParameterGroups } from "../../../src/plugins/builtins/parameter-panel.js";
import { BUILT_IN_AUDIO_PLUGINS } from "../../../src/plugins/builtins/index.js";
import type { AudioParameterPanel, AudioParameterSuggestions } from "../../../src/plugins/builtins/parameter-panel.js";
import type { AudioParameterPanels } from "../../../src/ui/client/audio-parameters.js";

const bundle = (await esbuild.build({ entryPoints: ["src/ui/client/audio-parameters.ts"], bundle: true, platform: "browser", format: "iife", write: false })).outputFiles[0]!.text;
const groups = audioParameterGroups({ services: BUILT_IN_AUDIO_PLUGINS.map((plugin) => ({ id: plugin.provider, name: plugin.provider, provider: plugin.provider, pluginId: plugin.id })), hasJobs: true, identity: (id) => id });
const tools = groups.flatMap((group) => group.tools);
function harness() {
  const dom = new JSDOM("<!doctype html><button id='open'>Open</button>", { runScripts: "outside-only" });
  const state = { activeSessionId: "session-one", integrationConnections: { revision: "1" }, plugins: [], sunoAccounts: [] as { serviceId: string; accountId?: string; status?: string }[], audioJobs: [] as unknown[], events: [] as { kind: string; name?: string; content: string }[] };
  const calls: { kind: string; input: Record<string, unknown>; options: unknown; modal: boolean }[] = [];
  dom.window.eval(bundle);
  const factory = (dom.window as unknown as { LiveSmithFactories: {
    createAudioParameterPanels(deps: unknown): AudioParameterPanels;
    isAudioParameterPanel(value: unknown): boolean;
  } }).LiveSmithFactories;
  const panels = factory.createAudioParameterPanels({ getState: () => state, runCommand: async (kind: string, input: Record<string, unknown>, options: unknown) => {
    calls.push({ kind, input: JSON.parse(JSON.stringify(input)), options: JSON.parse(JSON.stringify(options)), modal: Boolean(dom.window.document.querySelector("dialog")) });
  } });
  const find = <T extends Element = HTMLElement>(selector: string): T => { const result = dom.window.document.querySelector<T>(selector); assert.ok(result, selector); return result; };
  const input = (path: string, value: string | boolean) => {
    const element = find<HTMLInputElement>(`[name='${path}']`);
    if (typeof value === "boolean") element.checked = value; else element.value = value;
    element.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  };
  const selectVariant = (path: string, index: number) => {
    const select = find<HTMLSelectElement>(`[data-variant='${path}']`); select.value = String(index); select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  };
  const include = (path: string) => find<HTMLInputElement>(`[data-parameter-path='${path}'] > .audio-parameter-heading input`).click();
  const submit = () => find<HTMLFormElement>("form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  return { dom, state, calls, panels, factory, find, input, include, submit, selectVariant, close: () => { panels.close(); dom.window.close(); } };
}
function toolContaining(suffix: string, provider = "suno") {
  const group = groups.find((group) => group.connectionId === provider && group.tools.some((tool) => tool.name.endsWith(suffix)));
  assert.ok(group, `${provider} ${suffix}`);
  const tool = group.tools.find((tool) => tool.name.endsWith(suffix))!;
  assert.ok(tool.audioPanel); return { ...tool, audioPanel: tool.audioPanel };
}

function withSuggestions(suffix: string, suggestions: AudioParameterSuggestions) {
  const tool = toolContaining(suffix);
  return { ...tool, audioPanel: { ...tool.audioPanel, suggestions } };
}

test("all canonical built-in manual schemas render a runnable typed form", () => {
  const h = harness();
  try {
    assert.ok(tools.length >= 18);
    for (const tool of tools) {
      assert.ok(tool.audioPanel);
      assert.equal(h.factory.isAudioParameterPanel(tool.audioPanel), true, tool.name);
      h.panels.open({ ...tool, audioPanel: tool.audioPanel });
      assert.ok(h.dom.window.document.querySelector("button[type=submit]"), tool.name);
      assert.equal(h.dom.window.document.querySelector("[name$=connectionId]"), null);
    }
  } finally { h.close(); }
});

test("custom lyrics emits nested numbers and booleans and closes before the command", () => {
  const h = harness();
  try {
    const tool = toolContaining("generate_music"); h.panels.open(tool, "Music account");
    h.selectVariant("", 1); h.input(".variant.prompt", "[Verse]\nMoonlit road");
    h.input(".variant.instrumental", false); h.include(".variant.options.weirdness"); h.input(".variant.options.weirdness", "42.5");
    h.include(".variant.options.styles"); h.input(".variant.options.styles", "Jazz");
    h.submit();
    assert.deepEqual(h.calls, [{ kind: "run_audio_tool", input: { sessionId: "session-one", toolName: tool.audioPanel.toolName, signature: tool.audioPanel.signature,
      arguments: { connectionId: "suno", prompt: "[Verse]\nMoonlit road", instrumental: false, options: { mode: "custom", weirdness: 42.5, styles: "Jazz" } } }, options: { cancellable: true }, modal: false }]);
  } finally { h.close(); }
});

test("switching variants omits inactive options while preserving branch drafts", () => {
  const h = harness();
  try {
    const tool = toolContaining("generate_music"); h.panels.open(tool); h.selectVariant("", 1); h.input(".variant.prompt", "Lyrics");
    h.include(".variant.options.styles"); h.input(".variant.options.styles", "Ambient");
    h.selectVariant("", 0); h.input(".variant.prompt", "A quiet piano piece"); h.input(".variant.instrumental", true); h.submit();
    assert.deepEqual(h.calls[0]!.input.arguments, { connectionId: "suno", prompt: "A quiet piano piece", instrumental: true });
    h.panels.open(tool); h.selectVariant("", 1);
    assert.equal(h.find<HTMLInputElement>("[name='.variant.options.styles']").value, "Ambient");
    assert.equal(h.find<HTMLTextAreaElement>("[name='.variant.prompt']").value, "Lyrics");
  } finally { h.close(); }
});

test("numeric limits and omitted optional fields are validated through DOM submission", () => {
  const h = harness();
  try {
    const tool = toolContaining("generate_music"); h.panels.open(tool); h.selectVariant("", 1); h.input(".variant.prompt", "Lyrics");
    h.include(".variant.options.weirdness"); h.input(".variant.options.weirdness", "101"); h.submit(); assert.equal(h.calls.length, 0);
    assert.equal(h.find<HTMLInputElement>("[name='.variant.options.weirdness']").validity.customError, true);
    h.include(".variant.options.weirdness"); h.submit(); assert.equal(h.calls.length, 1);
    assert.deepEqual((h.calls[0]!.input.arguments as Record<string, unknown>).options, { mode: "custom" });
  } finally { h.close(); }
});

test("array rows enforce item patterns, duplicates, and maximum size", () => {
  const h = harness();
  try {
    h.panels.open(toolContaining("retrieve_music")); h.input("clipIds.0", "bad"); h.submit(); assert.equal(h.calls.length, 0);
    const uuid = "00000000-0000-0000-0000-000000000001"; h.input("clipIds.0", uuid);
    const add = [...h.dom.window.document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Add item")!; add.click(); assert.equal(add.disabled, true);
    h.input("clipIds.1", uuid); h.submit(); assert.equal(h.calls.length, 0);
    h.input("clipIds.1", "00000000-0000-0000-0000-000000000002"); h.submit();
    assert.deepEqual((h.calls[0]!.input.arguments as Record<string, unknown>).clipIds, [uuid, "00000000-0000-0000-0000-000000000002"]);
  } finally { h.close(); }
});

test("nested source variants and enum checkbox arrays construct exact arguments", () => {
  const h = harness();
  try {
    const tool = toolContaining("separate_stems", "lalal"); h.panels.open(tool);
    h.selectVariant("source", 1); h.input("source.variant.startBeat", "4.5"); h.input("source.variant.endBeat", "8");
    const stems = [...h.find("[data-parameter-path=stems]").querySelectorAll<HTMLInputElement>(".audio-parameter-choice input")];
    for (const item of stems) if (item.checked) item.click(); stems[1]!.click(); stems[2]!.click(); h.submit();
    const args = h.calls[0]!.input.arguments as Record<string, unknown>;
    assert.deepEqual(args.source, { kind: "arrangement_audio", startBeat: 4.5, endBeat: 8 }); assert.equal((args.stems as unknown[]).length, 2);
    assert.equal(JSON.stringify(args).includes("request_audio_attachment"), false);
  } finally { h.close(); }
});

test("owner changes discard drafts and stale forms cannot submit", () => {
  const h = harness();
  try {
    const tool = toolContaining("generate_music"); h.panels.open(tool); h.input(".variant.prompt", "Private draft");
    const stale = h.find<HTMLFormElement>("form"); h.state.activeSessionId = "session-two"; h.panels.sync();
    stale.dispatchEvent(new h.dom.window.Event("submit", { bubbles: true, cancelable: true })); assert.equal(h.calls.length, 0);
    h.panels.open(tool); assert.equal(h.find<HTMLInputElement>("[name='.variant.prompt']").value, "");
    h.panels.setBusy(true); assert.equal(h.dom.window.document.querySelector("dialog"), null);
    h.panels.open(tool); assert.equal(h.dom.window.document.querySelector("dialog"), null);
  } finally { h.close(); }
});

test("unsupported schema shows an explicit error without a Run action", () => {
  const h = harness();
  try {
    const audioPanel: AudioParameterPanel = { toolName: "audio_test", signature: "a".repeat(64), schema: { type: "object", properties: {}, additionalProperties: false, anyOf: [{}] } };
    h.panels.open({ name: "Test", audioPanel });
    assert.match(h.find("form").textContent!, /cannot be edited/); assert.equal(h.dom.window.document.querySelector("button[type=submit]"), null);
  } finally { h.close(); }
});

test("library query branches emit only their declared fields", () => {
  const h = harness();
  try {
    const tool = toolContaining("inspect_music_service"); h.panels.open(tool); h.selectVariant("", 1);
    h.include(".variant.search"); h.input(".variant.search", "piano"); h.submit();
    assert.deepEqual(h.calls[0]!.input.arguments, { connectionId: "suno", query: "library", search: "piano" });
    h.panels.open(tool); h.selectVariant("", 2); h.input(".variant.personaId", "00000000-0000-0000-0000-000000000001"); h.submit();
    assert.deepEqual(h.calls[1]!.input.arguments, { connectionId: "suno", query: "persona", personaId: "00000000-0000-0000-0000-000000000001" });
    h.panels.open(tool); h.selectVariant("", 0); h.submit();
    assert.deepEqual(h.calls[2]!.input.arguments, { connectionId: "suno", query: "catalog" });
  } finally { h.close(); }
});

test("clip suggestions consume host evidence and ignore raw historical jobs and results", () => {
  const h = harness();
  try {
    const saved = "00000000-0000-0000-0000-000000000001";
    const library = "00000000-0000-0000-0000-000000000002";
    const other = "00000000-0000-0000-0000-000000000003";
    h.state.audioJobs = [
      { serviceId: "suno", title: "Saved clip", remoteOutputs: [{ key: saved }] },
      { serviceId: "other", remoteOutputs: [{ key: other }] },
    ];
    const name = "builtin_suno_inspect_music_service";
    h.state.events = [
      { kind: "tool_call", name, content: JSON.stringify({ connectionId: "suno", query: "library" }) },
      { kind: "tool_result", name, content: JSON.stringify({ query: "library", clips: [{ id: library, title: "Library clip" }] }) },
      { kind: "tool_call", name, content: JSON.stringify({ connectionId: "other", query: "library" }) },
      { kind: "tool_result", name, content: JSON.stringify({ query: "library", clips: [{ id: other }] }) },
    ];
    h.panels.open(withSuggestions("retrieve_music", { clips: [{ id: saved, label: "Saved clip" }, { id: library, label: "Library clip" }] }));
    assert.deepEqual([...h.dom.window.document.querySelectorAll<HTMLOptionElement>("datalist option")].map((option) => option.value), [saved, library]);
    assert.equal(h.find<HTMLInputElement>("[name='clipIds.0']").value, "", "suggestions do not silently select an asset");
  } finally { h.close(); }
});

test("object and array defaults retain scalar types in the emitted command", () => {
  const h = harness();
  try {
    const audioPanel: AudioParameterPanel = { toolName: "typed_tool", signature: "b".repeat(64), schema: {
      type: "object", additionalProperties: false, properties: {
        options: { type: "object", additionalProperties: false, properties: { enabled: { type: "boolean" } }, default: { enabled: true } },
        values: { type: "array", items: { type: "number" }, default: [1, 2.5] },
      },
    } };
    h.panels.open({ name: "Typed", audioPanel }); h.submit();
    assert.deepEqual(h.calls[0]!.input.arguments, { options: { enabled: true }, values: [1, 2.5] });
  } finally { h.close(); }
});

test("sound sample, cover and remaster panels submit their typed operation fields", () => {
  const h = harness();
  try {
    h.panels.open(toolContaining("generate_sound_sample")); h.input("prompt", "Tight drum loop"); h.input("loop", true);
    h.include("bpm"); h.input("bpm", "120.5"); h.submit(); assert.equal(h.calls.length, 0);
    h.input("bpm", "120"); h.include("key"); h.input("key", "12"); h.submit();
    assert.deepEqual(h.calls[0]!.input.arguments, { connectionId: "suno", prompt: "Tight drum loop", loop: true, bpm: 120, key: "Cm" });
    const clipId = "00000000-0000-0000-0000-000000000001";
    h.panels.open(toolContaining("cover_music")); h.input("clipId", clipId); h.input("prompt", "New verse"); h.input("instrumental", false);
    h.include("options"); h.include("options.audioInfluence"); h.input("options.audioInfluence", "65"); h.submit();
    assert.deepEqual(h.calls[1]!.input.arguments, { connectionId: "suno", clipId, prompt: "New verse", instrumental: false, options: { mode: "custom", audioInfluence: 65 } });
    h.panels.open(toolContaining("remaster_music")); h.input("clipId", clipId); h.include("variation"); h.input("variation", "2"); h.submit();
    assert.deepEqual(h.calls[2]!.input.arguments, { connectionId: "suno", clipId, variation: "high" });
  } finally { h.close(); }
});

test("Suno editing panels emit exact candidate and replacement arguments", () => {
  const h = harness();
  try {
    const clipId = "00000000-0000-0000-0000-000000000001";
    for (const operation of ["add_vocals", "add_instrumental"] as const) {
      h.panels.open(toolContaining(operation)); h.input("clipId", clipId); h.input("prompt", "A new melody"); h.submit();
      assert.deepEqual(h.calls.at(-1)!.input.arguments, { connectionId: "suno", clipId, prompt: "A new melody" });
    }
    h.panels.open(toolContaining("replace_music_section")); h.input("clipId", clipId);
    h.input("startSeconds", "15.5"); h.input("endSeconds", "35.5"); h.input("prompt", "New chorus");
    h.include("contextStartSeconds"); h.input("contextStartSeconds", "5"); h.submit();
    assert.deepEqual(h.calls.at(-1)!.input.arguments, { connectionId: "suno", clipId, startSeconds: 15.5, endSeconds: 35.5, prompt: "New chorus", contextStartSeconds: 5 });
    h.panels.open(toolContaining("finish_music_replacement")); h.input("clipId", clipId); h.submit();
    assert.deepEqual(h.calls.at(-1)!.input.arguments, { connectionId: "suno", clipId });
  } finally { h.close(); }
});

test("model and Persona suggestions use only host-projected values", () => {
  const h = harness();
  try {
    const name = "builtin_suno_inspect_music_service";
    const personaId = "00000000-0000-0000-0000-000000000004";
    h.state.events = [
      { kind: "tool_call", name, content: JSON.stringify({ connectionId: "suno", query: "catalog" }) },
      { kind: "tool_result", name, content: JSON.stringify({ query: "catalog", models: [{ id: "generation-model" }], remasterModels: [{ id: "remaster-one", name: "Remaster One", canUse: true }, { id: "unavailable", canUse: false }] }) },
      { kind: "tool_call", name, content: JSON.stringify({ connectionId: "other", query: "catalog" }) },
      { kind: "tool_result", name, content: JSON.stringify({ query: "catalog", remasterModels: [{ id: "other-account" }] }) },
      { kind: "tool_call", name, content: JSON.stringify({ connectionId: "suno", query: "persona", personaId }) },
      { kind: "tool_result", name, content: JSON.stringify({ query: "persona", persona: { id: personaId, name: "Warm vocals" } }) },
    ];
    h.panels.open(withSuggestions("remaster_music", { models: [{ id: "remaster-one", label: "Remaster One" }] }));
    const model = h.find<HTMLInputElement>("[name=modelId]");
    assert.deepEqual([...h.find(`#${model.getAttribute("list")}`).querySelectorAll("option")].map((option) => option.value), ["remaster-one"]);
    h.panels.open(withSuggestions("generate_music", { personas: [{ id: personaId, label: "Warm vocals" }] })); h.selectVariant("", 1);
    const persona = h.find<HTMLInputElement>("[name='.variant.options.personaId']");
    assert.deepEqual([...h.find(`#${persona.getAttribute("list")}`).querySelectorAll("option")].map((option) => option.value), [personaId]);
    assert.equal(model.value, ""); assert.equal(persona.value, "");
  } finally { h.close(); }
});

test("lyrics model suggestions stay separate from music models and preserve optional fields", () => {
  const h = harness();
  try {
    const name = "builtin_suno_inspect_lyric_models";
    h.state.events = [
      { kind: "tool_call", name, content: JSON.stringify({ connectionId: "suno" }) },
      { kind: "tool_result", name, content: JSON.stringify({ query: "lyric_models", models: [{ id: "lyric-model", name: "Lyric writer" }] }) },
      { kind: "tool_call", name, content: JSON.stringify({ connectionId: "other" }) },
      { kind: "tool_result", name, content: JSON.stringify({ query: "lyric_models", models: [{ id: "other-model" }] }) },
    ];
    h.panels.open(withSuggestions("write_lyrics", { models: [{ id: "lyric-model", label: "Lyric writer" }] }));
    const model = h.find<HTMLInputElement>("[name=modelId]");
    assert.deepEqual([...h.find(`#${model.getAttribute("list")}`).querySelectorAll("option")].map((option) => option.value), ["lyric-model"]);
    h.input("selected", ""); h.input("instruction", "A song about the harbor"); h.include("mode"); h.input("mode", "1"); h.submit();
    assert.deepEqual(h.calls[0]!.input.arguments, { connectionId: "suno", selected: "", instruction: "A song about the harbor", mode: "alternatives" });
  } finally { h.close(); }
});

test("upload form exposes an unchecked explicit rights choice and submits an existing audio source", () => {
  const h = harness();
  try {
    h.panels.open(toolContaining("upload_music"));
    assert.equal(h.find<HTMLInputElement>("[name=rightsConfirmed]").checked, false);
    h.input("source.variant.assetRef", "saved-audio"); h.input("rightsConfirmed", true); h.submit();
    assert.deepEqual(h.calls[0]!.input.arguments, { connectionId: "suno", source: { kind: "audio_asset", assetRef: "saved-audio" }, rightsConfirmed: true });
  } finally { h.close(); }
});

test("Suno account changes close stale controls and clear drafts while same-account refresh retains them", () => {
  const h = harness();
  try {
    h.state.sunoAccounts = [{ serviceId: "suno", accountId: "account-A", status: "saved" }];
    const tool = toolContaining("generate_music"); h.panels.open(tool);
    h.input(".variant.prompt", "Account A draft");
    const form = h.find<HTMLFormElement>("form");
    h.state.sunoAccounts = [{ serviceId: "suno", accountId: "account-A", status: "signed_in" }]; h.panels.sync();
    assert.equal(h.find("form"), form);
    assert.equal(h.find<HTMLTextAreaElement>("[name='.variant.prompt']").value, "Account A draft");
    h.state.sunoAccounts = [{ serviceId: "suno", accountId: "account-B", status: "signed_in" }]; h.panels.sync();
    assert.equal(h.dom.window.document.querySelector("dialog"), null);
    form.dispatchEvent(new h.dom.window.Event("submit", { bubbles: true, cancelable: true }));
    assert.equal(h.calls.length, 0);
    h.panels.open({ ...tool, audioPanel: { ...tool.audioPanel, signature: "b".repeat(64) } });
    assert.equal(h.find<HTMLTextAreaElement>("[name='.variant.prompt']").value, "");
  } finally { h.close(); }
});

test("owner-bound suggestions do not inherit an old account's same-connection history or jobs", () => {
  const h = harness();
  try {
    const oldId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", currentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    h.state.sunoAccounts = [{ serviceId: "suno", accountId: "account-B" }];
    h.state.audioJobs = [{ serviceId: "suno", title: "Old account", remoteOutputs: [{ key: oldId }] }];
    h.state.events = [
      { kind: "tool_call", name: "builtin_suno_inspect_music_service", content: JSON.stringify({ connectionId: "suno", query: "library" }) },
      { kind: "tool_result", name: "builtin_suno_inspect_music_service", content: JSON.stringify({ query: "library", clips: [{ id: oldId, title: "Old account" }] }) },
    ];
    const tool = withSuggestions("cover_music", { clips: [{ id: currentId, label: "🎵".repeat(160) }] });
    assert.equal(h.factory.isAudioParameterPanel(tool.audioPanel), true);
    h.panels.open(tool);
    assert.deepEqual([...h.dom.window.document.querySelectorAll<HTMLOptionElement>("datalist option")].map((option) => option.value), [currentId]);
    h.panels.open(toolContaining("cover_music"));
    assert.equal(h.dom.window.document.querySelector("datalist"), null);
  } finally { h.close(); }
});
