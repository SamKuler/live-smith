import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import type { SessionAttachmentRef } from "./attachments.js";

import {
  appendSessionEvent,
  deleteSessionEvents,
  loadSessionEvents,
  SessionEventsCorruptionError,
} from "./events.js";

const imageRef: SessionAttachmentRef = {
  id: "attachment-image",
  kind: "image",
  fileName: "reference.png",
  mediaType: "image/png",
  byteLength: 1024,
  sha256: "a".repeat(64),
};

test("event attachments persist strict immutable references only on user events", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-events-"));
  const event = await appendSessionEvent(dir, "session-attachments", {
    kind: "user",
    content: "Review this image",
    attachments: [imageRef],
  });

  assert.deepEqual(event.attachments, [imageRef]);
  assert.notEqual(event.attachments?.[0], imageRef);
  assert.deepEqual((await loadSessionEvents(dir, "session-attachments"))[0], event);

  await assert.rejects(
    appendSessionEvent(dir, "session-attachments", {
      kind: "assistant",
      content: "not allowed",
      attachments: [imageRef],
    }),
    /only user events/i,
  );
});

test("event attachment limits reject duplicate, oversized, and malformed refs", async () => {
  const sessionId = `memory-event-attachments-${Date.now()}`;
  await assert.rejects(
    appendSessionEvent(undefined, sessionId, {
      kind: "user",
      content: "duplicates",
      attachments: [imageRef, imageRef],
    }),
    /invalid/i,
  );
  await assert.rejects(
    appendSessionEvent(undefined, sessionId, {
      kind: "user",
      content: "too many",
      attachments: Array.from({ length: 9 }, (_, index) => ({
        ...imageRef,
        id: `attachment-${index}`,
      })),
    }),
    /invalid/i,
  );
  await assert.rejects(
    appendSessionEvent(undefined, sessionId, {
      kind: "user",
      content: "too large",
      attachments: [
        { ...imageRef, id: "attachment-a", byteLength: 11 * 1024 * 1024 },
        { ...imageRef, id: "attachment-b", byteLength: 10 * 1024 * 1024 },
      ],
    }),
    /invalid/i,
  );
  await assert.rejects(
    appendSessionEvent(undefined, sessionId, {
      kind: "user",
      content: "unknown field",
      attachments: [{ ...imageRef, path: "/secret/image.png" } as never],
    }),
    /invalid/i,
  );
  await assert.rejects(
    appendSessionEvent(undefined, sessionId, {
      kind: "user",
      content: "invalid digest",
      attachments: [{ ...imageRef, sha256: "A".repeat(64) }],
    }),
    /invalid/i,
  );
});

test("event attachment IDs cannot be consumed by multiple user events", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-events-"));
  await appendSessionEvent(dir, "session-consumption", {
    kind: "user",
    content: "first use",
    attachments: [imageRef],
  });

  await assert.rejects(
    appendSessionEvent(dir, "session-consumption", {
      kind: "user",
      content: "second use",
      attachments: [imageRef],
    }),
    /already been consumed/i,
  );
  assert.equal((await loadSessionEvents(dir, "session-consumption")).length, 1);
});

test("appendSessionEvent stores ordered user/tool_call/tool_result events", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-events-"));
  const sessionId = "session-001";

  await appendSessionEvent(dir, sessionId, {
    kind: "user",
    content: "Add a bass line",
  });
  await appendSessionEvent(dir, sessionId, {
    kind: "tool_call",
    content: "create_midi_track",
    name: "create_midi_track",
  });
  await appendSessionEvent(dir, sessionId, {
    kind: "tool_result",
    content: "Created MIDI track",
    name: "create_midi_track",
  });

  const events = await loadSessionEvents(dir, sessionId);
  assert.deepEqual(
    events.map((event) => event.kind),
    ["user", "tool_call", "tool_result"],
  );
  assert.equal(events[1]?.name, "create_midi_track");
});

test("appendSessionEvent accepts non-tool event kinds", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-events-"));
  const sessionId = "session-001";

  await appendSessionEvent(dir, sessionId, {
    kind: "assistant",
    content: "I can set that up.",
  });
  await appendSessionEvent(dir, sessionId, {
    kind: "apply_requested",
    content: "Apply 1 action?",
    name: "confirm_apply",
  });
  await appendSessionEvent(dir, sessionId, {
    kind: "apply_auto_approved",
    content: "1 change · Low Risk\nAutomatic approval. Standard safety checks completed.",
  });

  const events = await loadSessionEvents(dir, sessionId);
  assert.deepEqual(
    events.map((event) => event.kind),
    ["assistant", "apply_requested", "apply_auto_approved"],
  );
  assert.equal(events[1]?.name, "confirm_apply");
});

test("apply results persist a strict structured recovery ledger", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-events-"));
  const digest = "a".repeat(64);
  await appendSessionEvent(dir, "session-recovery", {
    kind: "apply_result",
    content: "One action completed before the host failure.",
    recovery: {
      active: true,
      completedActionDigests: [digest],
    },
  });
  await appendSessionEvent(dir, "session-recovery", {
    kind: "apply_result",
    content: "The remaining action completed.",
    recovery: {
      active: false,
      completedActionDigests: [],
    },
  });

  const events = await loadSessionEvents(dir, "session-recovery");
  assert.deepEqual(events.map((event) => event.recovery), [
    { active: true, completedActionDigests: [digest] },
    { active: false, completedActionDigests: [] },
  ]);
});

test("malformed recovery ledgers are rejected as event-log corruption", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-events-"));
  const eventsDirectory = path.join(dir, "live-smith-events");
  await fs.mkdir(eventsDirectory);
  const target = path.join(eventsDirectory, "bad-recovery.json");
  await fs.writeFile(target, JSON.stringify([{
    id: "event-bad-recovery",
    createdAt: new Date().toISOString(),
    kind: "apply_result",
    content: "Do not trust raw action identity data.",
    recovery: {
      active: true,
      completedActionDigests: ['insert_device:{"apiKey":"secret"}'],
    },
  }]));

  await assert.rejects(
    loadSessionEvents(dir, "bad-recovery"),
    (error: unknown) => error instanceof SessionEventsCorruptionError,
  );
});

test("concurrent appendSessionEvent calls preserve every event", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-events-"));
  const sessionId = "concurrent-session";
  const contents = Array.from({ length: 32 }, (_, index) => `event-${index}`);

  await Promise.all(
    contents.map((content) =>
      appendSessionEvent(dir, sessionId, { kind: "assistant", content }),
    ),
  );

  const events = await loadSessionEvents(dir, sessionId);
  assert.equal(events.length, contents.length);
  assert.deepEqual(
    events.map((event) => event.content).sort(),
    contents.sort(),
  );
});

test("loadSessionEvents tolerates missing files", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-events-"));

  const events = await loadSessionEvents(dir, "missing-session");

  assert.deepEqual(events, []);
});

test("corrupt event storage blocks reads and appends without changing bytes", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-events-"));
  const eventsDirectory = path.join(dir, "live-smith-events");
  await fs.mkdir(eventsDirectory);
  const target = path.join(eventsDirectory, "corrupt-session.json");
  const original = "{invalid";
  await fs.writeFile(target, original);

  await assert.rejects(
    loadSessionEvents(dir, "corrupt-session"),
    (error: unknown) => error instanceof SessionEventsCorruptionError,
  );
  await assert.rejects(
    appendSessionEvent(dir, "corrupt-session", {
      kind: "user",
      content: "Must not overwrite",
    }),
    (error: unknown) => error instanceof SessionEventsCorruptionError,
  );
  assert.equal(await fs.readFile(target, "utf8"), original);
});

test("unsafe session IDs cannot escape the event directory", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-events-"));
  const settingsPath = path.join(dir, "live-smith-settings.json");
  const original = "settings sentinel";
  await fs.writeFile(settingsPath, original);

  await assert.rejects(
    appendSessionEvent(dir, "../live-smith-settings", {
      kind: "user",
      content: "Do not overwrite settings",
    }),
    /Session ID is invalid/,
  );
  await assert.rejects(
    deleteSessionEvents(dir, "../live-smith-settings"),
    /Session ID is invalid/,
  );
  assert.equal(await fs.readFile(settingsPath, "utf8"), original);
});

test("one invalid persisted event blocks append instead of dropping the item", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-events-"));
  const eventsDirectory = path.join(dir, "live-smith-events");
  await fs.mkdir(eventsDirectory);
  const target = path.join(eventsDirectory, "partial-session.json");
  const original = JSON.stringify([{
    id: "event-valid",
    createdAt: new Date().toISOString(),
    kind: "user",
    content: "Recoverable",
  }, { id: "event-invalid" }]);
  await fs.writeFile(target, original);

  await assert.rejects(
    appendSessionEvent(dir, "partial-session", {
      kind: "assistant",
      content: "Must not overwrite",
    }),
    (error: unknown) => error instanceof SessionEventsCorruptionError,
  );
  assert.equal(await fs.readFile(target, "utf8"), original);
});

test("duplicate persisted event IDs block reads and appends without changing bytes", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-events-"));
  const eventsDirectory = path.join(dir, "live-smith-events");
  await fs.mkdir(eventsDirectory);
  const target = path.join(eventsDirectory, "duplicate-session.json");
  const original = JSON.stringify([
    {
      id: "event-duplicate",
      createdAt: new Date().toISOString(),
      kind: "user",
      content: "First",
    },
    {
      id: "event-duplicate",
      createdAt: new Date().toISOString(),
      kind: "assistant",
      content: "Second",
    },
  ]);
  await fs.writeFile(target, original);

  await assert.rejects(
    loadSessionEvents(dir, "duplicate-session"),
    (error: unknown) => error instanceof SessionEventsCorruptionError,
  );
  await assert.rejects(
    appendSessionEvent(dir, "duplicate-session", {
      kind: "user",
      content: "Must not overwrite",
    }),
    (error: unknown) => error instanceof SessionEventsCorruptionError,
  );
  assert.equal(await fs.readFile(target, "utf8"), original);
});

test("session event storage keeps an in-memory fallback when storage directory is missing", async () => {
  const sessionId = `memory-${Date.now()}`;
  await appendSessionEvent(undefined, sessionId, {
    kind: "error",
    content: "No storage available",
  });

  assert.deepEqual(
    (await loadSessionEvents(undefined, sessionId)).map((event) => event.kind),
    ["error"],
  );
  await deleteSessionEvents(undefined, sessionId);
  assert.deepEqual(await loadSessionEvents(undefined, sessionId), []);
});

test("deleteSessionEvents removes a session event log", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-events-"));
  await appendSessionEvent(dir, "session-001", {
    kind: "user",
    content: "Delete me",
  });

  await deleteSessionEvents(dir, "session-001");

  assert.deepEqual(await loadSessionEvents(dir, "session-001"), []);
});
