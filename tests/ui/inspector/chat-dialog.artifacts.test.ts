import assert from "node:assert/strict";
import test from "node:test";
import { URL } from "node:url";
import type { MidiArtifactDiff } from "../../../src/app/midi/midi-artifact-diff.js";
import type { SessionArtifact } from "../../../src/app/session/session-artifacts.js";
import type { ArtifactSelection } from "../../../src/agent/artifact-contracts.js";
import { cloneState, commandCalls, createDialogHarness, jsonCalls, stateFixture, waitForCondition } from "../support/chat-dialog.test-harness.js";

const artifacts: SessionArtifact[] = [
  { ref: { kind: "midi", id: "midi-a" }, label: "Piano variation", createdAt: "2026-10-03T00:00:00Z", sourceLabel: "MIDI generator",
    generation: { toolName: "make", callEventId: "call-a", resultEventId: "result-a", parameters: '{"seed":12}', parametersTruncated: false },
    midi: { durationBeats: 8, noteCount: 2, parts: [{ id: "track-0-channel-1", sourceTrackIndex: 0, channel: 1, sourceTrackName: "Piano", noteCount: 2, durationBeats: 8 }],
      notes: [{ partId: "track-0-channel-1", pitch: 60, startTime: 0, duration: 1 }, { partId: "track-0-channel-1", pitch: 64, startTime: 2, duration: 1 }], omittedNoteCount: 0 } },
  { ref: { kind: "audio", id: "audio-b" }, label: "Warm arrangement", createdAt: "2026-10-03T00:00:01Z", sourceLabel: "Music generator",
    parent: { kind: "midi", id: "midi-a" }, audio: { durationSeconds: 32, mediaType: "audio/wav", jobId: "job-b" } },
];

async function setup(defer = false, entries: SessionArtifact[] = artifacts, language: "en" | "zh-CN" = "en") {
  const state = stateFixture(); state.openSettingsOnLoad = false; state.settings.uiLanguage = language;
  const primaries = new Map<string, { kind: "midi" | "audio"; id: string }>();
  let playCount = 0; let readCount = 0; let continuation: ArtifactSelection["candidate"] = null;
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  const h = await createDialogHarness(state, undefined, { beforeParse(window) {
    Object.defineProperty(window.HTMLMediaElement.prototype, "play", { configurable: true, value: async () => { playCount++; } });
  } });
  const withVersions = (entry: SessionArtifact): SessionArtifact => entry.version ? { ...entry,
    ...(primaries.has(`${entry.ref.kind}:${entry.version.groupId}`) ? { primary: primaries.get(`${entry.ref.kind}:${entry.version.groupId}`)! } : {}),
    versions: entries.filter((item) => item.ref.kind === entry.ref.kind && item.version?.groupId === entry.version!.groupId).map((item) => ({ id: item.ref.id, label: item.label,
      number: item.version!.number, createdAt: item.createdAt, ...(item.version!.derivedFromId ? { derivedFromId: item.version!.derivedFromId } : {}) })) } : entry;
  const originalFetch = h.window.fetch;
  Object.defineProperty(h.window, "fetch", { configurable: true, value: async (input: string, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (path === "/session-artifacts") {
      readCount++; if (defer) await gate;
      const groups = new Map<string, SessionArtifact>();
      for (const entry of entries) {
        const key = `${entry.ref.kind}:${entry.version?.groupId ?? entry.ref.id}`;
        const primary = primaries.get(key);
        if (primary?.id === entry.ref.id || (!primary || groups.get(key)?.ref.id !== primary.id) &&
          (!groups.has(key) || (groups.get(key)!.version?.number ?? 0) < (entry.version?.number ?? 0))) groups.set(key, entry);
      }
      return { ok: true, json: async () => ({ sessionId: body.sessionId,
        artifacts: [...groups.values()].slice(body.offset, body.offset + 24).map(withVersions), total: groups.size, offset: body.offset, unavailableCount: 0,
        ...(continuation ? { continuation } : {}) }) };
    }
    if (path === "/session-artifact") return { ok: true, json: async () => ({ sessionId: body.sessionId,
      artifact: withVersions(entries.find((entry) => entry.ref.id === body.artifact.id)!) }) };
    if (path === "/midi-artifact-preview") {
      const artifact = entries.find((entry) => entry.ref.id === body.artifactRef)!;
      const part = artifact.midi!.parts.find((entry) => entry.id === body.partId)!;
      const notes = artifact.midi!.notes.filter((note) => note.partId === body.partId);
      return { ok: true, json: async () => ({ ...body, notes, omittedNoteCount: part.noteCount - notes.length }) };
    }
    if (path === "/midi-import-preview") {
      const artifact = entries.find((entry) => entry.ref.id === body.artifactRef)!;
      return { ok: true, json: async () => ({ sessionId: body.sessionId, artifactRef: body.artifactRef,
        label: artifact.label, durationBeats: artifact.midi!.durationBeats, parts: artifact.midi!.parts,
        timing: { tempoEventCount: 1, timeSignatureEventCount: 0 }, targets: [{ trackId: "2", trackName: "Piano" }], unavailableTargetCount: 0, maxActions: 64 }) };
    }
    if (path === "/command" && body.kind === "select_artifact") {
      if (body.selection.action === "primary") {
        const key = `${body.selection.group.kind}:${body.selection.group.id}`;
        if (body.selection.candidate) primaries.set(key, body.selection.candidate); else primaries.delete(key);
      } else {
        assert.equal(body.selection.action, "continue"); continuation = body.selection.candidate;
      }
      const current = cloneState(h.readBootstrappedClientStateReference());
      current.events.push({ id: "artifact-event-" + current.events.length, createdAt: "2026-10-03T00:00:02Z", kind: "candidate", content: "Selected", candidateSelection: body.selection });
      h.setServerState(current);
    }
    return originalFetch(input, init);
  } });
  const open = async () => { assert.deepEqual(h.errors, []); h.click("#artifactsTab"); await h.settle(); assert.deepEqual(h.errors, []); await waitForCondition(() => h.document.querySelectorAll(".artifact-open").length === Math.min(new Set(entries.map((entry) => entry.version?.groupId ?? entry.ref.id)).size, 24), `Expected saved artifacts: ${h.document.querySelector("#artifactLibrary")?.textContent}`); };
  return { h, state, open, release, get playCount() { return playCount; }, get readCount() { return readCount; } };
}

function action(h: Awaited<ReturnType<typeof setup>>["h"], text: string) {
  const button = [...h.document.querySelectorAll<HTMLButtonElement>("#artifactLibrary button")].find((button) => button.textContent === text)!;
  assert.ok(button, text); button.click();
}

test("artifact browsing keeps source selection out of the timeline and prepares only a draft", async () => {
  const s = await setup(); const { h } = s;
  try {
    await s.open(); h.click('button.artifact-open[data-artifact-key="midi:midi-a"]'); h.click('button.artifact-open[data-artifact-key="audio:audio-b"]');
    assert.equal(h.document.querySelector('[aria-label="Saved MIDI note preview"]')!.getAttribute("role"), "img");
    assert.match(h.document.querySelector("#artifactLibrary")!.textContent!, /Source artifact: Piano variation/);
    assert.match(h.document.querySelector("#artifactLibrary")!.textContent!, /"seed":12/);
    const generationSections = [...h.document.querySelectorAll<HTMLDetailsElement>(".artifact-card details")].filter((details) => details.querySelector("summary")?.textContent === "Generation parameters");
    assert.equal(generationSections.length, 2);
    assert.equal(generationSections[0]!.hidden, false); assert.equal(generationSections[1]!.hidden, true);
    generationSections[0]!.open = true; assert.match(generationSections[0]!.textContent!, /"seed":12/);
    const audio = h.document.querySelector<HTMLAudioElement>(".artifact-card audio")!;
    assert.match(audio.src, /\/audio-assets\/audio-b\?token=.*sessionId=/); assert.equal(audio.controls, false);
    h.click(".artifact-card .attachment-audio-toggle"); await h.settle(); assert.equal(s.playCount, 1);
    h.input("#prompt", "Keep the dynamics."); action(h, "Create next version");
    await waitForCondition(() => h.document.querySelector<HTMLTextAreaElement>("#prompt")!.value.includes("Piano variation"), "Expected candidate draft");
    assert.match(h.document.querySelector<HTMLTextAreaElement>("#prompt")!.value, /^Keep the dynamics\./);
    assert.equal(jsonCalls(h, "/send").length, 0);
    assert.deepEqual(commandCalls(h)[0]!.body, { kind: "select_artifact", sessionId: s.state.activeSessionId,
      selection: { action: "continue", candidate: { kind: "midi", id: "midi-a" } } });
    await h.settle();
    assert.equal(h.document.querySelector("#timeline .candidate"), null);
    assert.doesNotMatch(h.document.querySelector("#timeline")!.textContent!, /Selected|Artifact selection/);
    const activeAudio = h.document.querySelector(".artifact-card audio");
    const admitted = cloneState(h.readBootstrappedClientStateReference());
    admitted.events.push({ id: "continued-user", createdAt: "2026-10-03T00:00:03Z", kind: "user", content: "Make a variation",
      parentCandidate: { kind: "midi", id: "midi-a" } });
    h.setServerState(admitted);
    h.emitServerEvent({ type: "session_state_invalidated", sessionId: s.state.activeSessionId }); await h.settle();
    assert.doesNotMatch(h.document.querySelector("#artifactLibrary")!.textContent!, /Next request starts from/);
    assert.equal(h.document.querySelector(".artifact-card audio"), activeAudio, "consuming the source does not replace the active player");
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("artifact MIDI import reuses observed mapping preview and audio import only prepares a draft", async () => {
  const s = await setup(); const { h } = s;
  try {
    await s.open(); h.click('button.artifact-open[data-artifact-key="midi:midi-a"]');
    action(h, "Add to Live"); await waitForCondition(() => Boolean(h.document.querySelector(".plugin-result-track")), "Expected M2 mapping");
    h.select(".plugin-result-track", "2"); h.input(".plugin-result-beat", "9");
    assert.match(h.document.querySelector('[aria-label="Clip preview"]')!.textContent!, /Piano.*beats 9–17/);
    h.click(".plugin-result-apply"); await h.settle();
    assert.deepEqual(commandCalls(h)[0]!.body, { kind: "import_midi_artifact", sessionId: s.state.activeSessionId,
      artifactRef: "midi-a", startBeat: 8, mappings: [{ partId: "track-0-channel-1", trackId: "2", trackName: "Piano" }] });
    h.click('button.artifact-open[data-artifact-key="audio:audio-b"]'); action(h, "Prepare audio import in chat"); await h.settle();
    assert.match(h.document.querySelector<HTMLTextAreaElement>("#prompt")!.value, /audio-b/);
    assert.equal(jsonCalls(h, "/send").length, 0); assert.equal(commandCalls(h).length, 1);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("read-only browsing and compact audio playback remain available during generation", async () => {
  const s = await setup(); const { h } = s; let held = false;
  try {
    await s.open(); h.click('button.artifact-open[data-artifact-key="audio:audio-b"]');
    h.click("#closeArtifactsButton");
    h.holdNextSend(); held = true; h.input("#prompt", "Continue composing"); h.click("#sendButton"); await h.settle(); h.click("#artifactsTab");
    const continuation = [...h.document.querySelectorAll<HTMLButtonElement>("#artifactLibrary button")].find((button) => button.textContent === "Continue in chat")!;
    assert.equal(continuation.disabled, true);
    h.click(".artifact-card .attachment-audio-toggle"); await h.settle(); assert.equal(s.playCount, 1);
    h.click('button.artifact-open[data-artifact-key="midi:midi-a"]');
    assert.ok(h.document.querySelector('[aria-label="Saved MIDI note preview"]'));
    const reads = s.readCount; action(h, "Refresh artifacts");
    await waitForCondition(() => s.readCount > reads, "Expected read-only refresh while generating");
    assert.equal(commandCalls(h).length, 0);
    h.releaseHeldSend(); held = false; await h.settle(); assert.deepEqual(h.errors, []);
  } finally { if (held) h.releaseHeldSend(); h.close(); }
});

test("delayed artifact read cannot populate another Session or keep its audio player", async () => {
  const s = await setup(true); const { h } = s;
  try {
    h.click("#artifactsTab"); await waitForCondition(() => s.readCount > 0, "Expected candidate read");
    h.click('.session-entry[data-session-id="session-2"] .session-row'); await h.settle();
    s.release(); await h.settle();
    assert.equal(h.document.querySelector(".artifact-card"), null);
    assert.equal(h.document.querySelector(".artifact-card audio"), null);
    assert.equal(commandCalls(h).filter((call) => (call.body as { kind: string }).kind === "select_artifact").length, 0);
    assert.deepEqual(h.errors, []);
  } finally { s.release(); h.close(); }
});


test("MIDI version actions retain the exact selected version for export, chat attachments and revision drafts", async () => {
  const original: SessionArtifact = { ...artifacts[0]!, version: { groupId: "midi-a", number: 1, groupLabel: "Verse piano" } };
  const revised: SessionArtifact = { ...original, ref: { kind: "midi", id: "midi-v2" },
    version: { groupId: "midi-a", number: 2, derivedFromId: "midi-a", groupLabel: "Verse piano" } };
  const s = await setup(false, [revised, original]); const { h } = s;
  try {
    await s.open(); h.click('button.artifact-open[data-artifact-key="midi:midi-a"]');
    action(h, "Export MIDI"); await h.settle();
    assert.deepEqual(commandCalls(h).at(-1)!.body, { kind: "export_artifact", sessionId: s.state.activeSessionId, artifact: { kind: "midi", id: "midi-v2" } });
    action(h, "Attach to message"); await h.settle();
    assert.equal(h.document.getElementById("inspectorPane")!.hidden, true);
    assert.equal(h.document.activeElement?.id, "prompt");
    h.click("#artifactsTab");
    await waitForCondition(() => [...h.document.querySelectorAll<HTMLButtonElement>("#artifactLibrary button")].some((button) => button.textContent === "Create next version" && !button.disabled), "Expected refreshed version controls");
    assert.deepEqual(commandCalls(h).at(-1)!.body, { kind: "attach_artifact", sessionId: s.state.activeSessionId, artifact: { kind: "midi", id: "midi-v2" } });
    assert.equal(jsonCalls(h, "/send").length, 0);
    action(h, "Create next version"); await h.settle();
    assert.deepEqual(commandCalls(h).at(-1)!.body, { kind: "select_artifact", sessionId: s.state.activeSessionId,
      selection: { action: "continue", candidate: { kind: "midi", id: "midi-v2" } } });
    assert.match(h.document.querySelector<HTMLTextAreaElement>("#prompt")!.value, /new version.*Piano variation · v2/);
    assert.equal(jsonCalls(h, "/send").length, 0);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("browsing and refreshing artifacts preserves active audio and open MIDI import drafts", async () => {
  const s = await setup(); const { h } = s;
  try {
    await s.open(); h.click('button.artifact-open[data-artifact-key="audio:audio-b"]');
    const audio = h.document.querySelector<HTMLAudioElement>(".artifact-card audio")!;
    h.click(".artifact-card .attachment-audio-toggle"); await h.settle(); audio.currentTime = 12;
    h.click('button.artifact-open[data-artifact-key="midi:midi-a"]');
    assert.equal(h.document.querySelector(".artifact-card audio"), audio, "opening another artifact must retain the playing media element");
    assert.equal(audio.currentTime, 12);
    action(h, "Add to Live"); await waitForCondition(() => Boolean(h.document.querySelector(".plugin-result-track")), "Expected mapping");
    h.select(".plugin-result-track", "2"); h.input(".plugin-result-beat", "9");
    const track = h.document.querySelector<HTMLSelectElement>(".plugin-result-track")!;
    const refreshed = cloneState(h.readBootstrappedClientStateReference());
    h.setServerState(refreshed);
    h.emitServerEvent({ type: "session_state_invalidated", sessionId: s.state.activeSessionId }); await h.settle();
    assert.equal(h.document.querySelector(".artifact-card audio"), audio);
    assert.equal(audio.currentTime, 12);
    assert.equal(h.document.querySelector(".plugin-result-track"), track);
    assert.equal(track.value, "2");
    assert.equal(h.document.querySelector<HTMLInputElement>(".plugin-result-beat")!.value, "9");
    h.document.querySelector<HTMLButtonElement>(".midi-import-header button")!.click();
    action(h, "Refresh artifacts"); await h.settle();
    h.click('button.artifact-open[data-artifact-key="midi:midi-a"]');
    assert.equal(h.document.querySelector(".artifact-card audio"), audio);
    h.click('button.artifact-open[data-artifact-key="audio:audio-b"]');
    assert.equal(h.document.querySelector(".artifact-card audio"), null);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("keyboard navigation and reopening artifacts refresh saved results while preserving playback", async () => {
  const entries = [...artifacts];
  const s = await setup(false, entries); const { h } = s;
  try {
    h.click("#settingsButton"); h.click("#sessionInspectorScope"); h.click("#contextTab");
    h.document.getElementById("contextTab")!.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await waitForCondition(() => h.document.querySelectorAll(".artifact-open").length === 2, "Expected keyboard-opened artifacts");
    assert.equal(h.document.activeElement?.id, "artifactsTab");
    assert.equal(h.document.getElementById("artifactsPanel")!.hidden, false);
    h.click('button.artifact-open[data-artifact-key="audio:audio-b"]');
    const audio = h.document.querySelector<HTMLAudioElement>(".artifact-card audio")!; audio.currentTime = 8;
    h.click("#closeArtifactsButton");
    assert.equal(h.document.getElementById("inspectorPane")!.hidden, true);
    assert.equal(h.document.activeElement?.id, "prompt");
    assert.equal(h.document.querySelector(".chat-pane")!.hasAttribute("inert"), false);
    entries.push({ ...artifacts[0]!, ref: { kind: "midi", id: "midi-new" } });
    h.click("#artifactsTab");
    await waitForCondition(() => h.document.querySelectorAll(".artifact-open").length === 3, "Expected newly saved artifact on reopen");
    assert.equal(h.document.querySelector(".artifact-card audio"), audio); assert.equal(audio.currentTime, 8);
    h.click('button.artifact-open[data-artifact-key="audio:audio-b"]'); assert.equal(h.document.querySelector(".artifact-card audio"), null);
    assert.equal(h.document.querySelector<HTMLInputElement>('button.artifact-open[data-artifact-key="audio:audio-b"]')!.getAttribute("aria-expanded"), "false");
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});


test("pagination releases off-page media and returns to a fresh work list", async () => {
  const entries: SessionArtifact[] = [artifacts[1]!, ...Array.from({ length: 25 }, (_, index): SessionArtifact => ({
    ...artifacts[0]!, ref: { kind: "midi", id: `midi-page-${index}` }, label: `Piano ${index}`,
  }))];
  const s = await setup(false, entries); const { h } = s;
  try {
    await s.open(); h.click('button.artifact-open[data-artifact-key="audio:audio-b"]');
    const audio = h.document.querySelector<HTMLAudioElement>('.artifact-card audio')!;
    action(h, "Next page"); await h.settle();
    assert.equal(audio.isConnected, false);
    assert.equal(h.document.querySelectorAll('.artifact-open').length, 2);
    action(h, "Previous page"); await h.settle();
    assert.equal(h.document.querySelectorAll('.artifact-open').length, 24);
    assert.equal(h.document.querySelector<HTMLInputElement>('button.artifact-open[data-artifact-key="audio:audio-b"]')!.getAttribute("aria-expanded"), "false");
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("previewing one MIDI part carries that part into import without changing exported content", async () => {
  const second = { id: "track-1-channel-2", sourceTrackIndex: 1, channel: 2, sourceTrackName: "Alternative B", noteCount: 1, durationBeats: 8 };
  const midi: SessionArtifact = { ...artifacts[0]!, midi: { ...artifacts[0]!.midi!, noteCount: 3,
    parts: [...artifacts[0]!.midi!.parts, second], notes: [...artifacts[0]!.midi!.notes, { partId: second.id, pitch: 48, startTime: 0, duration: 4 }] } };
  const s = await setup(false, [midi]); const { h } = s;
  try {
    await s.open(); h.click('button.artifact-open[data-artifact-key="midi:midi-a"]');
    h.select('.artifact-preview-part select', second.id); await h.settle();
    assert.deepEqual([...h.document.querySelectorAll('rect[data-pitch]')].map((note) => note.getAttribute('data-pitch')), ["48"]);
    action(h, "Export MIDI"); await h.settle();
    assert.deepEqual(commandCalls(h).at(-1)!.body, { kind: "export_artifact", sessionId: s.state.activeSessionId, artifact: { kind: "midi", id: "midi-a" } });
    action(h, "Add to Live"); await waitForCondition(() => Boolean(h.document.querySelector('.midi-import-part-enabled')), "Expected part mapping");
    assert.deepEqual([...h.document.querySelectorAll<HTMLInputElement>('.midi-import-part-enabled')].map((part) => part.checked), [false, true]);
    h.click('.plugin-result-apply'); await h.settle();
    assert.deepEqual(commandCalls(h).at(-1)!.body, { kind: "import_midi_artifact", sessionId: s.state.activeSessionId,
      artifactRef: "midi-a", startBeat: 0, mappings: [{ partId: second.id, createTrack: true, trackName: "Alternative B" }] });
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("audio artifacts export and attach the exact saved audio without starting a model request", async () => {
  const s = await setup(); const { h } = s;
  try {
    await s.open(); h.click('button.artifact-open[data-artifact-key="audio:audio-b"]');
    action(h, "Export audio"); await h.settle();
    assert.deepEqual(commandCalls(h).at(-1)!.body, { kind: "export_artifact", sessionId: s.state.activeSessionId, artifact: { kind: "audio", id: "audio-b" } });
    action(h, "Attach to message"); await h.settle();
    assert.deepEqual(commandCalls(h).at(-1)!.body, { kind: "attach_artifact", sessionId: s.state.activeSessionId, artifact: { kind: "audio", id: "audio-b" } });
    assert.equal(h.document.activeElement?.id, "prompt");
    assert.equal(jsonCalls(h, "/send").length, 0);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});


test("a selected MIDI part loads notes outside the overview budget and ignores a cancelled part read", async () => {
  const later = { id: "track-1-channel-2", sourceTrackIndex: 1, channel: 2, sourceTrackName: "Later phrase", noteCount: 1, durationBeats: 300 };
  const midi: SessionArtifact = { ...artifacts[0]!, midi: { ...artifacts[0]!.midi!, noteCount: 257, durationBeats: 300, omittedNoteCount: 1,
    parts: [{ ...artifacts[0]!.midi!.parts[0]!, noteCount: 256, durationBeats: 300 }, later],
    notes: Array.from({ length: 256 }, (_, index) => ({ partId: "track-0-channel-1", pitch: 60, startTime: index, duration: .5 })) } };
  const s = await setup(false, [midi]); const { h } = s;
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  let reads = 0; let heldSignal: AbortSignal | undefined;
  const originalFetch = h.window.fetch;
  Object.defineProperty(h.window, "fetch", { configurable: true, value: async (input: string, init?: RequestInit) => {
    if (new URL(String(input)).pathname === "/session-artifact") {
      const body = JSON.parse(String(init?.body));
      return { ok: true, json: async () => ({ sessionId: body.sessionId, artifact: { ...midi, midi: {
        ...midi.midi!, notes: [...midi.midi!.notes, { partId: later.id, pitch: 48, startTime: 280, duration: 2 }], omittedNoteCount: 0,
      } } }) };
    }
    if (new URL(String(input)).pathname === "/midi-artifact-preview") {
      const body = JSON.parse(String(init?.body)); reads++;
      if (reads > 1) { heldSignal = init?.signal ?? undefined; await gate; }
      return { ok: true, json: async () => ({ ...body, notes: [{ partId: later.id, pitch: 48, startTime: 280, duration: 2 }], omittedNoteCount: 0 }) };
    }
    return originalFetch(input, init);
  } });
  try {
    await s.open(); h.click('button.artifact-open[data-artifact-key="midi:midi-a"]');
    await waitForCondition(() => Boolean(h.document.querySelector('.artifact-preview-part select')), 'Expected complete MIDI load');
    h.select('.artifact-preview-part select', later.id); await h.settle();
    assert.deepEqual([...h.document.querySelectorAll('rect[data-pitch]')].map((note) => note.getAttribute('data-pitch')), ["48"]);
    h.select('.artifact-preview-part select', "");
    h.select('.artifact-preview-part select', later.id); await waitForCondition(() => Boolean(heldSignal), "Expected second part read");
    h.select('.artifact-preview-part select', ""); assert.equal(heldSignal!.aborted, true);
    release(); await h.settle();
    assert.equal(h.document.querySelectorAll('rect[data-pitch="60"]').length, 16);
    assert.equal(h.document.querySelector('rect[data-pitch="48"]'), null);
    assert.equal(h.document.querySelector<HTMLElement>('.midi-piano-roll')!.hidden, false);
    h.input('.artifact-midi-preview-section .piano-roll-position', '272');
    assert.ok(h.document.querySelector('rect[data-pitch="48"]'));
    h.click('.artifact-midi-preview-section .piano-roll-focus');
    assert.equal(h.document.querySelectorAll('rect[data-pitch="60"]').length, 16);
    assert.deepEqual(h.errors, []);
  } finally { release(); h.close(); }
});

function versions(): SessionArtifact[] {
  return [1, 2, 3].map((number) => ({ ...artifacts[0]!, ref: { kind: "midi", id: number === 1 ? "midi-a" : `midi-v${number}` },
    label: `Phrase ${number}`, version: { groupId: "midi-a", groupLabel: "Verse piano", number, ...(number > 1 ? { derivedFromId: "midi-a" } : {}) },
    midi: { ...artifacts[0]!.midi!, notes: [{ partId: "track-0-channel-1", pitch: 59 + number, startTime: 0, duration: 1 }], noteCount: 1 },
  }));
}

test("one work switches exact versions, keeps the chosen version on refresh and routes all actions to it", async () => {
  const s = await setup(false, versions()); const { h } = s;
  try {
    await s.open(); h.click('.artifact-open');
    assert.equal(h.document.querySelector('.artifact-open')!.textContent, "Verse piano");
    assert.equal(h.document.querySelector<HTMLSelectElement>('.artifact-version-select')!.value, "midi-v3");
    assert.equal(h.document.querySelectorAll('.artifact-version-select option').length, 3);
    assert.match(h.document.querySelector('.artifact-version-source')!.textContent!, /v3.*v1/);
    h.select('.artifact-version-select', 'midi-v2'); await h.settle();
    assert.deepEqual([...h.document.querySelectorAll('rect[data-pitch]')].map((note) => note.getAttribute('data-pitch')), ['61']);
    action(h, 'Refresh artifacts'); await h.settle();
    assert.equal(h.document.querySelector<HTMLSelectElement>('.artifact-version-select')!.value, 'midi-v2');
    action(h, 'Export MIDI'); await h.settle();
    assert.equal((commandCalls(h).at(-1)!.body as { artifact: { id: string } }).artifact.id, 'midi-v2');
    action(h, 'Add to Live'); await waitForCondition(() => !!h.document.querySelector('.plugin-result-track'), 'Expected selected version import');
    h.click('.plugin-result-apply'); await h.settle();
    assert.equal((commandCalls(h).at(-1)!.body as { artifactRef: string }).artifactRef, 'midi-v2');
    assert.equal(jsonCalls(h, '/send').length, 0);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

for (const next of ['latest', 'session'] as const) test(`a cancelled version read cannot replace the ${next} view`, async () => {
  const s = await setup(false, versions()); const { h } = s;
  const originalFetch = h.window.fetch;
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  let signal: AbortSignal | undefined;
  Object.defineProperty(h.window, 'fetch', { configurable: true, value: async (input: string, init?: RequestInit) => {
    if (new URL(String(input)).pathname === '/session-artifact') { signal = init?.signal ?? undefined; await gate; }
    return originalFetch(input, init);
  } });
  try {
    await s.open(); h.click('.artifact-open'); h.select('.artifact-version-select', 'midi-a');
    await waitForCondition(() => Boolean(signal), 'Expected pending version read');
    if (next === 'latest') h.select('.artifact-version-select', 'midi-v3');
    else { h.click('.session-entry[data-session-id="session-2"] .session-row'); await h.settle(); }
    assert.equal(signal!.aborted, true); release(); await h.settle();
    if (next === 'latest') {
      assert.equal(h.document.querySelector<HTMLSelectElement>('.artifact-version-select')!.value, 'midi-v3');
      action(h, 'Export MIDI'); await h.settle();
      assert.equal((commandCalls(h).at(-1)!.body as { artifact: { id: string } }).artifact.id, 'midi-v3');
    } else assert.equal(h.document.querySelector('.artifact-card'), null);
    assert.deepEqual(h.errors, []);
  } finally { release(); h.close(); }
});

function diffFixture(sessionId: string): MidiArtifactDiff {
  const before = { pitch: 60, startTime: 0, duration: 1, velocity: 96 };
  const after = { ...before, pitch: 62 };
  const part = { id: 'track-0-channel-1', label: 'Piano', channel: 1 };
  return { sessionId, artifactRef: 'midi-v3', baseArtifactRef: 'midi-a', baseVersion: 1, version: 3,
    beforeDurationBeats: 8, afterDurationBeats: 12, added: 0, removed: 0, modified: 1, unchanged: 0,
    parts: [{ before: part, after: part, added: 0, removed: 0, modified: 1, unchanged: 0, transposeSemitones: 2,
      properties: { pitch: 1, startTime: 0, duration: 0, velocity: 0 },
      changes: [{ kind: 'modified', before, after }] }] };
}

test("version differences use the actual parent, display note changes and perform no write or send", async () => {
  const s = await setup(false, versions()); const { h } = s;
  const requests: unknown[] = [];
  const originalFetch = h.window.fetch;
  Object.defineProperty(h.window, 'fetch', { configurable: true, value: async (input: string, init?: RequestInit) => {
    if (new URL(String(input)).pathname === '/midi-artifact-diff') {
      requests.push(JSON.parse(String(init?.body)));
      return { ok: true, json: async () => diffFixture(s.state.activeSessionId!) };
    }
    return originalFetch(input, init);
  } });
  try {
    await s.open(); h.click('.artifact-open');
    assert.equal(requests.length, 0);
    h.click('.artifact-diff > summary'); await h.settle();
    assert.deepEqual(requests, [{ sessionId: s.state.activeSessionId, artifactRef: 'midi-v3', baseArtifactRef: 'midi-a' }]);
    assert.equal(h.document.querySelector('.artifact-diff > summary')!.textContent, 'Version comparison');
    assert.match(h.document.querySelector('.artifact-diff-overview')!.textContent!, /Up 2 semitones/);
    assert.match(h.document.querySelector('.artifact-diff-content')!.textContent!, /8 → 12/);
    const before = h.document.querySelector('.artifact-diff-chart .piano-roll-note.before')!;
    const after = h.document.querySelector('.artifact-diff-chart .piano-roll-note.after')!;
    assert.equal(before.getAttribute('data-pitch'), '60'); assert.equal(after.getAttribute('data-pitch'), '62');
    assert.equal(before.getAttribute('x'), after.getAttribute('x'));
    assert.equal(before.getAttribute('width'), after.getAttribute('width'));
    assert.match(after.textContent!, /Before: C3.*After: D3/s);
    assert.equal(h.document.querySelector<HTMLElement>('.artifact-midi-preview-section')!.hidden, true);
    h.click('.artifact-diff > summary'); await h.settle();
    assert.equal(h.document.querySelector<HTMLElement>('.artifact-midi-preview-section')!.hidden, false);
    assert.equal(commandCalls(h).length, 0); assert.equal(jsonCalls(h, '/send').length, 0);
    assert.equal(h.document.querySelector('#timeline .candidate'), null);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("switching versions aborts stale differences and never presents them under the next version", async () => {
  const s = await setup(false, versions()); const { h } = s;
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  let signal: AbortSignal | undefined;
  const originalFetch = h.window.fetch;
  Object.defineProperty(h.window, 'fetch', { configurable: true, value: async (input: string, init?: RequestInit) => {
    if (new URL(String(input)).pathname === '/midi-artifact-diff') {
      signal = init?.signal ?? undefined; await gate;
      return { ok: true, json: async () => diffFixture(s.state.activeSessionId!) };
    }
    return originalFetch(input, init);
  } });
  try {
    await s.open(); h.click('.artifact-open'); h.click('.artifact-diff > summary');
    await waitForCondition(() => !!signal, 'Expected difference read');
    h.select('.artifact-version-select', 'midi-a'); await h.settle();
    assert.equal(signal!.aborted, true); release(); await h.settle();
    assert.equal(h.document.querySelector('.artifact-diff-chart'), null);
    assert.equal(h.document.querySelector<HTMLDetailsElement>('.artifact-diff')!.open, false);
    assert.equal(h.document.querySelector<HTMLSelectElement>('.artifact-version-select')!.value, 'midi-a');
    assert.equal(commandCalls(h).length, 0); assert.deepEqual(h.errors, []);
  } finally { release(); h.close(); }
});

test("historical preference and source events stay readable without becoming chat messages", async () => {
  const state = stateFixture(); state.openSettingsOnLoad = false;
  state.events = ['prefer', 'continue'].map((action, index) => ({ id: `selection-${index}`, createdAt: '2026-10-03T00:00:00Z',
    kind: 'candidate' as const, content: 'Internal selection record', candidateSelection: { action: action as 'prefer' | 'continue', candidate: { kind: 'midi' as const, id: 'midi-a' } } }));
  const h = await createDialogHarness(state);
  try {
    assert.equal(h.readBootstrappedClientStateReference().events.length, 2);
    assert.doesNotMatch(h.document.querySelector('#timeline')!.textContent!, /Internal selection|Artifact selection/);
    assert.ok(h.document.querySelector('#timeline .empty'));
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

for (const media of ['midi', 'audio'] as const) test(`${media} primary is work-scoped, persists through reopening and never overrides an explicit version`, async () => {
  const entries: SessionArtifact[] = media === 'midi' ? versions() : [1, 2, 3].map((number) => ({ ...artifacts[1]!,
    ref: { kind: 'audio', id: `audio-v${number}` }, label: `Mix ${number}`, version: { groupId: 'audio-v1', groupLabel: 'Arrangement', number,
      ...(number > 1 ? { derivedFromId: 'audio-v1' } : {}) } }));
  const s = await setup(false, entries); const { h } = s;
  const ids = entries.map((entry) => entry.ref.id);
  try {
    await s.open(); h.click('.artifact-open');
    h.select('.artifact-version-select', ids[0]!); await h.settle();
    action(h, 'Make primary'); await h.settle();
    assert.deepEqual(commandCalls(h).at(-1)!.body, { kind: 'select_artifact', sessionId: s.state.activeSessionId,
      selection: { action: 'primary', group: { kind: media, id: ids[0] }, candidate: { kind: media, id: ids[0] } } });
    assert.equal(h.document.querySelector<HTMLButtonElement>('.artifact-primary')!.textContent, 'Clear primary');
    h.select('.artifact-version-select', ids[1]!); await h.settle();
    action(h, 'Refresh artifacts'); await h.settle();
    assert.equal(h.document.querySelector<HTMLSelectElement>('.artifact-version-select')!.value, ids[1]);
    action(h, media === 'midi' ? 'Export MIDI' : 'Export audio'); await h.settle();
    assert.equal((commandCalls(h).at(-1)!.body as { artifact: { id: string } }).artifact.id, ids[1]);
    h.click('.artifact-open'); h.click('.artifact-open');
    assert.equal(h.document.querySelector<HTMLSelectElement>('.artifact-version-select')!.value, ids[0]);
    action(h, 'Clear primary'); await h.settle(); h.click('.artifact-open'); h.click('.artifact-open');
    assert.equal(h.document.querySelector<HTMLSelectElement>('.artifact-version-select')!.value, ids[2]);
    assert.equal(h.document.querySelector('#timeline .candidate'), null);
    assert.equal(jsonCalls(h, '/send').length, 0); assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("changing the MIDI comparison baseline cancels its previous read and accepts a same-work sibling", async () => {
  const s = await setup(false, versions()); const { h } = s;
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  let signal: AbortSignal | undefined;
  const requested: string[] = [];
  const originalFetch = h.window.fetch;
  Object.defineProperty(h.window, 'fetch', { configurable: true, value: async (input: string, init?: RequestInit) => {
    if (new URL(String(input)).pathname === '/midi-artifact-diff') {
      const body = JSON.parse(String(init?.body)); requested.push(body.baseArtifactRef);
      if (body.baseArtifactRef === 'midi-a') { signal = init?.signal ?? undefined; await gate; }
      return { ok: true, json: async () => ({ ...diffFixture(s.state.activeSessionId!), baseArtifactRef: body.baseArtifactRef,
        baseVersion: body.baseArtifactRef === 'midi-a' ? 1 : 2 }) };
    }
    return originalFetch(input, init);
  } });
  try {
    await s.open(); h.click('.artifact-open'); h.click('.artifact-diff > summary');
    await waitForCondition(() => !!signal, 'Expected pending parent comparison');
    h.select('.artifact-diff-baseline select', 'midi-v2'); await h.settle();
    assert.equal(signal!.aborted, true); release(); await h.settle();
    assert.deepEqual(requested, ['midi-a', 'midi-v2']);
    assert.equal(commandCalls(h).length, 0); assert.deepEqual(h.errors, []);
  } finally { release(); h.close(); }
});

test("an expanded first version gains comparison when its first sibling arrives", async () => {
  const entries = versions().slice(0, 1);
  const s = await setup(false, entries); const { h } = s;
  try {
    await s.open(); h.click('.artifact-open');
    assert.equal(h.document.querySelector('.artifact-diff'), null);
    entries.push(versions()[1]!);
    action(h, 'Refresh artifacts'); await h.settle();
    assert.equal(h.document.querySelector<HTMLSelectElement>('.artifact-version-select')!.value, 'midi-a');
    assert.equal(h.document.querySelectorAll('.artifact-version-select option').length, 2);
    assert.deepEqual([...h.document.querySelectorAll<HTMLOptionElement>('.artifact-diff-baseline option')].map((option) => option.value), ['midi-v2']);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("new comparison baselines preserve expanded state and a pending unchanged comparison", async () => {
  const entries = versions();
  const s = await setup(false, entries); const { h } = s;
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  let signal: AbortSignal | undefined;
  const requests: string[] = [];
  const originalFetch = h.window.fetch;
  Object.defineProperty(h.window, 'fetch', { configurable: true, value: async (input: string, init?: RequestInit) => {
    if (new URL(String(input)).pathname === '/midi-artifact-diff') {
      const body = JSON.parse(String(init?.body)); requests.push(body.baseArtifactRef);
      if (body.baseArtifactRef === 'midi-v2') { signal = init?.signal ?? undefined; await gate; }
      return { ok: true, json: async () => ({ ...diffFixture(s.state.activeSessionId!), baseArtifactRef: body.baseArtifactRef,
        baseVersion: body.baseArtifactRef === 'midi-v2' ? 2 : 1 }) };
    }
    return originalFetch(input, init);
  } });
  try {
    await s.open(); h.click('.artifact-open'); h.click('.artifact-diff > summary'); await h.settle();
    h.select('.artifact-diff-baseline select', 'midi-v2');
    await waitForCondition(() => Boolean(signal), 'Expected pending sibling comparison');
    const detail = h.document.querySelector<HTMLDetailsElement>('.artifact-diff')!;
    entries.push({ ...entries[2]!, ref: { kind: 'midi', id: 'midi-v4' }, label: 'Phrase 4',
      version: { ...entries[2]!.version!, number: 4 } });
    action(h, 'Refresh artifacts'); await h.settle();
    assert.equal(h.document.querySelector('.artifact-diff'), detail); assert.equal(detail.open, true);
    assert.equal(h.document.querySelector<HTMLSelectElement>('.artifact-version-select')!.value, 'midi-v3');
    assert.equal(h.document.querySelector<HTMLSelectElement>('.artifact-diff-baseline select')!.value, 'midi-v2');
    assert.deepEqual([...h.document.querySelectorAll<HTMLOptionElement>('.artifact-diff-baseline option')].map((option) => option.value), ['midi-a', 'midi-v2', 'midi-v4']);
    assert.equal(signal!.aborted, false); assert.deepEqual(requests, ['midi-a', 'midi-v2']);
    release(); await h.settle();
    const loaded = h.document.querySelector('.artifact-diff-content')!.textContent;
    action(h, 'Refresh artifacts'); await h.settle();
    assert.equal(h.document.querySelector('.artifact-diff-content')!.textContent, loaded);
    assert.deepEqual(requests, ['midi-a', 'midi-v2']); assert.deepEqual(h.errors, []);
  } finally { release(); h.close(); }
});

test("an unavailable active sibling comparison aborts and falls back to the surviving source", async () => {
  const entries = versions();
  const s = await setup(false, entries); const { h } = s;
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  let signal: AbortSignal | undefined;
  const requests: string[] = [];
  const originalFetch = h.window.fetch;
  Object.defineProperty(h.window, 'fetch', { configurable: true, value: async (input: string, init?: RequestInit) => {
    if (new URL(String(input)).pathname === '/midi-artifact-diff') {
      const body = JSON.parse(String(init?.body)); requests.push(body.baseArtifactRef);
      if (body.baseArtifactRef === 'midi-v2') { signal = init?.signal ?? undefined; await gate; }
      return { ok: true, json: async () => ({ ...diffFixture(s.state.activeSessionId!), baseArtifactRef: body.baseArtifactRef,
        baseVersion: body.baseArtifactRef === 'midi-v2' ? 2 : 1 }) };
    }
    return originalFetch(input, init);
  } });
  try {
    await s.open(); h.click('.artifact-open'); h.click('.artifact-diff > summary'); await h.settle();
    h.select('.artifact-diff-baseline select', 'midi-v2');
    await waitForCondition(() => Boolean(signal), 'Expected pending sibling comparison');
    entries.splice(1, 1); action(h, 'Refresh artifacts'); await h.settle();
    assert.equal(signal!.aborted, true);
    assert.equal(h.document.querySelector<HTMLSelectElement>('.artifact-diff-baseline select')!.value, 'midi-a');
    assert.deepEqual(requests, ['midi-a', 'midi-v2', 'midi-a']);
    release(); await h.settle();
    assert.deepEqual(h.errors, []);
  } finally { release(); h.close(); }
});

for (const media of ['midi', 'audio'] as const) test(`${media} primary waits for the exact selected version to finish loading`, async () => {
  const entries: SessionArtifact[] = media === 'midi' ? versions() : [1, 2, 3].map((number) => ({ ...artifacts[1]!,
    ref: { kind: 'audio', id: `audio-v${number}` }, version: { groupId: 'audio-v1', groupLabel: 'Arrangement', number,
      ...(number > 1 ? { derivedFromId: 'audio-v1' } : {}) } }));
  const s = await setup(false, entries); const { h } = s;
  const selected = entries[0]!.ref.id;
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  let loading = false;
  const originalFetch = h.window.fetch;
  Object.defineProperty(h.window, 'fetch', { configurable: true, value: async (input: string, init?: RequestInit) => {
    if (new URL(String(input)).pathname === '/session-artifact') { loading = true; await gate; }
    return originalFetch(input, init);
  } });
  try {
    await s.open(); h.click('.artifact-open'); h.select('.artifact-version-select', selected);
    await waitForCondition(() => loading, 'Expected pending version read');
    h.emitServerEvent({ type: 'session_state_invalidated', sessionId: s.state.activeSessionId }); await h.settle();
    assert.equal(h.document.querySelector<HTMLButtonElement>('.artifact-primary')!.disabled, true);
    h.click('.artifact-primary'); await h.settle(); assert.deepEqual(commandCalls(h), []);
    release(); await h.settle();
    assert.equal(h.document.querySelector<HTMLButtonElement>('.artifact-primary')!.disabled, false);
    h.click('.artifact-primary'); await h.settle();
    assert.deepEqual((commandCalls(h).at(-1)!.body as { selection: ArtifactSelection }).selection,
      { action: 'primary', group: { kind: media, id: selected }, candidate: { kind: media, id: selected } });
    assert.deepEqual(h.errors, []);
  } finally { release(); h.close(); }
});


test("audio siblings describe their stored alternative version without implying a parent", async () => {
  const entries: SessionArtifact[] = [1, 2].map((number) => ({ ...artifacts[1]!,
    ref: { kind: "audio", id: `audio-v${number}` },
    version: { groupId: "audio-v1", groupLabel: "Arrangement", number } }));
  const s = await setup(false, entries); const { h } = s;
  try {
    await s.open(); h.click(".artifact-open");
    assert.equal(h.document.querySelector(".artifact-version-source")!.textContent, "v2 · alternative");
    assert.equal(h.document.querySelector(".artifact-diff"), null);
    h.select(".artifact-version-select", "audio-v1"); await h.settle();
    assert.equal(h.document.querySelector(".artifact-version-source")!.textContent, "v1 · original");
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});


test("Chinese artifact sources preserve authored names and exact artifact actions", async () => {
  const entries = [{ ...artifacts[0]!, label: "Primary", sourceLabel: "Live MIDI source" },
    { ...artifacts[1]!, label: "Source", sourceLabel: "Plugin-generated audio" }];
  const s = await setup(false, entries, "zh-CN"); const { h } = s;
  try {
    await s.open(); h.click('button.artifact-open[data-artifact-key="midi:midi-a"]');
    h.click('button.artifact-open[data-artifact-key="audio:audio-b"]');
    assert.equal(h.document.querySelector('#artifact-preview-midi-midi-a > p')!.textContent, "Live MIDI 来源");
    assert.equal(h.document.querySelector('#artifact-preview-audio-audio-b > p')!.textContent, "插件生成的音频");
    assert.deepEqual([...h.document.querySelectorAll('.artifact-open')].map((node) => node.textContent), ["Primary", "Source"]);
    action(h, "导出音频"); await h.settle();
    assert.deepEqual(commandCalls(h).at(-1)!.body, { kind: "export_artifact", sessionId: s.state.activeSessionId, artifact: { kind: "audio", id: "audio-b" } });
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("changing language refreshes retained artifact, difference and import views without resetting choices", async () => {
  const s = await setup(false, [...versions(), artifacts[1]!]); const { h } = s;
  const originalFetch = h.window.fetch;
  Object.defineProperty(h.window, "fetch", { configurable: true, value: async (input: string, init?: RequestInit) => {
    if (new URL(String(input)).pathname === "/midi-artifact-diff") {
      const body = JSON.parse(String(init?.body));
      return { ok: true, json: async () => ({ ...diffFixture(s.state.activeSessionId!), artifactRef: body.artifactRef, baseArtifactRef: body.baseArtifactRef }) };
    }
    return originalFetch(input, init);
  } });
  try {
    await s.open(); h.click('button.artifact-open[data-artifact-key="midi:midi-a"]');
    h.select('.artifact-version-select', 'midi-v2'); await h.settle();
    h.click('.artifact-diff > summary');
    await waitForCondition(() => Boolean(h.document.querySelector('.artifact-diff-overview')), "Expected loaded difference");
    const version = h.document.querySelector<HTMLSelectElement>('.artifact-version-select')!;
    const baseline = h.document.querySelector<HTMLSelectElement>('.artifact-diff-baseline select')!;
    h.click('button.artifact-open[data-artifact-key="audio:audio-b"]');
    const audio = h.document.querySelector<HTMLAudioElement>('.artifact-card audio')!; audio.currentTime = 12;
    action(h, 'Add to Live'); await waitForCondition(() => Boolean(h.document.querySelector('.plugin-result-track')), 'Expected import');
    h.select('.plugin-result-track', '2'); h.input('.plugin-result-beat', '9');
    const track = h.document.querySelector<HTMLSelectElement>('.plugin-result-track')!;
    h.emitServerEvent({ type: 'global_settings_changed', defaultFollowUpBehavior: s.state.settings.defaultFollowUpBehavior,
      defaultFollowUpBehaviorRevision: s.state.settings.defaultFollowUpBehaviorRevision, showContextUsage: s.state.settings.showContextUsage,
      contextUsageVisibilityRevision: s.state.settings.contextUsageVisibilityRevision, uiLanguage: 'zh-CN', uiLanguageRevision: '1', commandId: 'peer-language' });
    await h.settle();
    assert.equal(h.document.querySelector('.artifact-primary')!.textContent, '设为主版本');
    assert.equal(h.document.querySelector('.artifact-diff-baseline span')!.textContent, '比较基准');
    assert.match(h.document.querySelector('.artifact-diff-overview')!.textContent!, /升高 2 个半音/);
    assert.match(h.document.querySelector('.artifact-diff-chart .after title')!.textContent!, /修改前：C3 · 第 1 拍/s);
    assert.equal(h.document.querySelector('#midi-import-heading')!.textContent, '将 MIDI 添加到 Live');
    assert.match(h.document.querySelector('.plugin-result-preview')!.textContent!, /Piano.*第 9–17 拍/);
    assert.equal(h.document.querySelector('.artifact-version-select'), version); assert.equal(version.value, 'midi-v2');
    assert.equal(h.document.querySelector('.artifact-diff-baseline select'), baseline); assert.equal(baseline.value, 'midi-a');
    assert.equal(h.document.querySelector('.plugin-result-track'), track); assert.equal(track.value, '2');
    assert.equal(h.document.querySelector('.artifact-card audio'), audio); assert.equal(audio.currentTime, 12);
    h.emitServerEvent({ type: 'global_settings_changed', defaultFollowUpBehavior: s.state.settings.defaultFollowUpBehavior,
      defaultFollowUpBehaviorRevision: s.state.settings.defaultFollowUpBehaviorRevision, showContextUsage: s.state.settings.showContextUsage,
      contextUsageVisibilityRevision: s.state.settings.contextUsageVisibilityRevision, uiLanguage: 'en', uiLanguageRevision: '2', commandId: 'peer-language-en' });
    await h.settle();
    assert.equal(h.document.querySelector('#midi-import-heading')!.textContent, 'Add MIDI to Live');
    assert.match(h.document.querySelector('.artifact-diff-overview')!.textContent!, /Up 2 semitones/);
    assert.equal(h.document.querySelector('.plugin-result-track'), track); assert.equal(track.value, '2');
    assert.equal(h.document.querySelector('.artifact-card audio'), audio); assert.equal(audio.currentTime, 12);
    assert.equal(commandCalls(h).length, 0); assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});


test("difference part selection shows only that part on a shared beat scale without another request", async () => {
  const s = await setup(false, versions()); const { h } = s;
  const result = diffFixture(s.state.activeSessionId!);
  result.modified = 2;
  result.parts.push({ ...result.parts[0]!, before: { id: 'track-1-channel-2', label: 'Bass F', channel: 2 },
    after: { id: 'track-1-channel-2', label: 'Bass G', channel: 2 },
    changes: [{ kind: 'modified', before: { pitch: 36, startTime: 4, duration: 2, velocity: 90 },
      after: { pitch: 38, startTime: 4, duration: 2, velocity: 90 } }] });
  let reads = 0; const originalFetch = h.window.fetch;
  Object.defineProperty(h.window, 'fetch', { configurable: true, value: async (input: string, init?: RequestInit) => {
    if (new URL(String(input)).pathname === '/midi-artifact-diff') { reads++; return { ok: true, json: async () => result }; }
    return originalFetch(input, init);
  } });
  try {
    await s.open(); h.click('.artifact-open'); h.click('.artifact-diff > summary'); await h.settle();
    h.select('.artifact-diff-part-select', '1');
    const notes = [...h.document.querySelectorAll('.artifact-diff-chart .piano-roll-note')];
    assert.deepEqual(notes.map((node) => node.getAttribute('data-pitch')), ['36', '38']);
    assert.equal(Number(notes[0]!.getAttribute('x')), 4 / 12 * 640);
    assert.equal(notes[0]!.getAttribute('x'), notes[1]!.getAttribute('x'));
    h.select('.artifact-diff-part-select', '0');
    assert.deepEqual([...h.document.querySelectorAll('.artifact-diff-chart .piano-roll-note')].map((node) => node.getAttribute('data-pitch')), ['60', '62']);
    assert.equal(reads, 1); assert.deepEqual(commandCalls(h), []); assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});


test("long and short MIDI versions share zoom and pan while refresh and language changes retain the viewport", async () => {
  const s = await setup(false, versions()); const { h } = s;
  const result = diffFixture(s.state.activeSessionId!);
  result.beforeDurationBeats = 4; result.afterDurationBeats = 128;
  const part = result.parts[0]!;
  delete part.transposeSemitones;
  part.changes = [{ kind: 'modified', before: { pitch: 60, startTime: 0, duration: 4, velocity: 96 },
    after: { pitch: 62, startTime: 0, duration: 4, velocity: 96 } },
    { kind: 'added', after: { pitch: 72, startTime: 120, duration: 8, velocity: 96 } }];
  result.added = part.added = 1;
  let reads = 0; const originalFetch = h.window.fetch;
  Object.defineProperty(h.window, 'fetch', { configurable: true, value: async (input: string, init?: RequestInit) => {
    if (new URL(String(input)).pathname === '/midi-artifact-diff') { reads++; return { ok: true, json: async () => result }; }
    return originalFetch(input, init);
  } });
  try {
    await s.open(); h.click('.artifact-open'); h.click('.artifact-diff > summary'); await h.settle();
    const prefix = '.artifact-diff-chart ';
    const position = h.document.querySelector<HTMLInputElement>(prefix + '.piano-roll-position')!;
    const notes = () => [...h.document.querySelectorAll(prefix + 'rect[data-pitch]')];
    assert.equal(position.value, '0'); assert.equal(position.max, '112');
    assert.deepEqual(notes().map((node) => node.getAttribute('data-pitch')), ['60', '62']);
    assert.deepEqual(notes().map((node) => node.getAttribute('width')), ['160', '160']);
    h.click(prefix + '.piano-roll-zoom-in');
    assert.deepEqual(notes().map((node) => node.getAttribute('width')), ['320', '320']);
    position.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    assert.equal(position.value, '120');
    assert.deepEqual(notes().map((node) => node.getAttribute('data-pitch')), ['72']);
    assert.equal(notes()[0]!.getAttribute('x'), '0'); assert.equal(notes()[0]!.getAttribute('width'), '640');
    const figure = h.document.querySelector(prefix + 'figure')!;
    const vertical = new h.window.WheelEvent('wheel', { deltaY: 40, bubbles: true, cancelable: true });
    figure.dispatchEvent(vertical); assert.equal(vertical.defaultPrevented, false); assert.equal(position.value, '120');
    const horizontal = new h.window.WheelEvent('wheel', { deltaX: -320, bubbles: true, cancelable: true });
    figure.dispatchEvent(horizontal); assert.equal(horizontal.defaultPrevented, true); assert.equal(position.value, '116');
    action(h, 'Refresh artifacts'); await h.settle();
    assert.equal(h.document.querySelector(prefix + '.piano-roll-position'), position); assert.equal(position.value, '116');
    h.emitServerEvent({ type: 'global_settings_changed', defaultFollowUpBehavior: s.state.settings.defaultFollowUpBehavior,
      defaultFollowUpBehaviorRevision: s.state.settings.defaultFollowUpBehaviorRevision, showContextUsage: s.state.settings.showContextUsage,
      contextUsageVisibilityRevision: s.state.settings.contextUsageVisibilityRevision, uiLanguage: 'zh-CN', uiLanguageRevision: '1', commandId: 'piano-language' });
    await h.settle();
    assert.equal(position.value, '116'); assert.equal(position.getAttribute('aria-valuetext'), '第 117–125 拍');
    assert.equal(h.document.querySelector(prefix + '.piano-roll-full')!.textContent, '查看全曲');
    h.click(prefix + '.piano-roll-full');
    assert.equal(position.hidden, true);
    assert.deepEqual(notes().map((node) => node.getAttribute('data-pitch')), ['60', '62', '72']);
    assert.equal(notes()[0]!.getAttribute('width'), '20');
    h.click(prefix + '.piano-roll-focus');
    assert.equal(position.hidden, false); assert.equal(position.value, '0'); assert.equal(position.max, '112');
    assert.equal(reads, 1); assert.deepEqual(commandCalls(h), []); assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("late changes are focused automatically and notes crossing a viewport edge are clipped on the same beat scale", async () => {
  const s = await setup(false, versions()); const { h } = s;
  const result = diffFixture(s.state.activeSessionId!);
  result.beforeDurationBeats = 512; result.afterDurationBeats = 128;
  const part = result.parts[0]!; delete part.transposeSemitones;
  part.properties = { pitch: 0, startTime: 0, duration: 1, velocity: 0 };
  part.changes = [{ kind: 'modified', before: { pitch: 60, startTime: 120, duration: 80, velocity: 96 },
    after: { pitch: 60, startTime: 120, duration: 4, velocity: 96 } }];
  const originalFetch = h.window.fetch;
  Object.defineProperty(h.window, 'fetch', { configurable: true, value: async (input: string, init?: RequestInit) => {
    if (new URL(String(input)).pathname === '/midi-artifact-diff') return { ok: true, json: async () => result };
    return originalFetch(input, init);
  } });
  try {
    await s.open(); h.click('.artifact-open'); h.click('.artifact-diff > summary'); await h.settle();
    const prefix = '.artifact-diff-chart ';
    const position = h.document.querySelector<HTMLInputElement>(prefix + '.piano-roll-position')!;
    assert.equal(position.value, '118'); assert.equal(position.max, '496');
    h.input(prefix + '.piano-roll-position', '122');
    const before = h.document.querySelector(prefix + '.piano-roll-note.before')!;
    const after = h.document.querySelector(prefix + '.piano-roll-note.after')!;
    assert.equal(before.getAttribute('x'), '0'); assert.equal(before.getAttribute('width'), '640');
    assert.equal(after.getAttribute('x'), '0'); assert.equal(after.getAttribute('width'), '80');
    assert.match(before.textContent!, /beat 121.*length 80/);
    h.input(prefix + '.piano-roll-position', '198');
    assert.equal(h.document.querySelector(prefix + '.piano-roll-note.before')!.getAttribute('width'), '80');
    assert.equal(h.document.querySelector(prefix + '.piano-roll-note.after'), null);
    h.click(prefix + '.piano-roll-focus'); assert.equal(position.value, '118');
    assert.deepEqual(commandCalls(h), []); assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});


test("a dense preview retries its exact read and retains complete notes when the catalog refreshes", async () => {
  const notes = Array.from({ length: 300 }, (_, index) => ({ partId: 'track-0-channel-1', pitch: 60, startTime: index, duration: .5 }));
  const base = { ...artifacts[0]!, midi: { ...artifacts[0]!.midi!, noteCount: 300, durationBeats: 300,
    parts: [{ ...artifacts[0]!.midi!.parts[0]!, noteCount: 300, durationBeats: 300 }], notes: notes.slice(0, 256), omittedNoteCount: 44 } };
  const s = await setup(false, [base]); const { h } = s;
  let reads = 0; const originalFetch = h.window.fetch;
  Object.defineProperty(h.window, 'fetch', { configurable: true, value: async (input: string, init?: RequestInit) => {
    if (new URL(String(input)).pathname === '/session-artifact') {
      reads++;
      return reads === 1 ? { ok: false, json: async () => ({ error: 'Preview read failed.' }) }
        : { ok: true, json: async () => ({ sessionId: s.state.activeSessionId,
          artifact: { ...base, midi: { ...base.midi, notes, omittedNoteCount: 0 } } }) };
    }
    return originalFetch(input, init);
  } });
  try {
    await s.open(); h.click('.artifact-open'); await h.settle();
    assert.match(h.document.querySelector('.artifact-version-status')!.textContent!, /Preview read failed/);
    assert.equal(h.document.querySelector('.midi-piano-roll'), null);
    h.click('.artifact-version-retry'); await h.settle();
    h.input('.piano-roll-position', '280');
    const position = h.document.querySelector<HTMLInputElement>('.piano-roll-position')!;
    const svg = h.document.querySelector('svg[aria-label="Saved MIDI note preview"]')!;
    assert.match(svg.textContent!, /beat 281/);
    action(h, 'Refresh artifacts'); await h.settle();
    assert.equal(h.document.querySelector('.piano-roll-position'), position); assert.equal(position.value, '280');
    assert.equal(h.document.querySelector('svg[aria-label="Saved MIDI note preview"]'), svg);
    assert.match(svg.textContent!, /beat 296/);
    assert.equal(reads, 2); assert.deepEqual(commandCalls(h), []); assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("browser resume restarts an interrupted dense MIDI preview without a user retry", async () => {
  const notes = Array.from({ length: 300 }, (_, index) => ({ partId: "track-0-channel-1", pitch: 60, startTime: index, duration: .5 }));
  const base = { ...artifacts[0]!, midi: { ...artifacts[0]!.midi!, noteCount: 300, durationBeats: 300,
    parts: [{ ...artifacts[0]!.midi!.parts[0]!, noteCount: 300, durationBeats: 300 }], notes: notes.slice(0, 256), omittedNoteCount: 44 } };
  const s = await setup(false, [base]); const { h } = s;
  let reads = 0; let heldSignal: AbortSignal | null | undefined;
  let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
  const originalFetch = h.window.fetch;
  Object.defineProperty(h.window, "fetch", { configurable: true, value: async (input: string, init?: RequestInit) => {
    if (new URL(String(input)).pathname === "/session-artifact") {
      reads++;
      if (reads === 1) { heldSignal = init?.signal; await held; }
      return { ok: true, json: async () => ({ sessionId: s.state.activeSessionId,
        artifact: { ...base, midi: { ...base.midi, notes, omittedNoteCount: 0 } } }) };
    }
    return originalFetch(input, init);
  } });
  try {
    await s.open(); h.click(".artifact-open");
    await waitForCondition(() => Boolean(heldSignal), "Expected full MIDI hydration");
    h.window.dispatchEvent(new h.window.PageTransitionEvent("pagehide", { persisted: true }));
    assert.equal(heldSignal!.aborted, true); release(); await h.settle();
    assert.equal(reads, 1); assert.equal(h.document.querySelector(".midi-piano-roll"), null);
    h.window.dispatchEvent(new h.window.PageTransitionEvent("pageshow", { persisted: true }));
    await waitForCondition(() => Boolean(h.document.querySelector(".midi-piano-roll")), "Expected a resumed complete preview");
    assert.equal(reads, 2);
    h.input(".piano-roll-position", "280");
    assert.match(h.document.querySelector('svg[aria-label="Saved MIDI note preview"]')!.textContent!, /beat 296/);
    assert.deepEqual(commandCalls(h), []); assert.deepEqual(h.errors, []);
  } finally { release(); h.close(); }
});
