import assert from "node:assert/strict";
import test from "node:test";
import { AudioTrack } from "@ableton-extensions/sdk";

import { validateAgentPlan } from "../../../src/agent/actions.js";
import { assertEditScopesAllow } from "../../../src/agent/edit-scopes.js";
import { bindAgentPlanTargets } from "../../../src/live/action-bindings.js";
import { requiredEditScopesForPlan } from "../../../src/live/action-permissions.js";
import { executeAgentPlanWithProgress } from "../../../src/live/executor.js";
import { captureLiveActionPreflightSnapshot } from "../../../src/live/preflight.js";
import { addAudioAssetSampleSources } from "../../../src/app/audio/audio-asset-sources.js";
import { assetHarness } from "./support/audio-asset-sources-test-helpers.js";
import { LiveMutationQueue } from "../../../src/app/live-mutation-queue.js";
import { prepareRequestAudioSampleSources } from "../../../src/app/audio/request-audio-sources.js";

for (const kind of ["separation", "generation"] as const) {
test(`queued ${kind} asset preparation passes only the imported Live path to the existing Clip executor`, async (t) => {
  const h = await assetHarness(t, kind);
  const asset = await h.save();
  await addAudioAssetSampleSources(h.input, h.sources, [asset]);
  const created: unknown[] = [];
  const track = Object.create(AudioTrack.prototype);
  for (const [key, value] of Object.entries({
    handle: { id: "track-a" }, name: "Audio", arrangementClips: [], clipSlots: [], devices: [],
    async createAudioClip(options: unknown) {
      h.operations.push("clip");
      created.push(options);
      return { name: "Imported stem" };
    },
  })) Object.defineProperty(track, key, { configurable: true, value });
  const context = { ...h.host, application: { song: { handle: { id: "song" }, tracks: [track] } } } as never;
  const action = {
    type: "create_arrangement_audio_clip" as const, trackName: "Audio", startBeat: 4,
    durationBeats: 8, source: { kind: "audio_asset" as const, assetRef: asset.id },
  };
  const plan = validateAgentPlan({ message: "Import persisted stem", actions: [action] });
  const bindings = bindAgentPlanTargets(context, plan, {}, h.sources);
  const snapshot = await captureLiveActionPreflightSnapshot(context, action, {}, h.sources);
  assert.throws(() => assertEditScopesAllow(requiredEditScopesForPlan(context, plan, bindings), []), /scope/i);
  assert.deepEqual(h.operations, []);
  const outcome = await new LiveMutationQueue().run(h.controller.signal, async () => {
    assertEditScopesAllow(requiredEditScopesForPlan(context, plan, bindings), ["audio"]);
    assert.equal(await captureLiveActionPreflightSnapshot(context, action, {}, h.sources), snapshot);
    await prepareRequestAudioSampleSources(bindings, h.controller.signal);
    // Import must not invalidate the already-confirmed source identity.
    assert.equal(await captureLiveActionPreflightSnapshot(context, action, {}, h.sources), snapshot);
    return executeAgentPlanWithProgress(context, plan, {}, h.controller.signal, bindings);
  });
  assert.deepEqual(h.operations, ["import", "clip"]);
  assert.deepEqual(created, [{ filePath: "/Live Project/Samples/1.wav", startTime: 4, duration: 8 }]);
  assert.equal(outcome.mutationCount, 1);
  assert.match(outcome.results.join(" "), new RegExp(asset.id));
  assert.doesNotMatch(outcome.results.join(" "), /\/Live Project|live-smith-asset-import|untrusted|label.wav/);
});
}
