import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { configureMidiContinuation } from "../../../src/app/midi/midi-continuation.js";
import { sessionSummaries } from "../../../src/app/context/session-context.js";
import { createSession } from "../../../src/storage/sessions.js";
import { saveMidiArtifact, saveMidiContinuation } from "../../../src/storage/midi-artifacts.js";
import { createHostAbortController } from "../../../src/runtime/host.js";
import { withStorageTransaction } from "../../../src/storage/persistence.js";
import { midiPreviewFixture } from "../../live/support/action-preview.test-harness.js";
import { midiBytes, noteTrack } from "../../attachments/support/midi-test-helpers.js";

test("Session content summaries can be read inside the state snapshot transaction", async (t) => {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-midi-summary-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const session = await createSession(directory, { title: "", projectKey: "set", scope: { kind: "track", identity: "10", label: "Bass" } });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const summaries = await Promise.race([
      withStorageTransaction(directory, () => sessionSummaries(directory, [session])),
      new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error("Session summary deadlocked inside the state snapshot")), 1000); }),
    ]);
    assert.equal(summaries[0]?.hasContent, false);
  } finally { clearTimeout(timeout); }
});

for (const kind of ["configuration", "artifact", "buffer"] as const) {
  test(`first MIDI ${kind} persists its transient Session and survives startup orphan reconciliation`, async (t) => {
    const directory = await fs.mkdtemp("/private/tmp/live-smith-transient-midi-");
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const session = await createSession(directory, { title: "", projectKey: "set", scope: { kind: "track", identity: "10", label: "Bass" } }, { transient: true });
    const signal = createHostAbortController().signal;
    const h = midiPreviewFixture([{ pitch: 60, startTime: 0, duration: 1, velocity: 100 }]);
    Object.assign(h.context.application.song, { tempo: 120 });
    if (kind === "configuration") {
      await configureMidiContinuation({ context: h.context, storageDirectory: directory, sessionId: session.id, projectKey: "set", signal,
        expectedBufferId: null, sourceClips: [{ trackId: "10", clipId: "12" }], segmentBeats: 8, capacity: 2, prompt: "Continue melody",
        generator: { kind: "model", profileId: "profile", model: "test", configurationFingerprint: "a".repeat(64) } });
    } else if (kind === "artifact") {
      await saveMidiArtifact(directory, session.id, { source: { kind: "host", operation: "live-midi-context" }, serverId: "host", toolName: "capture", label: "Context", signal, bytes: midiBytes({ tracks: [noteTrack()] }) });
    } else {
      await saveMidiContinuation(directory, session.id, { id: "buffer", sessionId: session.id, sourceArtifactRef: "midi-source", sourceFingerprint: "a".repeat(64),
        sourceClips: [{ trackId: "10", clipId: "12" }], segmentBeats: 8, capacity: 2, insertBeat: 40, nextSequence: 0, consumedCount: 0, queue: [],
        generator: { kind: "model", profileId: "profile", model: "test", configurationFingerprint: "a".repeat(64) }, prompt: "Continue melody", updatedAt: new Date().toISOString() }, signal);
    }
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const child = `
      import { listSessions } from './src/storage/sessions.ts';
      import { readMidiContinuation, listMidiArtifacts } from './src/storage/midi-artifacts.ts';
      import { createSessionLifecycle } from './src/app/session/session-lifecycle.ts';
      const [directory, sessionId] = process.argv.slice(1);
      await createSessionLifecycle({ storageDirectory: directory, withSessionMutation: async (_id, _signal, operation) => operation(), notifySessionStateChanged() {} }).reconcileStartupOrphans();
      const sessions = await listSessions(directory);
      console.log(JSON.stringify({ sessions: sessions.map(s => s.id), buffer: Boolean(await readMidiContinuation(directory, sessionId)), artifacts: sessions.length ? (await listMidiArtifacts(directory, sessionId)).length : 0 }));
    `;
    const restart = JSON.parse(execFileSync(execPath, ["--import", "tsx", "--input-type=module", "-e", child, directory, session.id], { cwd: root, encoding: "utf8" }));
    assert.deepEqual(restart, { sessions: [session.id], buffer: kind !== "artifact", artifacts: kind === "buffer" ? 0 : 1 });
    assert.equal((await sessionSummaries(directory, [session]))[0]?.hasContent, true);
  });
}
