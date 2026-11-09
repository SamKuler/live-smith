import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { sessionSummaries } from "../../../src/app/context/session-context.js";
import { createSession } from "../../../src/storage/sessions.js";
import { saveMidiArtifact } from "../../../src/storage/midi-artifacts.js";
import { createHostAbortController } from "../../../src/runtime/host.js";
import { withStorageTransaction } from "../../../src/storage/persistence.js";
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

for (const kind of ["artifact", "legacy buffer"] as const) {
  test(`a Session with only a MIDI ${kind} survives startup orphan reconciliation`, async (t) => {
    const directory = await fs.mkdtemp("/private/tmp/live-smith-transient-midi-");
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const session = await createSession(kind === "legacy buffer" ? undefined : directory, {
      title: "", projectKey: "set", scope: { kind: "track", identity: "10", label: "Bass" },
    }, { transient: kind === "artifact" });
    const artifactDirectory = path.join(directory, "live-smith-midi", session.id);
    const legacyFile = path.join(artifactDirectory, "continuation.json");
    const legacyData = JSON.stringify({
      id: "buffer", sessionId: session.id, sourceArtifactRef: "midi-source", sourceFingerprint: "a".repeat(64),
      sourceClips: [{ trackId: "10", clipId: "12" }], segmentBeats: 8, capacity: 2, insertBeat: 40, nextSequence: 0,
      consumedCount: 0, queue: [], prompt: "Continue melody", updatedAt: "2026-10-03T00:00:00Z",
      generator: { kind: "model", profileId: "profile", model: "test", configurationFingerprint: "a".repeat(64) },
    });
    if (kind === "artifact") {
      await saveMidiArtifact(directory, session.id, {
        source: { kind: "model", profileId: "profile", model: "test" }, serverId: "host",
        toolName: "save_midi_artifact", label: "Melody", signal: createHostAbortController().signal,
        bytes: midiBytes({ tracks: [noteTrack()] }),
      });
    } else {
      await fs.writeFile(path.join(directory, "live-smith-sessions.json"), JSON.stringify([session]));
      await fs.mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
      await fs.writeFile(legacyFile, legacyData, { mode: 0o600 });
    }
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const child = `
      import { listSessions } from './src/storage/sessions.ts';
      import { listMidiArtifacts } from './src/storage/midi-artifacts.ts';
      import { createSessionLifecycle } from './src/app/session/session-lifecycle.ts';
      import { sessionSummaries } from './src/app/context/session-context.ts';
      const [directory, sessionId] = process.argv.slice(1);
      await createSessionLifecycle({ storageDirectory: directory, withSessionMutation: async (_id, _signal, operation) => operation(), notifySessionStateChanged() {} }).reconcileStartupOrphans();
      const sessions = await listSessions(directory);
      const summaries = await sessionSummaries(directory, sessions);
      console.log(JSON.stringify({ sessions: sessions.map(s => s.id), hasContent: summaries[0]?.hasContent, artifacts: sessions.length ? (await listMidiArtifacts(directory, sessionId)).map(artifact => artifact.label) : [] }));
    `;
    const restart = JSON.parse(execFileSync(execPath, ["--import", "tsx", "--input-type=module", "-e", child, directory, session.id], { cwd: root, encoding: "utf8" }));
    assert.deepEqual(restart, { sessions: [session.id], hasContent: true, artifacts: kind === "artifact" ? ["Melody"] : [] });
    if (kind === "legacy buffer") assert.equal(await fs.readFile(legacyFile, "utf8"), legacyData);
  });
}
