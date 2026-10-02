import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import test from "node:test";
import { writeStandardMidi } from "../../../src/attachments/midi-writer.js";
import { assertMidiContinuationSource } from "../../../src/app/midi/midi-continuation.js";
import { saveMidiArtifact, listMidiArtifacts, readMidiContinuation } from "../../../src/storage/midi-artifacts.js";
import { continuationHarness } from "./support/continuation-harness.js";

for (const interruption of ["source", "stop"] as const) test(`MIDI publication rechecks ${interruption} after blob IO and preserves existing candidates`, async (t) => {
  const h = await continuationHarness(t);
  const original = await listMidiArtifacts(h.directory, h.session.id);
  const artifactDirectory = `${h.directory}/live-smith-midi/${h.session.id}`;
  const filesBefore = await fs.readdir(artifactDirectory);
  const bytesBefore = await Promise.all(filesBefore.map((name) => fs.readFile(`${artifactDirectory}/${name}`)));
  const probe = await fs.open(`${h.directory}/probe`, "w");
  const prototype = Object.getPrototypeOf(probe) as fs.FileHandle;
  const writeFile = prototype.writeFile;
  let intercepted = false;
  prototype.writeFile = async function (data, options) {
    await writeFile.call(this, data, options);
    if (!intercepted && data instanceof Uint8Array && data[0] === 77 && data[1] === 84) {
      intercepted = true;
      if (interruption === "stop") h.controller.abort(new Error("Stopped during blob IO"));
      else h.clips[0]!.notes[0]!.pitch += 1;
    }
  };
  try {
    await assert.rejects(saveMidiArtifact(h.directory, h.session.id, {
      source: { kind: "model", profileId: "midi-profile", model: "midi-model" }, generationKind: "continuation",
      serverId: "host", toolName: "save_midi_artifact", label: "Late candidate", signal: h.signal,
      bytes: writeStandardMidi({ durationBeats: 8, tracks: [{ name: "Bass", channel: 1, notes: [{ pitch: 48, startTime: 0, duration: 2, velocity: 96 }] }] }),
      beforeCommit: () => { assertMidiContinuationSource(h.context, h.buffer, h.signal); },
    }), interruption === "stop" ? /Stopped/ : /changed/);
  } finally { prototype.writeFile = writeFile; await probe.close(); }
  assert.equal(intercepted, true);
  assert.deepEqual(await fs.readdir(artifactDirectory), filesBefore, "unpublished cancelled blobs must not consume hidden Session quota");
  assert.deepEqual(await Promise.all(filesBefore.map((name) => fs.readFile(`${artifactDirectory}/${name}`))), bytesBefore);
  assert.deepEqual(await listMidiArtifacts(h.directory, h.session.id), original);
  assert.deepEqual((await readMidiContinuation(h.directory, h.session.id))!.queue, []);
});

test("metadata IO failure retains its possibly published blob for recovery", async (t) => {
  const h = await continuationHarness(t);
  const directory = `${h.directory}/live-smith-midi/${h.session.id}`;
  const before = (await fs.readdir(directory)).filter((name) => name.endsWith(".mid"));
  const probe = await fs.open(`${h.directory}/probe`, "w");
  const prototype = Object.getPrototypeOf(probe) as fs.FileHandle;
  const writeFile = prototype.writeFile;
  let metadataAttempted = false;
  prototype.writeFile = async function (data, options) {
    await writeFile.call(this, data, options);
    if (typeof data === "string" && data.includes('"generationKind": "continuation"')) {
      metadataAttempted = true; throw new Error("Uncertain metadata IO");
    }
  };
  try {
    await assert.rejects(saveMidiArtifact(h.directory, h.session.id, { source: { kind: "model", profileId: "midi-profile", model: "midi-model" },
      generationKind: "continuation", serverId: "host", toolName: "save_midi_artifact", label: "Interrupted candidate", signal: h.signal,
      bytes: writeStandardMidi({ durationBeats: 8, tracks: [{ name: "Bass", channel: 1, notes: [{ pitch: 48, startTime: 0, duration: 2, velocity: 96 }] }] }),
    }), /Uncertain metadata IO/);
  } finally { prototype.writeFile = writeFile; await probe.close(); }
  assert.equal(metadataAttempted, true);
  assert.equal((await fs.readdir(directory)).filter((name) => name.endsWith(".mid")).length, before.length + 1);
});
