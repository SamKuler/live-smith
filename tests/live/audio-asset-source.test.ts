import assert from "node:assert/strict";
import test from "node:test";
import { AudioTrack } from "@ableton-extensions/sdk";

import { validateAgentPlan } from "../../src/agent/actions.js";
import { bindAgentPlanTargets, assertSameExistingPlanTargets } from "../../src/live/action-bindings.js";
import { requiredEditScopesForPlan } from "../../src/live/action-permissions.js";
import { captureLiveActionPreflightSnapshot } from "../../src/live/preflight.js";
import { resolveSampleSource, type AudioAssetSampleSource, type ManagedSampleSource } from "../../src/live/sample-source.js";

test("asset resolution requires the exact send registry entry and matching source ownership", () => {
  const asset = managedAsset();
  const sources = new Map<string, ManagedSampleSource>([[asset.assetRef, asset]]);
  const locator = { kind: "audio_asset" as const, assetRef: asset.assetRef };
  assert.equal(resolveSampleSource({} as never, locator, {}, sources), asset);
  for (const registry of [undefined, new Map<string, ManagedSampleSource>()]) {
    assert.throws(() => resolveSampleSource({} as never, locator, {}, registry), /not available/);
  }
  for (const assetRef of ["unknown", "/private/sample.wav", "../asset", "event:0"]) {
    assert.throws(() => resolveSampleSource({} as never, { kind: "audio_asset", assetRef }, {}, sources), /not available/);
  }
  sources.set("other-ref", asset);
  assert.throws(() => resolveSampleSource({} as never, { kind: "audio_asset", assetRef: "other-ref" }, {}, sources), /not available/);
  sources.set("event:0", asset);
  assert.throws(() => resolveSampleSource({} as never, {
    kind: "request_audio_attachment", requestId: "event", audioIndex: 0,
  }, {}, sources), /not available/);
  sources.set(asset.assetRef, {
    kind: "request_audio_attachment", requestId: "event", audioIndex: 0,
    identity: "attachment", label: "Attachment", filePath: "unread", prepare: async () => false,
  });
  assert.throws(() => resolveSampleSource({} as never, locator, {}, sources), /not available/);
});

test("asset binding and preflight remain read-only and preserve audio scope and drift guards", async () => {
  const asset = managedAsset();
  const sources = new Map<string, ManagedSampleSource>([[asset.assetRef, asset]]);
  const track = Object.create(AudioTrack.prototype);
  for (const [key, value] of Object.entries({
    handle: { id: "track-a" }, name: "Audio", arrangementClips: [], devices: [], clipSlots: [],
  })) Object.defineProperty(track, key, { configurable: true, value });
  const context = { application: { song: { handle: { id: "song" }, tracks: [track] } } } as never;
  const action = {
    type: "create_arrangement_audio_clip" as const, trackName: "Audio", startBeat: 0,
    source: { kind: "audio_asset" as const, assetRef: asset.assetRef },
  };
  const plan = validateAgentPlan({ message: "Import stem", actions: [action] });
  const before = bindAgentPlanTargets(context, plan, {}, sources);
  assert.equal(before.actionObjects.get(0)?.sampleSource, asset);
  assert.deepEqual(requiredEditScopesForPlan(context, plan, before), ["audio"]);
  const snapshot = await captureLiveActionPreflightSnapshot(context, action, {}, sources);
  assert.equal(await captureLiveActionPreflightSnapshot(context, action, {}, sources), snapshot);
  sources.set(asset.assetRef, managedAsset("changed-hash"));
  const after = bindAgentPlanTargets(context, plan, {}, sources);
  assert.notEqual(await captureLiveActionPreflightSnapshot(context, action, {}, sources), snapshot);
  assert.throws(() => assertSameExistingPlanTargets(before, after), /changed/);
});

function managedAsset(hash = "hash"): AudioAssetSampleSource {
  return {
    kind: "audio_asset", assetRef: "asset-host-minted", label: "Vocals",
    identity: `audio-asset:asset-host-minted:${hash}`,
    get filePath(): string { throw new Error("Preflight must not access the unprepared managed path"); },
    async prepare() { throw new Error("Preflight must not import audio"); },
  };
}
