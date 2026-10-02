import assert from "node:assert/strict";
import test from "node:test";
import { URL } from "node:url";
import type { SessionCandidate } from "../../../src/app/session/session-candidates.js";
import type { CandidateSelection } from "../../../src/agent/candidate-contracts.js";
import { cloneState, commandCalls, createDialogHarness, jsonCalls, stateFixture, waitForCondition } from "../support/chat-dialog.test-harness.js";

const candidates: SessionCandidate[] = [
  { ref: { kind: "midi", id: "midi-a" }, label: "Piano variation", createdAt: "2026-10-03T00:00:00Z", sourceLabel: "MIDI generator", preferred: false,
    generation: { toolName: "make", callEventId: "call-a", resultEventId: "result-a", parameters: '{"seed":12}', parametersTruncated: false },
    midi: { durationBeats: 8, noteCount: 2, parts: [{ id: "track-0-channel-1", sourceTrackIndex: 0, channel: 1, sourceTrackName: "Piano", noteCount: 2, durationBeats: 8 }],
      notes: [{ pitch: 60, startTime: 0, duration: 1 }, { pitch: 64, startTime: 2, duration: 1 }], omittedNoteCount: 0 } },
  { ref: { kind: "audio", id: "audio-b" }, label: "Warm arrangement", createdAt: "2026-10-03T00:00:01Z", sourceLabel: "Music generator", preferred: false,
    parent: { kind: "midi", id: "midi-a" }, audio: { durationSeconds: 32, mediaType: "audio/wav", jobId: "job-b" } },
];

async function setup(defer = false, entries: SessionCandidate[] = candidates) {
  const state = stateFixture(); state.openSettingsOnLoad = false;
  let playCount = 0; let readCount = 0; let preferred: CandidateSelection["candidate"] = null; let continuation: CandidateSelection["candidate"] = null;
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  const h = await createDialogHarness(state, undefined, { beforeParse(window) {
    Object.defineProperty(window.HTMLMediaElement.prototype, "play", { configurable: true, value: async () => { playCount++; } });
  } });
  const originalFetch = h.window.fetch;
  Object.defineProperty(h.window, "fetch", { configurable: true, value: async (input: string, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (path === "/session-candidates") {
      readCount++; if (defer) await gate;
      return { ok: true, json: async () => ({ sessionId: body.sessionId, candidates: entries, total: entries.length, offset: 0, unavailableCount: 0,
        ...(preferred ? { preferred } : {}), ...(continuation ? { continuation } : {}) }) };
    }
    if (path === "/midi-import-preview") return { ok: true, json: async () => ({ sessionId: body.sessionId, artifactRef: body.artifactRef,
      label: "Piano variation", durationBeats: 8, parts: candidates[0]!.midi!.parts,
      timing: { tempoEventCount: 1, timeSignatureEventCount: 0 }, targets: [{ trackId: "2", trackName: "Piano" }], unavailableTargetCount: 0, maxMappings: 64 }) };
    if (path === "/command" && body.kind === "select_candidate") {
      if (body.selection.action === "prefer") preferred = body.selection.candidate;
      else continuation = body.selection.candidate;
      const current = cloneState(h.readBootstrappedClientStateReference());
      current.events.push({ id: "candidate-event-" + current.events.length, createdAt: "2026-10-03T00:00:02Z", kind: "candidate", content: "Selected", candidateSelection: body.selection });
      h.setServerState(current);
    }
    return originalFetch(input, init);
  } });
  const open = async () => { assert.deepEqual(h.errors, []); h.click("#candidatesButton"); await h.settle(); assert.deepEqual(h.errors, []); await waitForCondition(() => h.document.querySelectorAll(".candidate-choice input").length === entries.length, `Expected saved candidates: ${h.document.querySelector("#candidateComparison")?.textContent}`); };
  return { h, state, open, release, get playCount() { return playCount; }, get readCount() { return readCount; } };
}

function action(h: Awaited<ReturnType<typeof setup>>["h"], text: string) {
  const button = [...h.document.querySelectorAll<HTMLButtonElement>("#candidateComparison button")].find((button) => button.textContent === text)!;
  assert.ok(button, text); button.click();
}

test("candidate comparison uses saved playback, persistent preferred selection and draft-only continuation", async () => {
  const s = await setup(); const { h } = s;
  try {
    await s.open(); h.click('.candidate-choice input[value="midi:midi-a"]'); h.click('.candidate-choice input[value="audio:audio-b"]');
    assert.equal(h.document.querySelector('[aria-label="Saved MIDI note preview"]')!.getAttribute("role"), "img");
    assert.match(h.document.querySelector(".candidate-cards")!.textContent!, /Parent candidate: Piano variation/);
    assert.match(h.document.querySelector(".candidate-cards")!.textContent!, /"seed":12/);
    const audio = h.document.querySelector<HTMLAudioElement>(".candidate-card audio")!;
    assert.match(audio.src, /\/audio-assets\/audio-b\?token=.*sessionId=/); assert.equal(audio.controls, false);
    h.click(".candidate-card .attachment-audio-toggle"); await h.settle(); assert.equal(s.playCount, 1);
    action(h, "Mark preferred"); await waitForCondition(() => Boolean(h.document.querySelector('[aria-pressed="true"]')), "Expected persisted preferred candidate");
    assert.deepEqual(commandCalls(h)[0]!.body, { kind: "select_candidate", sessionId: s.state.activeSessionId,
      selection: { action: "prefer", candidate: { kind: "midi", id: "midi-a" } } });
    await h.settle();
    await waitForCondition(() => [...h.document.querySelectorAll<HTMLButtonElement>("#candidateComparison button")].some((button) => button.textContent === "Create next version" && !button.disabled), "Expected settled candidate command");
    h.input("#prompt", "Keep the dynamics."); action(h, "Create next version");
    await waitForCondition(() => h.document.querySelector<HTMLTextAreaElement>("#prompt")!.value.includes("midi-a"), "Expected candidate draft");
    assert.match(h.document.querySelector<HTMLTextAreaElement>("#prompt")!.value, /^Keep the dynamics\./);
    assert.equal(jsonCalls(h, "/send").length, 0);
    assert.deepEqual(commandCalls(h)[1]!.body, { kind: "select_candidate", sessionId: s.state.activeSessionId,
      selection: { action: "continue", candidate: { kind: "midi", id: "midi-a" } } });
    await h.settle();
    const activeAudio = h.document.querySelector(".candidate-card audio");
    const admitted = cloneState(h.readBootstrappedClientStateReference());
    admitted.events.push({ id: "continued-user", createdAt: "2026-10-03T00:00:03Z", kind: "user", content: "Make a variation",
      parentCandidate: { kind: "midi", id: "midi-a" } });
    h.setServerState(admitted);
    h.emitServerEvent({ type: "session_state_invalidated", sessionId: s.state.activeSessionId }); await h.settle();
    assert.doesNotMatch(h.document.querySelector("#candidateComparison")!.textContent!, /Next request starts from/);
    assert.equal(h.document.querySelector(".candidate-card audio"), activeAudio, "consuming the source does not replace the active player");
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("candidate MIDI import reuses observed mapping preview and audio import only prepares a draft", async () => {
  const s = await setup(); const { h } = s;
  try {
    await s.open(); h.click('.candidate-choice input[value="midi:midi-a"]');
    h.click(".plugin-result-load"); await waitForCondition(() => Boolean(h.document.querySelector(".plugin-result-track")), "Expected M2 mapping");
    h.select(".plugin-result-track", "2"); h.input(".plugin-result-beat", "9");
    assert.match(h.document.querySelector('[aria-label="Clip preview"]')!.textContent!, /Piano.*Beats 9–17/);
    h.click(".plugin-result-apply"); await h.settle();
    assert.deepEqual(commandCalls(h)[0]!.body, { kind: "import_midi_artifact", sessionId: s.state.activeSessionId,
      artifactRef: "midi-a", startBeat: 8, mappings: [{ partId: "track-0-channel-1", trackId: "2", trackName: "Piano" }] });
    h.click('.candidate-choice input[value="audio:audio-b"]'); action(h, "Prepare audio import in chat"); await h.settle();
    assert.match(h.document.querySelector<HTMLTextAreaElement>("#prompt")!.value, /audio-b/);
    assert.equal(jsonCalls(h, "/send").length, 0); assert.equal(commandCalls(h).length, 1);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("read-only comparison and compact audio playback remain available during generation", async () => {
  const s = await setup(); const { h } = s; let held = false;
  try {
    await s.open(); h.click('.candidate-choice input[value="audio:audio-b"]');
    h.click("#closeCandidatesButton");
    h.holdNextSend(); held = true; h.input("#prompt", "Continue composing"); h.click("#sendButton"); await h.settle(); h.click("#candidatesButton");
    const preferred = [...h.document.querySelectorAll<HTMLButtonElement>("#candidateComparison button")].find((button) => button.textContent === "Mark preferred")!;
    assert.equal(preferred.disabled, true);
    h.click(".candidate-card .attachment-audio-toggle"); await h.settle(); assert.equal(s.playCount, 1);
    h.click('.candidate-choice input[value="midi:midi-a"]');
    assert.ok(h.document.querySelector('[aria-label="Saved MIDI note preview"]'));
    const reads = s.readCount; action(h, "Refresh candidates");
    await waitForCondition(() => s.readCount > reads, "Expected read-only refresh while generating");
    assert.equal(commandCalls(h).length, 0);
    h.releaseHeldSend(); held = false; await h.settle(); assert.deepEqual(h.errors, []);
  } finally { if (held) h.releaseHeldSend(); h.close(); }
});

test("delayed candidate read cannot populate another Session or keep its audio player", async () => {
  const s = await setup(true); const { h } = s;
  try {
    h.click("#candidatesButton"); await waitForCondition(() => s.readCount > 0, "Expected candidate read");
    h.click('.session-entry[data-session-id="session-2"] .session-row'); await h.settle();
    s.release(); await h.settle();
    assert.equal(h.document.querySelector(".candidate-card"), null);
    assert.equal(h.document.querySelector(".candidate-card audio"), null);
    assert.equal(commandCalls(h).filter((call) => (call.body as { kind: string }).kind === "select_candidate").length, 0);
    assert.deepEqual(h.errors, []);
  } finally { s.release(); h.close(); }
});


test("MIDI version actions retain the exact selected version for export, chat attachments and revision drafts", async () => {
  const original: SessionCandidate = { ...candidates[0]!, version: { groupId: "midi-a", number: 1, groupLabel: "Verse piano" } };
  const revised: SessionCandidate = { ...original, ref: { kind: "midi", id: "midi-v2" },
    version: { groupId: "midi-a", number: 2, derivedFromId: "midi-a", groupLabel: "Verse piano" } };
  const s = await setup(false, [revised, original]); const { h } = s;
  try {
    await s.open(); h.click('.candidate-choice input[value="midi:midi-v2"]');
    assert.equal(h.document.querySelector(".candidate-card h3")!.textContent, "Piano variation · v2");
    action(h, "Export MIDI"); await h.settle();
    assert.deepEqual(commandCalls(h).at(-1)!.body, { kind: "export_midi_artifact", sessionId: s.state.activeSessionId, artifactRef: "midi-v2" });
    action(h, "Attach to message"); await h.settle();
    assert.equal(h.document.getElementById("inspectorPane")!.hidden, true);
    assert.equal(h.document.activeElement?.id, "prompt");
    h.click("#candidatesButton");
    await waitForCondition(() => [...h.document.querySelectorAll<HTMLButtonElement>("#candidateComparison button")].some((button) => button.textContent === "Create next version" && !button.disabled), "Expected refreshed version controls");
    assert.deepEqual(commandCalls(h).at(-1)!.body, { kind: "attach_midi_artifact", sessionId: s.state.activeSessionId, artifactRef: "midi-v2" });
    assert.equal(jsonCalls(h, "/send").length, 0);
    action(h, "Create next version"); await h.settle();
    assert.deepEqual(commandCalls(h).at(-1)!.body, { kind: "select_candidate", sessionId: s.state.activeSessionId,
      selection: { action: "continue", candidate: { kind: "midi", id: "midi-v2" } } });
    assert.match(h.document.querySelector<HTMLTextAreaElement>("#prompt")!.value, /new version.*midi-v2/);
    assert.equal(jsonCalls(h, "/send").length, 0);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("changing comparisons, refreshing and preferring a candidate preserves active audio and MIDI import drafts", async () => {
  const s = await setup(); const { h } = s;
  try {
    await s.open(); h.click('.candidate-choice input[value="audio:audio-b"]');
    const audio = h.document.querySelector<HTMLAudioElement>(".candidate-card audio")!;
    h.click(".candidate-card .attachment-audio-toggle"); await h.settle(); audio.currentTime = 12;
    h.click('.candidate-choice input[value="midi:midi-a"]');
    assert.equal(h.document.querySelector(".candidate-card audio"), audio, "adding a comparison must retain the playing media element");
    assert.equal(audio.currentTime, 12);
    h.click(".plugin-result-load"); await waitForCondition(() => Boolean(h.document.querySelector(".plugin-result-track")), "Expected mapping");
    h.select(".plugin-result-track", "2"); h.input(".plugin-result-beat", "9");
    const track = h.document.querySelector<HTMLSelectElement>(".plugin-result-track")!;
    action(h, "Mark preferred"); await h.settle();
    await waitForCondition(() => Boolean(h.document.querySelector('[aria-pressed="true"]')), "Expected preference");
    action(h, "Refresh candidates"); await h.settle();
    assert.equal(h.document.querySelector(".candidate-card audio"), audio);
    assert.equal(audio.currentTime, 12);
    assert.equal(h.document.querySelector(".plugin-result-track"), track);
    assert.equal(track.value, "2");
    assert.equal(h.document.querySelector<HTMLInputElement>(".plugin-result-beat")!.value, "9");
    h.click('.candidate-choice input[value="midi:midi-a"]');
    assert.equal(h.document.querySelector(".candidate-card audio"), audio);
    h.click('.candidate-choice input[value="audio:audio-b"]');
    assert.equal(h.document.querySelector(".candidate-card audio"), null);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("MIDI comparisons use the same pitch and beat coordinates across different ranges and durations", async () => {
  const longer: SessionCandidate = { ...candidates[0]!, ref: { kind: "midi", id: "midi-longer" }, label: "Higher and longer",
    midi: { ...candidates[0]!.midi!, durationBeats: 16, notes: [
      { pitch: 60, startTime: 2, duration: 1 }, { pitch: 72, startTime: 0, duration: 1 },
    ] } };
  const s = await setup(false, [candidates[0]!, longer]); const { h } = s;
  try {
    await s.open(); h.click('.candidate-choice input[value="midi:midi-a"]'); h.click('.candidate-choice input[value="midi:midi-longer"]');
    const charts = h.document.querySelectorAll<SVGElement>('[aria-label="Saved MIDI note preview"]');
    const a = charts[0]!.querySelector<SVGRectElement>('rect[data-pitch="60"]')!;
    const b = charts[1]!.querySelector<SVGRectElement>('rect[data-pitch="60"]')!;
    assert.ok(a && b, "notes must remain individually inspectable");
    assert.equal(a.getAttribute("y"), b.getAttribute("y"), "the same pitch must align across versions");
    assert.equal(a.getAttribute("width"), b.getAttribute("width"), "one beat has the same width across versions");
    assert.equal(charts[0]!.querySelector('rect[data-pitch="64"]')!.getAttribute("x"), b.getAttribute("x"));
    assert.ok(Number(charts[1]!.querySelector('rect[data-pitch="72"]')!.getAttribute("y")) < Number(b.getAttribute("y")));
    assert.match(charts[0]!.closest("figure")!.querySelector("figcaption")!.textContent!, /60–83/, "the shared pitch range stays visible outside the scaled drawing");
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});


test("keyboard navigation and reopening candidates refresh saved results while preserving the comparison", async () => {
  const entries = [...candidates];
  const s = await setup(false, entries); const { h } = s;
  try {
    h.click("#settingsButton"); h.click("#sessionInspectorScope"); h.click("#toolsTab");
    h.document.getElementById("toolsTab")!.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await waitForCondition(() => h.document.querySelectorAll(".candidate-choice input").length === 2, "Expected keyboard-opened candidates");
    assert.equal(h.document.activeElement?.id, "candidatesTab");
    assert.equal(h.document.getElementById("candidatesPanel")!.hidden, false);
    h.click('.candidate-choice input[value="audio:audio-b"]');
    const audio = h.document.querySelector<HTMLAudioElement>(".candidate-card audio")!; audio.currentTime = 8;
    h.click("#closeCandidatesButton");
    assert.equal(h.document.getElementById("inspectorPane")!.hidden, true);
    assert.equal(h.document.activeElement?.id, "prompt");
    assert.equal(h.document.querySelector(".chat-pane")!.hasAttribute("inert"), false);
    entries.push({ ...candidates[0]!, ref: { kind: "midi", id: "midi-new" } });
    h.click("#candidatesButton");
    await waitForCondition(() => h.document.querySelectorAll(".candidate-choice input").length === 3, "Expected newly saved candidate on reopen");
    assert.equal(h.document.querySelector(".candidate-card audio"), audio); assert.equal(audio.currentTime, 8);
    h.click('.candidate-remove'); assert.equal(h.document.querySelector(".candidate-card audio"), null);
    assert.equal(h.document.querySelector<HTMLInputElement>('.candidate-choice input[value="audio:audio-b"]')!.checked, false);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});
