import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { URL } from "node:url";
import { audioStorageHarness } from "../../storage/support/audio-storage-test-helpers.js";
import { midiBytes, noteTrack } from "../../attachments/support/midi-test-helpers.js";
import { saveMidiArtifact } from "../../../src/storage/midi-artifacts.js";
import { listSessionArtifacts } from "../../../src/app/session/session-artifacts.js";
import type { SessionArtifact, SessionArtifacts } from "../../../src/app/session/session-artifacts.js";
import { cloneState, commandCalls, createDialogHarness, stateFixture, waitForCondition } from "../support/chat-dialog.test-harness.js";

type Query = { sessionId: string; offset: number; query?: string };
const audio = (id: string, label: string): SessionArtifact => ({ ref: { kind: "audio", id }, label,
  createdAt: "2026-10-03T00:00:00Z", sourceLabel: "Music generator", audio: { durationSeconds: 32, mediaType: "audio/wav" } });
const all = [audio("audio-a", "Arrangement"), audio("audio-b", "晨光")];
const page = (input: Query, artifacts = all, total = artifacts.length): SessionArtifacts => ({ ...input, artifacts, total, unavailableCount: 0 });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function setup(read: (input: Query) => SessionArtifacts | Promise<SessionArtifacts> = (input) => page(input)) {
  const state = stateFixture(); state.openSettingsOnLoad = false; state.settings.uiLanguage = "en";
  const h = await createDialogHarness(state);
  const reads: { input: Query; signal: AbortSignal | null | undefined }[] = [];
  const original = h.window.fetch;
  Object.defineProperty(h.window, "fetch", { configurable: true, value: async (input: string, init?: RequestInit) => {
    const route = new URL(String(input)).pathname;
    if (route === "/session-artifacts") {
      const body = JSON.parse(String(init?.body)) as Query; reads.push({ input: body, signal: init?.signal });
      const result = await read(body); return { ok: true, json: async () => result };
    }
    return original(input, init);
  } });
  h.click("#artifactsTab");
  await waitForCondition(() => reads.length === 1, "Expected initial artifact read");
  await h.settle();
  return { h, state, reads };
}
function action(h: Awaited<ReturnType<typeof setup>>["h"], label: string) {
  const button = [...h.document.querySelectorAll<HTMLButtonElement>("#artifactLibrary button")].find((entry) => entry.textContent === label);
  assert.ok(button, label); button.click();
}
const labels = (h: Awaited<ReturnType<typeof setup>>["h"]) => [...h.document.querySelectorAll(".artifact-open")].map((entry) => entry.textContent);

test("searching the displayed Chinese source retrieves the saved artifact through the real catalog", async (t) => {
  const storage = await audioStorageHarness(t);
  const midi = await saveMidiArtifact(storage.storage, storage.session.id, { connectionId: "generator", serverId: "midi", toolName: "make",
    label: "Prelude", bytes: midiBytes({ tracks: [noteTrack()] }), signal: storage.signal });
  const fixture = stateFixture(); fixture.settings.uiLanguage = "zh-CN";
  const state = { ...fixture, activeSessionId: storage.session.id, openSettingsOnLoad: false,
    sessions: [{ ...fixture.sessions[0]!, id: storage.session.id }] };
  const h = await createDialogHarness(state);
  const original = h.window.fetch;
  Object.defineProperty(h.window, "fetch", { configurable: true, value: async (input: string, init?: RequestInit) => {
    if (new URL(String(input)).pathname === "/session-artifacts") {
      const query = JSON.parse(String(init?.body)) as Query;
      const result = await listSessionArtifacts({ ...query, storageDirectory: storage.storage, signal: storage.signal });
      return { ok: true, json: async () => result };
    }
    return original(input, init);
  } });
  try {
    h.click("#artifactsTab"); await waitForCondition(() => labels(h).length === 1, "Expected stored artifact");
    h.click(".artifact-open"); assert.match(h.document.querySelector(".artifact-card")!.textContent!, /插件生成/);
    h.input("#artifactSearch", "插件生成");
    await waitForCondition(() => labels(h).length === 1, "Expected source translation to retrieve its artifact");
    assert.deepEqual(labels(h), ["Prelude"]);
    assert.equal(h.document.querySelector<HTMLElement>(".artifact-open")!.dataset.artifactKey, `midi:${midi.id}`);
    h.click(".artifact-open"); assert.match(h.document.querySelector(".artifact-card")!.textContent!, /插件生成/);
    assert.deepEqual(commandCalls(h), []); assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("artifact search debounces trimmed query reads, defers IME and Escape restores the catalog", async () => {
  const { h, reads } = await setup((input) => page(input, input.query ? [all[1]!] : all));
  try {
    const search = h.document.querySelector<HTMLInputElement>("#artifactSearch"); assert.ok(search);
    assert.ok(h.document.querySelector('label[for="artifactSearch"]')); assert.equal(search.maxLength, 200);
    h.input("#artifactSearch", "晨"); h.input("#artifactSearch", " 晨光 ");
    assert.deepEqual(labels(h), []); assert.equal(reads.length, 1);
    await waitForCondition(() => reads.length === 2, "Expected debounced search"); await h.settle();
    assert.equal(reads[1]!.input.query, "晨光"); assert.equal(reads[1]!.input.offset, 0); assert.deepEqual(labels(h), ["晨光"]);
    search.dispatchEvent(new h.window.CompositionEvent("compositionstart", { bubbles: true }));
    h.input("#artifactSearch", "晨光曲");
    await new Promise((resolve) => h.window.setTimeout(resolve, 210)); assert.equal(reads.length, 2);
    search.dispatchEvent(new h.window.CompositionEvent("compositionend", { bubbles: true }));
    await waitForCondition(() => reads.length === 3, "Expected committed IME query");
    search.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await waitForCondition(() => reads.length === 4, "Expected cleared query read"); await h.settle();
    assert.equal(search.value, ""); assert.equal(reads[3]!.input.query, undefined); assert.deepEqual(labels(h), ["Arrangement", "晨光"]);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

for (const outcome of ["success", "error"] as const) test(`obsolete artifact search ${outcome} cannot replace a cleared query`, async () => {
  const held = deferred<SessionArtifacts>();
  const { h, reads } = await setup((input) => input.query === "old" ? held.promise : page(input, input.query ? [all[1]!] : all));
  try {
    h.input("#artifactSearch", "old"); await waitForCondition(() => reads.length === 2, "Expected held query");
    h.input("#artifactSearch", "晨光"); assert.equal(reads[1]!.signal?.aborted, true);
    await waitForCondition(() => reads.length === 3, "Expected replacement query"); await h.settle();
    assert.deepEqual(labels(h), ["晨光"]);
    h.input("#artifactSearch", ""); await waitForCondition(() => reads.length === 4, "Expected clear"); await h.settle();
    if (outcome === "success") held.resolve(page(reads[1]!.input, [audio("stale", "Stale result")])); else held.reject(new Error("Stale search failure"));
    await h.settle(); assert.deepEqual(labels(h), ["Arrangement", "晨光"]);
    assert.doesNotMatch(h.document.querySelector("#artifactLibrary")!.textContent!, /Stale/);
    assert.deepEqual(h.errors, []);
  } finally { held.resolve(page({ sessionId: "session-1", offset: 0 })); h.close(); }
});

test("artifact query survives pagination, failure retry, refresh and locale changes", async () => {
  let fail = true;
  const { h, state, reads } = await setup((input) => {
    if (input.query && input.offset === 24 && fail) { fail = false; throw new Error("Search page unavailable"); }
    return page(input, input.offset ? [audio("last", "Last match")] : all, 25);
  });
  try {
    h.input("#artifactSearch", "music"); await waitForCondition(() => reads.length === 2, "Expected search"); await h.settle();
    action(h, "Next page"); await h.settle(); assert.match(h.document.querySelector("#artifactLibrary")!.textContent!, /Saved artifacts are unavailable/);
    action(h, "Next page"); await waitForCondition(() => reads.length === 4, "Expected page retry"); await h.settle();
    assert.deepEqual(labels(h), ["Last match"]); assert.deepEqual(reads.slice(2).map((entry) => [entry.input.query, entry.input.offset]), [["music", 24], ["music", 24]]);
    action(h, "Refresh artifacts"); await waitForCondition(() => reads.length === 5, "Expected query refresh"); await h.settle();
    assert.equal(reads[4]!.input.query, "music"); assert.equal(reads[4]!.input.offset, 24);
    const search = h.document.querySelector<HTMLInputElement>("#artifactSearch")!;
    h.emitServerEvent({ type: "global_settings_changed", defaultFollowUpBehavior: state.settings.defaultFollowUpBehavior,
      defaultFollowUpBehaviorRevision: state.settings.defaultFollowUpBehaviorRevision, showContextUsage: state.settings.showContextUsage,
      contextUsageVisibilityRevision: state.settings.contextUsageVisibilityRevision, uiLanguage: "zh-CN", uiLanguageRevision: "1", commandId: "search-language" });
    await h.settle(); assert.equal(h.document.querySelector("#artifactSearch"), search); assert.equal(search.value, "music");
    assert.deepEqual(labels(h), ["Last match"]); assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

for (const scenario of [
  { initial: 25, remaining: 24, offset: 0 },
  { initial: 25, remaining: 0, offset: 0 },
  { initial: 49, remaining: 26, offset: 24 },
]) test(`artifact search recovers its last valid page when the catalog shrinks from ${scenario.initial} to ${scenario.remaining} works`, async (t) => {
  const storage = await audioStorageHarness(t);
  const saved = [];
  for (let index = 0; index < scenario.initial; index++) saved.push(await saveMidiArtifact(storage.storage, storage.session.id, {
    connectionId: "generator", serverId: "midi", toolName: "make", label: `Melody ${index}`,
    bytes: midiBytes({ tracks: [noteTrack()] }), signal: storage.signal,
  }));
  const state = stateFixture(); state.openSettingsOnLoad = false; state.settings.uiLanguage = "en";
  state.activeSessionId = storage.session.id; state.sessions = [{ ...state.sessions[0]!, id: storage.session.id }];
  const h = await createDialogHarness(state);
  const pages: SessionArtifacts[] = [];
  const original = h.window.fetch;
  Object.defineProperty(h.window, "fetch", { configurable: true, value: async (input: string, init?: RequestInit) => {
    if (new URL(String(input)).pathname === "/session-artifacts") {
      const query = JSON.parse(String(init?.body)) as Query;
      const result = await listSessionArtifacts({ ...query, storageDirectory: storage.storage, signal: storage.signal });
      pages.push(result); return { ok: true, json: async () => result };
    }
    return original(input, init);
  } });
  try {
    h.click("#artifactsTab"); await waitForCondition(() => pages.length === 1, "Expected initial catalog"); await h.settle();
    h.input("#artifactSearch", "Melody");
    await waitForCondition(() => pages.length === 2, "Expected filtered catalog"); await h.settle();
    const lastOffset = Math.floor((scenario.initial - 1) / 24) * 24;
    for (let offset = 24; offset <= lastOffset; offset += 24) {
      action(h, "Next page"); await waitForCondition(() => pages.at(-1)?.offset === offset, "Expected next search page"); await h.settle();
    }
    for (const artifact of saved.slice(scenario.remaining)) {
      await fs.unlink(path.join(storage.storage, "live-smith-midi", storage.session.id, `${artifact.id}.mid`));
    }
    const beforeRefresh = pages.length;
    action(h, "Refresh artifacts");
    await waitForCondition(() => pages.at(-1)?.total === scenario.remaining && pages.at(-1)?.offset === scenario.offset,
      "Expected the last valid page after the catalog shrinks");
    await h.settle();
    assert.deepEqual(pages.slice(beforeRefresh).map((page) => [page.query, page.offset]), [["Melody", lastOffset], ["Melody", scenario.offset]]);
    assert.equal(labels(h).length, Math.min(24, scenario.remaining - scenario.offset));
    assert.equal(h.document.querySelector<HTMLInputElement>("#artifactSearch")!.value, "Melody");
    action(h, "Refresh artifacts");
    await waitForCondition(() => pages.length === beforeRefresh + 3, "Expected refresh to retain the recovered page"); await h.settle();
    assert.equal(pages.at(-1)!.offset, scenario.offset);
    assert.deepEqual(commandCalls(h), []); assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("opening an exact artifact from chat clears an active filter and keeps the revealed artifact actionable", async () => {
  const saved: SessionArtifact = { ref: { kind: "midi", id: "saved-midi" }, label: "Chat melody", sourceLabel: "MIDI generator",
    createdAt: "2026-10-03T00:00:00Z", midi: { durationBeats: 4, noteCount: 1, omittedNoteCount: 0,
      parts: [{ id: "part-1", channel: 1, sourceTrackIndex: 0, noteCount: 1, durationBeats: 4 }],
      notes: [{ pitch: 60, startTime: 0, duration: 1, partId: "part-1" }] } };
  const { h, reads } = await setup((input) => page(input, []));
  const original = h.window.fetch;
  Object.defineProperty(h.window, "fetch", { configurable: true, value: async (input: string, init?: RequestInit) => {
    if (new URL(String(input)).pathname === "/session-artifact") return { ok: true, json: async () => ({ sessionId: "session-1", artifact: saved }) };
    return original(input, init);
  } });
  try {
    h.input("#artifactSearch", "different"); await waitForCondition(() => reads.length === 2, "Expected active filter"); await h.settle();
    assert.match(h.document.querySelector("#artifactLibrary")!.textContent!, /No matching artifacts/);
    h.click("#closeArtifactsButton");
    const state = cloneState(h.readBootstrappedClientStateReference());
    state.events.push({ id: "saved-result", kind: "tool_result", content: "Saved", name: "save_midi_artifact", outcome: "success",
      createdAt: "2026-10-03T00:00:00Z", artifacts: [saved.ref] });
    h.setServerState(state); h.emitServerEvent({ type: "session_state_invalidated", sessionId: state.activeSessionId }); await h.settle();
    await waitForCondition(() => Boolean(h.document.querySelector(".chat-midi-preview .piano-roll-note")), "Expected chat artifact preview");
    const open = [...h.document.querySelectorAll<HTMLButtonElement>(".chat-midi-preview button")].find((entry) => entry.textContent === "Open artifact")!;
    open.click(); await h.settle();
    assert.equal(h.document.querySelector<HTMLInputElement>("#artifactSearch")!.value, "");
    assert.equal(h.document.querySelector(".artifact-open")!.getAttribute("aria-expanded"), "true");
    action(h, "Export MIDI"); await h.settle();
    assert.deepEqual(commandCalls(h).at(-1)!.body, { kind: "export_artifact", sessionId: "session-1", artifact: saved.ref });
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("Session switches clear the local artifact query and reject the previous Session's delayed failure", async () => {
  const held = deferred<SessionArtifacts>();
  const { h, reads } = await setup((input) => input.query ? held.promise : page(input, input.sessionId === "session-2" ? [] : all));
  try {
    h.input("#artifactSearch", "old"); await waitForCondition(() => reads.length === 2, "Expected held search");
    h.click('.session-entry[data-session-id="session-2"] .session-row'); await h.settle();
    assert.equal(h.document.querySelector<HTMLInputElement>("#artifactSearch")!.value, "");
    held.reject(new Error("Previous Session failed")); await h.settle();
    assert.deepEqual(labels(h), []); assert.doesNotMatch(h.document.querySelector("#artifactLibrary")!.textContent!, /Previous Session/);
    assert.equal(reads.at(-1)!.input.query, undefined); assert.equal(reads.at(-1)!.input.sessionId, "session-2");
    assert.deepEqual(h.errors, []);
  } finally { held.resolve(page({ sessionId: "session-1", offset: 0 })); h.close(); }
});

for (const kind of ["export_artifact", "select_artifact"] as const) test(`a matching old version keeps its exact ${kind} identity while typing preserves the pending mutation`, async () => {
  const first = { ...audio("audio-v1", "Older sketch"), version: { groupId: "audio-v1", groupLabel: "Work", number: 1 },
    primary: { kind: "audio" as const, id: "audio-v2" }, versions: [
      { id: "audio-v1", label: "Older sketch", number: 1, createdAt: "2026-10-03T00:00:00Z" },
      { id: "audio-v2", label: "Final", number: 2, createdAt: "2026-10-03T00:01:00Z" },
    ] };
  const { h, reads } = await setup((input) => page(input, [first]));
  const held = deferred<void>(); const original = h.window.fetch; let transfers = 0;
  Object.defineProperty(h.window, "fetch", { configurable: true, value: async (input: string, init?: RequestInit) => {
    if (new URL(String(input)).pathname === "/command" && JSON.parse(String(init?.body)).kind === kind) {
      transfers++; await held.promise;
    }
    return original(input, init);
  } });
  try {
    h.input("#artifactSearch", "sketch"); await waitForCondition(() => reads.length === 2, "Expected old-version result"); await h.settle();
    h.click(".artifact-open"); assert.equal(h.document.querySelector<HTMLSelectElement>(".artifact-version-select")!.value, "audio-v1");
    action(h, kind === "export_artifact" ? "Export audio" : "Make primary"); await waitForCondition(() => transfers === 1, "Expected held artifact mutation");
    h.input("#artifactSearch", "Work"); await new Promise((resolve) => h.window.setTimeout(resolve, 210));
    assert.equal(reads.length, 2, "A new query waits for the active mutation");
    held.resolve(); await waitForCondition(() => reads.length === 3, "Expected pending query after mutation"); await h.settle();
    assert.deepEqual(commandCalls(h).at(-1)!.body, kind === "export_artifact"
      ? { kind, sessionId: reads[0]!.input.sessionId, artifact: { kind: "audio", id: "audio-v1" } }
      : { kind, sessionId: reads[0]!.input.sessionId, selection: { action: "primary", group: { kind: "audio", id: "audio-v1" }, candidate: { kind: "audio", id: "audio-v1" } } });
    assert.equal(reads[2]!.input.query, "Work"); assert.deepEqual(h.errors, []);
  } finally { held.resolve(); h.close(); }
});
