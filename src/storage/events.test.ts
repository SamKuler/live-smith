import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  MAX_IMAGE_ATTACHMENT_BYTES,
  MAX_PENDING_SESSION_DOCUMENT_ATTACHMENT_BYTES,
  MAX_PENDING_SESSION_IMAGE_ATTACHMENT_BYTES,
  type SessionAttachmentRef,
} from "./attachments.js";

import {
  appendSessionEvent,
  deleteSessionEvents,
  loadSessionEvents,
  MAX_USER_EVENT_ATTACHMENT_BYTES,
  MAX_USER_EVENT_ATTACHMENT_COUNT,
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

const documentRef: SessionAttachmentRef = {
  id: "attachment-document",
  kind: "document",
  fileName: "reference.pdf",
  mediaType: "application/pdf",
  byteLength: 5 * 1024 * 1024,
  sha256: "b".repeat(64),
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
      attachments: Array.from({ length: MAX_USER_EVENT_ATTACHMENT_COUNT + 1 }, (_, index) => ({
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
      attachments: Array.from({ length: MAX_USER_EVENT_ATTACHMENT_COUNT }, (_, index) => ({
        ...imageRef,
        id: `attachment-large-${index}`,
        byteLength: index === 0
          ? MAX_USER_EVENT_ATTACHMENT_BYTES / MAX_USER_EVENT_ATTACHMENT_COUNT + 1
          : MAX_USER_EVENT_ATTACHMENT_BYTES / MAX_USER_EVENT_ATTACHMENT_COUNT,
      })),
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
  await assert.rejects(
    appendSessionEvent(undefined, sessionId, {
      kind: "user",
      content: "audio is not implemented",
      attachments: [{
        ...imageRef,
        kind: "audio",
        mediaType: "audio/wav",
      } as SessionAttachmentRef],
    }),
    /invalid/i,
  );
  await assert.rejects(
    appendSessionEvent(undefined, sessionId, {
      kind: "user",
      content: "unsafe filename",
      attachments: [{ ...imageRef, fileName: `../${"界".repeat(80)}.png` }],
    }),
    /invalid/i,
  );
  await assert.rejects(
    appendSessionEvent(undefined, sessionId, {
      kind: "user",
      content: "legacy normalization is not accepted for new events",
      attachments: [{ ...imageRef, fileName: "e\u0301.png" }],
    }),
    /invalid/i,
  );
  await assert.rejects(
    appendSessionEvent(undefined, sessionId, {
      kind: "user",
      content: "legacy path and controls are not accepted for new events",
      attachments: [{
        ...imageRef,
        fileName: "../e\u0301\u202E\u0001.png",
      }],
    }),
    /invalid/i,
  );
});

test("event loading precisely preserves legacy attachment refs under the old schema", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-legacy-events-"));
  const eventsDirectory = path.join(dir, "live-smith-events");
  await fs.mkdir(eventsDirectory);
  const legacyRefs: SessionAttachmentRef[] = Array.from(
    { length: 4 },
    (_, index) => ({
      ...imageRef,
      id: `attachment-legacy-${index}`,
      fileName: index === 0
        ? `../e\u0301-${"界".repeat(40)}\u202E\u0001.png`
        : `legacy-${index}.png`,
      byteLength: 4 * 1024 * 1024,
      ...(index === 2
        ? {
            kind: "document" as const,
            mediaType: "application/pdf" as const,
          }
        : index === 3
          ? { kind: "audio" as const, mediaType: "audio/wav" as const }
          : {}),
    }),
  );
  const target = path.join(eventsDirectory, "legacy-event.json");
  const persisted = [{
    id: "event-legacy",
    createdAt: "2026-01-01T00:00:00.000Z",
    kind: "user",
    content: "Legacy attachments",
    attachments: legacyRefs,
  }];
  await fs.writeFile(target, JSON.stringify(persisted));

  assert.deepEqual(await loadSessionEvents(dir, "legacy-event"), persisted);
  await appendSessionEvent(dir, "legacy-event", {
    kind: "assistant",
    content: "Legacy history remains appendable.",
  });
  assert.equal((await loadSessionEvents(dir, "legacy-event")).length, 2);
});

test("event attachment limits accept the exact count and image subtotal boundaries", async () => {
  const sessionId = `memory-event-boundary-${Date.now()}`;
  const refs = Array.from({ length: MAX_USER_EVENT_ATTACHMENT_COUNT }, (_, index) => ({
    ...imageRef,
    id: `attachment-boundary-${index}`,
    byteLength: MAX_PENDING_SESSION_IMAGE_ATTACHMENT_BYTES /
      MAX_USER_EVENT_ATTACHMENT_COUNT,
  }));
  assert.ok(refs.every((ref) => ref.byteLength <= MAX_IMAGE_ATTACHMENT_BYTES));

  const event = await appendSessionEvent(undefined, sessionId, {
    kind: "user",
    content: "exact boundary",
    attachments: refs,
  });

  assert.equal(event.attachments?.length, MAX_USER_EVENT_ATTACHMENT_COUNT);
  assert.equal(
    event.attachments?.reduce((total, attachment) => total + attachment.byteLength, 0),
    MAX_PENDING_SESSION_IMAGE_ATTACHMENT_BYTES,
  );
  await deleteSessionEvents(undefined, sessionId);
});

test("mixed image and document event refs enforce shared and per-kind quotas", async () => {
  const sessionId = `memory-event-mixed-${Date.now()}`;
  const exactMixed = [0, 1, 2].map((index) => ({
    ...imageRef,
    id: `attachment-mixed-image-${index}`,
    byteLength: MAX_IMAGE_ATTACHMENT_BYTES,
  }));
  const event = await appendSessionEvent(undefined, sessionId, {
    kind: "user",
    content: "exact mixed boundary",
    attachments: [...exactMixed, documentRef],
  });
  assert.equal(
    event.attachments?.reduce((total, attachment) => total + attachment.byteLength, 0),
    MAX_USER_EVENT_ATTACHMENT_BYTES,
  );

  await assert.rejects(
    appendSessionEvent(undefined, `${sessionId}-over`, {
      kind: "user",
      content: "one over shared boundary",
      attachments: [
        ...exactMixed,
        { ...documentRef, id: "attachment-document-over", byteLength: documentRef.byteLength + 1 },
      ],
    }),
    /invalid/i,
  );

  const exactImages = [0, 1, 2].map((index) => ({
    ...imageRef,
    id: `attachment-image-exact-${index}`,
    byteLength: MAX_IMAGE_ATTACHMENT_BYTES,
  }));
  await appendSessionEvent(undefined, `${sessionId}-image-exact`, {
    kind: "user",
    content: "exact image subtotal",
    attachments: [
      ...exactImages,
      { ...imageRef, id: "attachment-image-remainder", byteLength: 1024 * 1024 },
    ],
  });
  assert.equal(MAX_PENDING_SESSION_IMAGE_ATTACHMENT_BYTES, 16 * 1024 * 1024);
  await assert.rejects(
    appendSessionEvent(undefined, `${sessionId}-image-over`, {
      kind: "user",
      content: "one over image subtotal",
      attachments: [
        ...exactImages,
        { ...imageRef, id: "attachment-image-over", byteLength: 1024 * 1024 + 1 },
      ],
    }),
    /invalid/i,
  );

  await appendSessionEvent(undefined, `${sessionId}-document-exact`, {
    kind: "user",
    content: "exact document subtotal",
    attachments: [{
      ...documentRef,
      id: "attachment-document-exact",
      byteLength: MAX_PENDING_SESSION_DOCUMENT_ATTACHMENT_BYTES,
    }],
  });
  await assert.rejects(
    appendSessionEvent(undefined, `${sessionId}-document-over`, {
      kind: "user",
      content: "one over document subtotal",
      attachments: [{
        ...documentRef,
        id: "attachment-document-too-large",
        byteLength: MAX_PENDING_SESSION_DOCUMENT_ATTACHMENT_BYTES + 1,
      }],
    }),
    /invalid/i,
  );
});

test("document event refs survive reload and malformed kind-media pairs are corruption", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-document-events-"));
  await appendSessionEvent(dir, "session-document-event", {
    kind: "user",
    content: "Read this",
    attachments: [documentRef],
  });
  assert.deepEqual(
    (await loadSessionEvents(dir, "session-document-event"))[0]?.attachments,
    [documentRef],
  );

  const target = path.join(dir, "live-smith-events", "session-document-event.json");
  const parsed = JSON.parse(await fs.readFile(target, "utf8")) as Array<Record<string, unknown>>;
  const attachments = parsed[0]?.attachments as Array<Record<string, unknown>>;
  attachments[0]!.kind = "image";
  await fs.writeFile(target, JSON.stringify(parsed));
  await assert.rejects(
    loadSessionEvents(dir, "session-document-event"),
    (error: unknown) => error instanceof SessionEventsCorruptionError,
  );
});

test("memory event storage deep-clones nested input, append, and load values", async () => {
  const sessionId = `memory-event-clone-${Date.now()}`;
  const inputRef = { ...imageRef, id: "attachment-memory-clone" };
  const appendedUser = await appendSessionEvent(undefined, sessionId, {
    kind: "user",
    content: "clone attachment",
    attachments: [inputRef],
  });
  inputRef.fileName = "mutated-input.png";
  appendedUser.attachments![0]!.fileName = "mutated-return.png";

  const digest = "b".repeat(64);
  const recovery = { active: true, completedActionDigests: [digest] };
  const appendedRecovery = await appendSessionEvent(undefined, sessionId, {
    kind: "apply_result",
    content: "clone recovery",
    recovery,
  });
  recovery.completedActionDigests[0] = "c".repeat(64);
  appendedRecovery.recovery!.completedActionDigests[0] = "d".repeat(64);

  const firstLoad = await loadSessionEvents(undefined, sessionId);
  assert.equal(firstLoad[0]?.attachments?.[0]?.fileName, imageRef.fileName);
  assert.deepEqual(firstLoad[1]?.recovery?.completedActionDigests, [digest]);
  firstLoad[0]!.attachments![0]!.fileName = "mutated-load.png";
  firstLoad[1]!.recovery!.completedActionDigests[0] = "e".repeat(64);

  const secondLoad = await loadSessionEvents(undefined, sessionId);
  assert.equal(secondLoad[0]?.attachments?.[0]?.fileName, imageRef.fileName);
  assert.deepEqual(secondLoad[1]?.recovery?.completedActionDigests, [digest]);
  await deleteSessionEvents(undefined, sessionId);
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

test("duplicate persisted attachment IDs across events are corruption", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-events-"));
  const eventsDirectory = path.join(dir, "live-smith-events");
  await fs.mkdir(eventsDirectory);
  const target = path.join(eventsDirectory, "duplicate-attachments.json");
  const original = JSON.stringify([
    {
      id: "event-first-attachment",
      createdAt: new Date().toISOString(),
      kind: "user",
      content: "First",
      attachments: [imageRef],
    },
    {
      id: "event-second-attachment",
      createdAt: new Date().toISOString(),
      kind: "user",
      content: "Second",
      attachments: [imageRef],
    },
  ]);
  await fs.writeFile(target, original);

  await assert.rejects(
    loadSessionEvents(dir, "duplicate-attachments"),
    (error: unknown) => error instanceof SessionEventsCorruptionError,
  );
  await assert.rejects(
    appendSessionEvent(dir, "duplicate-attachments", {
      kind: "assistant",
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
