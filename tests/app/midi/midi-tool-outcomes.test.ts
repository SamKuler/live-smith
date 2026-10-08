import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { runAgentLoop } from "../../../src/agent/loop.js";
import { createMidiArtifactAuthoringToolset } from "../../../src/app/midi/midi-artifact-tools.js";
import { fillMidiContinuation } from "../../../src/app/midi/midi-continuation.js";
import { generateMidiContinuationWithModel } from "../../../src/app/midi/midi-continuation-model.js";
import { appendSessionEvent, loadSessionEvents } from "../../../src/storage/events.js";
import { listMidiArtifacts } from "../../../src/storage/midi-artifacts.js";
import { StorageCommitOutcomeUnknownError } from "../../../src/storage/persistence.js";
import { continuationHarness } from "./support/continuation-harness.js";

const authored = { label: "Melody", durationBeats: 8,
  tracks: [{ name: "Track", channel: 1, notes: [{ pitch: 60, startTime: 0, duration: 1, velocity: 100 }] }] };

for (const route of ["authoring", "continuation"] as const) for (const stopped of [false, true]) {
  test(`${route} records uncertainty after a MIDI metadata commit${stopped ? " even when stopped" : ""}`, async (t) => {
    const h = await continuationHarness(t);
    const initialCount = (await listMidiArtifacts(h.directory, h.session.id)).length;
    const unlink = fs.unlink;
    let injected = false;
    fs.unlink = async target => {
      await unlink(target);
      if (!injected && String(target).includes(".midi.json.tmp_")) {
        injected = true;
        if (stopped) h.controller.abort();
        throw Object.assign(new Error("Metadata cleanup outcome unknown"), { code: "EIO" });
      }
    };
    syncBuiltinESMExports();
    try {
      const onEvent = async (event: Parameters<typeof appendSessionEvent>[2]) => { await appendSessionEvent(h.directory, h.session.id, event); };
      let calls = 0;
      const requestTurn = async () => { calls++; return { content: null, toolCalls: [{ id: "save", name: "save_midi_artifact",
        arguments: JSON.stringify(route === "authoring" ? authored : { label: authored.label, tracks: authored.tracks }) }] }; };
      if (route === "authoring") {
        const tools = createMidiArtifactAuthoringToolset({ storageDirectory: h.directory, sessionId: h.session.id,
          signal: h.signal, runtimeProfile: h.runtime });
        const running = runAgentLoop({ maxConsecutiveFailures: 3, signal: h.signal,
          externalTools: { names: ["save_midi_artifact"], execute: async call => tools.callTool(call) }, askModel: requestTurn,
          observe: async () => "", confirmActions: async () => false,
          executeActions: async () => ({ results: [], mutationCount: 0 }), onEvent });
        if (stopped) await assert.rejects(running, { name: "AbortError" });
        else await running;
      } else {
        await assert.rejects(fillMidiContinuation({ ...h, bufferId: h.buffer.id,
          validateGenerator: async () => {}, onProgress: async () => {},
          generate: (buffer, record) => generateMidiContinuationWithModel({ storageDirectory: h.directory,
            buffer, runtimeProfile: h.runtime, signal: h.signal, requestTurn,
            readTools: { id: "reads", tools: () => [], callTool: async () => { throw new Error("No read expected"); } },
            beforeSave: async () => {}, beforeCommit: () => {}, onProgress: async () => {}, onEvent: record }),
        }), StorageCommitOutcomeUnknownError);
      }
      assert.equal(calls, 1);
      assert.equal(injected, true);
      assert.equal((await listMidiArtifacts(h.directory, h.session.id)).length, initialCount + 1);
      const results = (await loadSessionEvents(h.directory, h.session.id)).filter(event => event.kind === "tool_result");
      assert.ok(results.length > 0);
      assert.ok(results.every(event => event.outcome === "unknown"), "Both the generator and enclosing continuation retain uncertain storage evidence");
    } finally { fs.unlink = unlink; syncBuiltinESMExports(); }
  });
}

test("continuation source validation failure stays failed", async (t) => {
  const h = await continuationHarness(t);
  const original = await listMidiArtifacts(h.directory, h.sessionId);
  await assert.rejects(fillMidiContinuation({ ...h, bufferId: h.buffer.id,
    validateGenerator: async () => {}, onProgress: async () => {},
    generate: (buffer, record) => generateMidiContinuationWithModel({ storageDirectory: h.directory,
      buffer, runtimeProfile: h.runtime, signal: h.signal,
      requestTurn: async () => ({ content: null, toolCalls: [{ id: "save", name: "save_midi_artifact",
        arguments: JSON.stringify({ label: authored.label, tracks: authored.tracks }) }] }),
      readTools: { id: "reads", tools: () => [], callTool: async () => { throw new Error("No read expected"); } },
      beforeSave: async () => { throw new Error("Source changed"); }, beforeCommit: () => {},
      onProgress: async () => {}, onEvent: record }),
  }), /Source changed/);
  assert.deepEqual(await listMidiArtifacts(h.directory, h.sessionId), original);
  const results = (await loadSessionEvents(h.directory, h.sessionId)).filter(event => event.kind === "tool_result");
  assert.equal(results.length, 2);
  assert.ok(results.every(event => event.outcome === "failed"));
});
