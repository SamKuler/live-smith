import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { appendSessionEvent, loadSessionEvents, type SessionEventInput } from "../../src/storage/events.js";
import type { MidiActionPreview } from "../../src/agent/action-preview.js";
import type { AgentPlan } from "../../src/agent/actions.js";

const makePreview = (): MidiActionPreview => ({ kind: "midi-notes", actionIndex: 0, status: "proposed", targetLabel: "Piano", range: { coordinate: "clip-beats", start: 0, end: 4 }, before: { notes: [], totalNoteCount: 0, omittedNoteCount: 0 }, after: { notes: [{ pitch: 60, startTime: 0, duration: 4, velocity: 96 }], totalNoteCount: 1, omittedNoteCount: 0 } });
const makePlan = (): AgentPlan => ({ message: "Create notes", targets: { piano: { trackName: "Piano" } }, actions: [
  { type: "set_tempo", tempo: 125 },
  { type: "create_midi_clip", trackRef: "piano", startBeat: 0, durationBeats: 4,
    notes: Array.from({ length: 604 }, (_, index) => ({ pitch: 48 + index % 24, startTime: index / 604 * 3, duration: 0.125, velocity: 96 })) },
] });

for (const persisted of [false, true]) test(`full ordered plans survive ${persisted ? "disk reload" : "memory snapshot"} and caller mutations`, async (t) => {
  const directory = persisted ? await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-apply-plan-")) : undefined;
  if (directory) t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const plan = makePlan();
  const saved = await appendSessionEvent(directory, "session-plan", { kind: "apply_requested", content: "Create notes",
    applyOperation: { id: "apply-plan", status: "proposed", plan } });
  plan.actions.reverse();
  saved.applyOperation!.plan!.actions.reverse();
  const events = await loadSessionEvents(directory, "session-plan");
  assert.deepEqual(events[0]?.applyOperation?.plan, makePlan());
});

test("proposal snapshots and outcome correlation survive disk reload", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-apply-history-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const preview = makePreview();
  await appendSessionEvent(directory, "session-history", { kind: "apply_requested", content: "Create notes", applyOperation: { id: "apply-history", status: "proposed", previews: [preview] } });
  await appendSessionEvent(directory, "session-history", { kind: "apply_result", content: "Applied", applyOperation: { id: "apply-history", status: "applied" } });
  await appendSessionEvent(directory, "session-history", { kind: "apply_result", content: "Legacy history without structured outcome" });
  preview.after.notes[0]!.pitch = 12;
  const events = await loadSessionEvents(directory, "session-history");
  assert.equal(events[0]?.applyOperation?.previews?.[0]?.status, "proposed");
  assert.deepEqual(events[0]?.applyOperation?.previews, [makePreview()]);
  assert.equal(events[1]?.applyOperation?.status, "applied");
  assert.equal(events[2]?.applyOperation, undefined);
});

test("memory event snapshots remain independent of caller mutations", async () => {
  const preview = makePreview();
  const event = await appendSessionEvent(undefined, "session-history-clone", { kind: "apply_requested", content: "Proposed", applyOperation: { id: "apply-clone", status: "proposed", previews: [preview] } });
  preview.after.notes[0]!.pitch = 2;
  (event.applyOperation!.previews![0] as MidiActionPreview).after.notes[0]!.pitch = 3;
  assert.deepEqual((await loadSessionEvents(undefined, "session-history-clone"))[0]?.applyOperation?.previews, [makePreview()]);
});

for (const shown of [604, 256]) {
  test(`${shown === 604 ? "complete" : "older truncated"} large MIDI previews survive disk reload`, async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-midi-preview-history-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const preview = makePreview();
    preview.after = {
      notes: Array.from({ length: shown }, (_, index) => ({ pitch: 48 + index % 24, startTime: index / 604 * 3, duration: 0.125, velocity: 96 })),
      totalNoteCount: 604, omittedNoteCount: 604 - shown,
    };
    await appendSessionEvent(directory, "session-history", {
      kind: "apply_requested", content: "Proposed notes",
      applyOperation: { id: "apply-full-preview", status: "proposed", previews: [preview] },
    });
    const saved = await loadSessionEvents(directory, "session-history");
    assert.deepEqual(saved[0]?.applyOperation?.previews, [preview]);
  });
}

test("storage rejects invalid outcome claims and malformed previews", async () => {
  const invalid = [
    { kind: "apply_result", applyOperation: { id: "apply-1", status: ["applied"] } },
    { kind: "assistant", applyOperation: { id: "apply-1", status: "applied" } },
    { kind: "apply_requested", applyOperation: { id: "apply-1", status: "applied" } },
    { kind: "apply_result", applyOperation: { id: "apply-1", status: "proposed" } },
    { kind: "apply_result", applyOperation: { id: "apply-1", status: "applied", previews: [makePreview()] } },
    { kind: "apply_requested", applyOperation: { id: "apply-1", status: "proposed", previews: [{ ...makePreview(), status: "applied" }] } },
    { kind: "apply_requested", applyOperation: { id: "../unsafe", status: "proposed" } },
    { kind: "apply_requested", applyOperation: { id: "apply-1", status: "proposed", previews: [{ ...makePreview(), after: { notes: [], totalNoteCount: 1, omittedNoteCount: 0 } }] } },
    { kind: "apply_requested", applyOperation: { id: "apply-1", status: "proposed", plan: { message: "Invalid", actions: [] } } },
    { kind: "apply_requested", applyOperation: { id: "apply-1", status: "proposed", plan: { message: "Invalid", actions: [{ type: "set_tempo", tempo: "125" }] } } },
    { kind: "apply_result", applyOperation: { id: "apply-1", status: "applied", plan: makePlan() } },
  ];
  for (const input of invalid) {
    await assert.rejects(appendSessionEvent(undefined, "session-invalid-history", { content: "Summary", ...input } as SessionEventInput), /invalid/);
  }
});

test("only tool results retain unique bounded saved artifact references", async () => {
  const artifacts = [{ kind: "midi" as const, id: "artifact-1" }, { kind: "audio" as const, id: "asset-1" }];
  const event = await appendSessionEvent(undefined, "session-artifact-result", { kind: "tool_result", name: "generate", content: "Saved outputs", artifacts });
  artifacts[0]!.id = "changed";
  assert.deepEqual(event.artifacts, [{ kind: "midi", id: "artifact-1" }, { kind: "audio", id: "asset-1" }]);
  for (const invalid of [[], [event.artifacts![0], event.artifacts![0]], Array.from({ length: 25 }, (_, i) => ({ kind: "audio", id: `asset-${i}` }))]) {
    await assert.rejects(appendSessionEvent(undefined, "session-artifact-result", { kind: "tool_result", content: "Saved outputs", artifacts: invalid } as SessionEventInput), /invalid/);
  }
  await assert.rejects(appendSessionEvent(undefined, "session-artifact-result", { kind: "assistant", content: "Saved outputs", artifacts: event.artifacts }), /invalid/);
});


test("proposal artifact references survive reload and are rejected on terminal outcomes", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-artifact-history-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const artifacts = [{ kind: "midi" as const, id: "midi-version" }];
  await appendSessionEvent(directory, "session-history", { kind: "apply_requested", content: "Import", applyOperation: { id: "import", status: "proposed", artifacts } });
  artifacts[0]!.id = "changed";
  assert.deepEqual((await loadSessionEvents(directory, "session-history"))[0]!.applyOperation!.artifacts, [{ kind: "midi", id: "midi-version" }]);
  await assert.rejects(appendSessionEvent(directory, "session-history", { kind: "apply_result", content: "Result", applyOperation: { id: "import", status: "applied", artifacts } }), /invalid/);
});
