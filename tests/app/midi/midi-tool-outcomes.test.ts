import { interceptStoredWrites } from "../../storage/support/sqlite-fault-test-helpers.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { runAgentLoop } from "../../../src/agent/loop.js";
import { createMidiArtifactAuthoringToolset } from "../../../src/app/midi/midi-artifact-tools.js";
import { createHostAbortController } from "../../../src/runtime/host.js";
import { appendSessionEvent, loadSessionEvents } from "../../../src/storage/events.js";
import { listMidiArtifacts } from "../../../src/storage/midi-artifacts.js";
import { createSession } from "../../../src/storage/sessions.js";

const authored = { label: "Melody", durationBeats: 8,
  tracks: [{ name: "Track", channel: 1, notes: [{ pitch: 60, startTime: 0, duration: 1, velocity: 100 }] }] };

for (const stopped of [false, true]) {
  test(`authoring records uncertainty after a MIDI metadata commit${stopped ? " even when stopped" : ""}`, async (t) => {
    const directory = await fs.mkdtemp("/private/tmp/live-smith-midi-outcome-");
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const session = await createSession(directory, { title: "MIDI authoring", projectKey: "set",
      scope: { kind: "track", identity: "10", label: "Bass" } });
    const controller = createHostAbortController();
    const { signal } = controller;
    let injected = false;
    const restore = interceptStoredWrites(t, { afterCommit: writes => {
      if (!injected && writes.some(write => write.key.endsWith(".midi.json"))) {
        injected = true;
        if (stopped) controller.abort();
        throw Object.assign(new Error("Metadata commit outcome unknown"), { code: "EIO" });
      }
    } });
    try {
      const onEvent = async (event: Parameters<typeof appendSessionEvent>[2]) => {
        await appendSessionEvent(directory, session.id, event);
      };
      let calls = 0;
      const requestTurn = async () => {
        calls++;
        return { content: null, toolCalls: [{ id: "save", name: "save_midi_artifact", arguments: JSON.stringify(authored) }] };
      };
      const tools = createMidiArtifactAuthoringToolset({ storageDirectory: directory, sessionId: session.id,
        signal, actor: { kind: "model", profileId: "profile", model: "test" } });
      const running = runAgentLoop({ maxConsecutiveFailures: 3, signal,
        externalTools: { names: ["save_midi_artifact"], execute: async call => tools.callTool(call) }, askModel: requestTurn,
        observe: async () => "", confirmActions: async () => false,
        executeActions: async () => ({ results: [], mutationCount: 0 }), onEvent });
      if (stopped) await assert.rejects(running, { name: "AbortError" });
      else await running;
      assert.equal(calls, 1);
      assert.equal(injected, true);
      assert.equal((await listMidiArtifacts(directory, session.id)).length, 1);
      const results = (await loadSessionEvents(directory, session.id)).filter(event => event.kind === "tool_result");
      assert.deepEqual(results.map(event => event.outcome), ["unknown"]);
    } finally { restore(); }
  });
}
