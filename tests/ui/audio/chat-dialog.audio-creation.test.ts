import assert from "node:assert/strict";
import test from "node:test";
import { SUNO_STEM_ROLES, type AudioJobView } from "../../../src/audio-services/contracts.js";
import { audioState, job } from "../support/chat-dialog.audio-test-helpers.js";
import { createDialogHarness } from "../support/chat-dialog.test-harness.js";

const website = { id: "suno-studio", name: "Suno Studio", provider: "suno" as const, enabled: true, apiKeyConfigured: false };
const first = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";
function stateFor(operation: AudioJobView["operation"], roles: NonNullable<AudioJobView["remoteOutputs"]>) {
  const state = audioState([website]); state.settings.uiLanguage = "zh-CN";
  state.sunoAccounts = [{ serviceId: website.id, status: "signed_in", accountId: "user_studio" }];
  state.audioJobs = [job(state.activeSessionId, { provider: "suno", serviceId: website.id, operation,
    status: "ready", stems: [], outputs: [], remoteOutputs: roles, resumable: false })];
  return state;
}

test("Suno editing jobs render translated operation names and candidate outputs", async () => {
  const operations = [
    ["add_vocals", "添加人声"], ["add_instrumental", "添加伴奏"], ["replace_music_section", "替换歌曲片段"],
    ["finish_music_replacement", "完成片段替换"],
  ] as const;
  for (const [operation, label] of operations) {
    const outputs = operation === "finish_music_replacement" ? [{ key: first, role: "music" as const }] :
      [{ key: first, role: "music" as const }, { key: second, role: "music_alternative" as const }];
    const h = await createDialogHarness(stateFor(operation, outputs));
    try {
      assert.deepEqual(h.errors, [], operation);
      assert.match(h.document.querySelector("#audioJobs")!.textContent!, new RegExp(label));
      assert.equal(h.document.querySelectorAll("[data-audio-result]").length, outputs.length);
      assert.equal(h.document.querySelectorAll("[data-download-audio-output]").length, outputs.length);
    } finally { h.close(); }
  }
});

test("uploaded audio renders as uploaded and its downloaded form keeps the same output row", async () => {
  const state = stateFor("upload_music", [{ key: first, role: "uploaded_audio" }]);
  const h = await createDialogHarness(state);
  try {
    assert.deepEqual(h.errors, []);
    const output = h.document.querySelector<HTMLElement>('[data-audio-role="uploaded_audio"]')!;
    assert.ok(output); assert.match(output.textContent!, /已上传音频/);
    assert.match(h.document.querySelector("#audioJobs .activity-state")!.textContent!, /已上传/);
    assert.doesNotMatch(h.document.querySelector("#audioJobs .activity-state")!.textContent!, /已生成/);
    const asset = { ...job(state.activeSessionId).outputs[0]!, role: "uploaded_audio" as const, origin: { kind: "generated" as const } };
    h.setServerState({ ...state, audioJobs: [{ ...state.audioJobs![0]!, outputs: [asset] }] });
    h.emitServerEvent({ type: "session_state_invalidated", sessionId: state.activeSessionId }); await h.settle();
    assert.equal(h.document.querySelector('[data-audio-role="uploaded_audio"]'), output);
    assert.ok(output.querySelector("audio")); assert.equal(output.querySelector("[data-download-audio-output]"), null);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("wire admission rejects wrong output roles and extra single-operation outputs", async () => {
  const state = stateFor("finish_music_replacement", [{ key: first, role: "music" }]);
  const h = await createDialogHarness(state);
  try {
    const original = h.document.querySelector("[data-audio-result]"); assert.ok(original);
    for (const invalid of [
      { operation: "finish_music_replacement", remoteOutputs: [{ key: first, role: "music_alternative" }] },
      { operation: "finish_music_replacement", remoteOutputs: [{ key: first, role: "music" }, { key: second, role: "music_alternative" }] },
      { operation: "generate_music", remoteOutputs: [{ key: first, role: "uploaded_audio" }] },
      { operation: "upload_music", remoteOutputs: [{ key: first, role: "music" }] },
    ] as const) {
      h.setServerState({ ...state, audioJobs: [{ ...state.audioJobs![0]!, ...invalid }] } as never);
      h.emitServerEvent({ type: "session_state_invalidated", sessionId: state.activeSessionId }); await h.settle();
      assert.equal(h.document.querySelector("[data-audio-result]"), original);
      assert.equal(h.document.querySelectorAll("[data-audio-result]").length, 1);
    }
  } finally { h.close(); }
});

test("Suno stem jobs display all named outputs and preserve their download targets", async () => {
  const remotes = SUNO_STEM_ROLES.map((role, index) => ({ key: `11111111-1111-4111-8111-${String(index + 1).padStart(12, "0")}`, role }));
  const state = stateFor("extract_music_stems", remotes);
  const h = await createDialogHarness(state);
  try {
    assert.deepEqual(h.errors, []); assert.equal(h.document.querySelectorAll("[data-audio-result]").length, SUNO_STEM_ROLES.length);
    assert.match(h.document.querySelector("#audioJobs")!.textContent!, /提取歌曲分轨/);
    assert.match(h.document.querySelector('[data-audio-role="suno_stem_backing_vocals"]')!.textContent!, /和声/);
    assert.match(h.document.querySelector('[data-audio-role="suno_stem_woodwinds"]')!.textContent!, /木管/);
    for (const output of remotes) assert.equal(h.document.querySelector(`[data-audio-role="${output.role}"] [data-download-audio-output]`)!.getAttribute("data-download-audio-output"), output.key);
    h.setServerState({ ...state, audioJobs: [{ ...state.audioJobs![0]!, status: "partial", remoteOutputs: remotes.slice(0, 2) }] });
    h.emitServerEvent({ type: "session_state_invalidated", sessionId: state.activeSessionId }); await h.settle();
    assert.equal(h.document.querySelectorAll("[data-audio-result]").length, 2);
  } finally { h.close(); }
});
