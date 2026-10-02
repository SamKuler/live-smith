import assert from "node:assert/strict";
import test from "node:test";
import { writeStandardMidi } from "../../../src/attachments/midi-writer.js";
import { saveMidiArtifact, saveMidiContinuation, readMidiContinuation } from "../../../src/storage/midi-artifacts.js";
import { midiContinuationImportHooks } from "../../../src/app/midi/midi-continuation-command.js";
import { importMidiArtifact } from "../../../src/app/midi-artifact-import.js";
import { LiveMutationQueue } from "../../../src/app/live-mutation-queue.js";
import { continuationHarness } from "./support/continuation-harness.js";
import { liveContextPresentationFixture } from "../context/support/live-context.test-harness.js";

for (const decision of ["cancel", "changed", "apply"] as const) test(`continuation import ${decision} keeps source guard and buffer consumption at the Live boundary`, async (t) => {
  const h = await continuationHarness(t);
  const artifact = await saveMidiArtifact(h.directory, h.session.id, { source: { kind: "model", profileId: h.profile.id, model: h.profile.defaultModel }, generationKind: "continuation",
    serverId: "host", toolName: "save_midi_artifact", label: "Next Bass", signal: h.signal,
    bytes: writeStandardMidi({ durationBeats: 8, tracks: [{ name: "Bass", channel: 1, notes: [{ pitch: 50, startTime: 0, duration: 4, velocity: 100 }] }] }) });
  await saveMidiContinuation(h.directory, h.session.id, { ...h.buffer, nextSequence: 1, lastArtifactRef: artifact.id,
    queue: [{ artifactRef: artifact.id, sequence: 0, label: artifact.label, noteCount: 1 }] }, h.signal);
  let writes = 0;
  Object.defineProperty(h.tracks[0], "createMidiClip", { value: async () => { writes++; return { name: "New", notes: [] }; } });
  const command = { sessionId: h.session.id, artifactRef: artifact.id, bufferId: h.buffer.id, trackId: "1", trackName: "Bass", startBeat: 8 };
  const hooks = await midiContinuationImportHooks(command, h);
  const run = () => importMidiArtifact({ kind: "import_midi_artifact", ...command, ...hooks,
    context: h.context, storageDirectory: h.directory, projectKey: h.projectKey, signal: h.signal, mutationQueue: new LiveMutationQueue(),
    interaction: { presentation: liveContextPresentationFixture("Live Set", "other"), summary: "Live Set", scope: h.session.scope, target: {} },
    confirm: async () => { if (decision === "changed") h.clips[0]!.notes[0]!.pitch = 51; return { confirmed: decision !== "cancel", source: "user" }; },
  });
  if (decision === "changed") await assert.rejects(run(), /changed/);
  else assert.equal(await run(), decision === "apply");
  assert.equal(writes, decision === "apply" ? 1 : 0);
  assert.equal((await readMidiContinuation(h.directory, h.session.id))!.queue.length, decision === "apply" ? 0 : 1);
});
