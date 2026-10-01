import assert from "node:assert/strict";
import test from "node:test";

import { agentActionJsonSchemas } from "../../src/agent/action-schema.js";
import { summarizeActionPlan, validateAgentPlan } from "../../src/agent/actions.js";

const sampleActions = [
  { type: "replace_simpler_sample", trackName: "Audio", simplerName: "Simpler" },
  { type: "configure_drum_pad", trackName: "Audio", rackName: "Drum Rack", receivingNote: 36, mode: "fill_empty_pad" },
  { type: "create_arrangement_audio_clip", trackName: "Audio", startBeat: 0 },
  { type: "create_session_audio_clip", trackName: "Audio", slotIndex: 0 },
];

test("every sample action accepts and describes an exact audio asset reference", () => {
  for (const action of sampleActions) {
    const source = { kind: "audio_asset", assetRef: "asset-host-minted" };
    const plan = validateAgentPlan({ message: "Import persisted stem", actions: [{ ...action, source }] });
    assert.deepEqual((plan.actions[0] as { source: unknown }).source, source);
    assert.match(summarizeActionPlan(plan), /audio asset "asset-host-minted"/);
    const schema = agentActionJsonSchemas().find((candidate) =>
      (candidate.properties as { type: { enum: string[] } }).type.enum[0] === action.type
    );
    const variants = (schema?.properties as {
      source: { oneOf: Array<{ properties: { kind: { enum: string[] } }; required: string[]; additionalProperties: boolean }> };
    }).source.oneOf;
    const assetSchema = variants.find((variant) => variant.properties.kind.enum[0] === "audio_asset");
    assert.deepEqual(assetSchema?.required, ["kind", "assetRef"]);
    assert.deepEqual(Object.keys(assetSchema?.properties ?? {}).sort(), ["assetRef", "kind"]);
    assert.equal(assetSchema?.additionalProperties, false);
  }
});

test("asset source parsing rejects missing references and caller-owned import details", () => {
  for (const source of [
    { kind: "audio_asset" },
    { kind: "audio_asset", assetRef: "" },
    { kind: "audio_asset", assetRef: " asset-id " },
    { kind: "audio_asset", assetRef: 12 },
    { kind: "audio_asset", assetRef: "asset-id", filePath: "/private/sample.wav" },
    { kind: "audio_asset", assetRef: "asset-id", sessionId: "foreign-session" },
    { kind: "audio_asset", assetRef: "asset-id", sha256: "model-chosen" },
    { kind: "audio_asset", assetRef: "asset-id", url: "https://example.com/sample.wav" },
  ]) {
    assert.throws(() => validateAgentPlan({
      message: "Invalid source", actions: [{ ...sampleActions[0], source }],
    }), /source/);
  }
});
