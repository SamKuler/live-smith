import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendSessionEvent, loadSessionEvents, type SessionEventInput } from "../../src/storage/events.js";
import { chatSessionEvent } from "../../src/ui/chat-state.js";

test("tool outcomes persist and project without guessing provider result prose", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tool-outcomes-"));
  try {
    for (const outcome of ["success", "failed", "unknown", "stopped"] as const) {
      await appendSessionEvent(directory, "session-outcome", { kind: "tool_result", name: "external", content: "Provider text", outcome });
    }
    await appendSessionEvent(directory, "session-outcome", { kind: "tool_result", name: "external", content: "Historical record" });
    const events = await loadSessionEvents(directory, "session-outcome");
    assert.deepEqual(events.map(event => event.outcome), ["success", "failed", "unknown", "stopped", undefined]);
    for (const event of events) {
      const projected = chatSessionEvent(event);
      assert.equal(projected.outcome, event.outcome);
    }
    for (const input of [
      { kind: "assistant", content: "Text", outcome: "success" },
      { kind: "tool_result", content: "Text", outcome: "made-up" },
    ]) await assert.rejects(appendSessionEvent(directory, "session-outcome", input as SessionEventInput));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
