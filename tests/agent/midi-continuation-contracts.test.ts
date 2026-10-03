import assert from "node:assert/strict";
import test from "node:test";
import { isMidiContinuationBuffer, type MidiContinuationBuffer } from "../../src/agent/midi-continuation-contracts.js";

test("continuation contracts preserve ordered future sections and enforce real capacity", () => {
  const buffer: MidiContinuationBuffer = { id: "buffer", sessionId: "session", sourceArtifactRef: "source", sourceFingerprint: "a".repeat(64),
    sourceClips: [{ trackId: String((1n << 151n) + 1n), clipId: String((1n << 151n) + 2n) }], segmentBeats: 16, capacity: 2, insertBeat: 32,
    nextSequence: 3, consumedCount: 1, lastArtifactRef: "second",
    queue: [{ artifactRef: "first", sequence: 1, label: "Section 2", noteCount: 32 }, { artifactRef: "second", sequence: 2, label: "Section 3", noteCount: 40 }],
    generator: { kind: "model", profileId: "profile", model: "model", configurationFingerprint: "b".repeat(64) }, prompt: "", updatedAt: new Date().toISOString() };
  assert.equal(isMidiContinuationBuffer(buffer), true);
  assert.equal(isMidiContinuationBuffer({ ...buffer, insertBeat: -16 }), true, "a moved queue head may have a negative sequence origin");
  assert.equal(isMidiContinuationBuffer({ ...buffer, insertBeat: -17 }), false, "the current head still requires a nonnegative Live position");
  assert.equal(isMidiContinuationBuffer({ ...buffer, capacity: 1 }), false);
  assert.equal(isMidiContinuationBuffer({ ...buffer, capacity: 5 }), false);
  assert.equal(isMidiContinuationBuffer({ ...buffer, queue: [...buffer.queue].reverse() }), false);
  assert.equal(isMidiContinuationBuffer({ ...buffer, segmentBeats: 0 }), false);
  assert.equal(isMidiContinuationBuffer({ ...buffer, sourceClips: [...buffer.sourceClips, ...buffer.sourceClips] }), false);
  assert.equal(isMidiContinuationBuffer({ ...buffer, consumedCount: 0 }), false);
  assert.equal(isMidiContinuationBuffer({ ...buffer, generator: { kind: "plugin", toolName: "mcp_generator", signature: "sig", inputArgument: "source", lengthArgument: "beats", arguments: { style: "calm" } } }), true);
});
