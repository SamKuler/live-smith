import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
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
    const unlink = fs.unlink;
    let injected = false;
    fs.unlink = async target => {
      await unlink(target);
      if (!injected && String(target).includes(".midi.json.tmp_")) {
        injected = true;
        if (stopped) controller.abort();
        throw Object.assign(new Error("Metadata cleanup outcome unknown"), { code: "EIO" });
      }
    };
    syncBuiltinESMExports();
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
    } finally { fs.unlink = unlink; syncBuiltinESMExports(); }
  });
}
