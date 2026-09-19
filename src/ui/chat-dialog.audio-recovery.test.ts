import assert from "node:assert/strict";
import test from "node:test";
import { audioJobViews, resumeAudioJob } from "../app/audio-processing.js";
import { audioRecoveryHarness } from "../app/audio-recovery-test-helpers.js";
import { updateAudioJob } from "../storage/audio-jobs.js";
import { integrationConnectionsView, loadAgentSettings } from "../storage/settings.js";
import { audioState } from "./chat-dialog.audio-test-helpers.js";
import { commandCalls, createDialogHarness } from "./chat-dialog.test-harness.js";

for (const condition of ["disabled", "cleared", "removed", "replaced"] as const) {
  test(`host-authorized local recovery remains actionable when its connection is ${condition}`, async (t) => {
    const backend = await audioRecoveryHarness(t, "elevenlabs");
    const first = await backend.run();
    await updateAudioJob(backend.storage, backend.session.id, first.id, { status: "collecting", outputAssets: [] });
    await backend.change(condition === "removed" ? "remove" : condition === "replaced" ? { provider: "lalal" }
      : { enabled: false, ...(condition === "cleared" ? { apiKey: "" } : {}) });
    const state = audioState();
    state.activeSessionId = backend.session.id;
    state.sessions[0] = { ...state.sessions[0]!, id: backend.session.id };
    state.integrationConnections = integrationConnectionsView((await loadAgentSettings(backend.storage)).integrationConnections!);
    state.audioJobs = await audioJobViews(backend.storage, backend.session.id);
    assert.equal(state.audioJobs[0]!.resumable, true);
    const h = await createDialogHarness(state);
    let holdingCommand = false;
    try {
      const resume = h.document.querySelector<HTMLButtonElement>("[data-resume-audio-job]")!;
      assert.equal(resume.disabled, false);
      h.holdNextCommand();
      holdingCommand = true;
      resume.click(); await h.settle();
      assert.equal(resume.disabled, true, "pending operations still prevent duplicate recovery");
      assert.deepEqual(commandCalls(h).at(-1)?.body, {
        kind: "resume_audio_job", sessionId: backend.session.id, jobId: first.id,
      });
      const before = backend.calls.length;
      const recovered = await resumeAudioJob(backend.context, first.id);
      assert.equal(recovered.status, "completed");
      assert.equal(backend.calls.length, before, "local recovery must not access a provider");
      h.setServerState({ ...state, audioJobs: await audioJobViews(backend.storage, backend.session.id) });
      h.releaseHeldCommand(); holdingCommand = false; await h.settle();
      assert.equal(h.document.querySelectorAll("#audioJobs audio").length, 1);
      assert.equal(h.document.querySelector("[data-resume-audio-job]"), null);
      assert.deepEqual(h.errors, []);
    } finally { if (holdingCommand) h.releaseHeldCommand(); h.close(); }
  });
}
