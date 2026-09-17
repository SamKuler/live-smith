import assert from "node:assert/strict";
import test from "node:test";
import { commandCalls, createDialogHarness } from "./chat-dialog.test-harness.js";
import { audioState, job } from "./chat-dialog.audio-test-helpers.js";

const website = { id: "suno-personal", name: "Personal Suno", provider: "suno" as const, enabled: true, apiKeyConfigured: false };
const clipId = "11111111-1111-4111-8111-111111111111";
function stateWithResult() {
  const state = audioState([website]);
  state.audioJobs = [job(state.activeSessionId, { provider: "suno", serviceId: website.id, operation: "generate_music", status: "ready",
    stems: [], outputs: [], remoteOutputs: [{ key: clipId, role: "music" }], resumable: false })];
  return state;
}

test("results belong to a collapsible active-Session shelf outside application settings", async () => {
  const h = await createDialogHarness(stateWithResult());
  try {
    const shelf = h.document.querySelector<HTMLDetailsElement>("#sessionAudioResults")!;
    assert.ok(shelf.closest(".chat-pane"));
    assert.equal(h.document.querySelector("#appPanel #audioJobs"), null);
    assert.equal(h.document.querySelectorAll("#audioJobs").length, 1);
    assert.equal(shelf.hidden, false); assert.equal(shelf.open, false);
    h.click("#sessionAudioResultsSummary"); await h.settle();
    assert.equal(shelf.open, true);
    assert.equal(h.document.querySelector("#sessionAudioResultsCount")!.textContent, "1");
    assert.equal(h.document.querySelector("#sessionAudioResultsStatus")!.textContent, "Latest: Generated · online");
    assert.equal(h.document.querySelector("#sessionAudioResultsStatus")!.getAttribute("data-status"), "complete");
    assert.equal(h.document.querySelector("#audioJobs h4")!.textContent, "Audio 1 · Music generation");
    assert.equal(h.document.querySelector("#audioJobs .activity-state")!.textContent, "Generated · online");
    assert.equal(commandCalls(h).length, 0);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("collapsing results stops remote preview and local audio, and reopening never auto-plays", async () => {
  const state = stateWithResult();
  state.audioJobs![0]!.outputs = [{ ...job(state.activeSessionId).outputs[0]!, role: "music", label: "Music", origin: { kind: "generated" } }];
  state.audioJobs![0]!.remoteOutputs!.push({ key: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", role: "music_alternative" });
  const h = await createDialogHarness(state);
  try {
    h.click('[data-remote-audio-key="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"] [data-preview-audio]'); await h.settle();
    const frame = h.document.querySelector("#audioJobs iframe")!;
    const player = h.document.querySelector<HTMLAudioElement>("#audioJobs audio")!;
    let pauses = 0;
    Object.defineProperty(player, "paused", { get: () => false });
    player.pause = () => { pauses++; };
    h.click("#sessionAudioResultsSummary"); await h.settle();
    assert.equal(frame.isConnected, false);
    assert.equal(h.document.querySelector("#audioJobs iframe"), null);
    assert.equal(pauses, 1);
    assert.equal(h.document.querySelector("[data-preview-audio]")!.getAttribute("aria-expanded"), "false");
    h.click("#sessionAudioResultsSummary"); await h.settle();
    assert.equal(h.document.querySelector("#audioJobs iframe"), null);
    assert.equal(h.document.querySelector("#audioJobs audio"), player);
    assert.equal(commandCalls(h).length, 0);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("switching Sessions closes the shelf and removes the previous Session's players", async () => {
  const state = stateWithResult();
  const h = await createDialogHarness(state);
  try {
    h.click("[data-preview-audio]"); await h.settle();
    h.setServerState({ ...state, audioJobs: [] });
    h.click('.session-entry[data-session-id="session-2"] .session-row'); await h.settle();
    const shelf = h.document.querySelector<HTMLDetailsElement>("#sessionAudioResults")!;
    assert.equal(shelf.open, false); assert.equal(shelf.hidden, true);
    assert.equal(h.document.querySelector("#audioJobs iframe"), null);
    assert.equal(h.document.querySelector<HTMLElement>("#audioJobs")!.dataset.sessionId, "session-2");
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});
