import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  MAX_AUDIO_ATTACHMENT_BYTES,
  MAX_IMAGE_ATTACHMENT_BYTES,
  MAX_PENDING_AUDIO_ATTACHMENT_BYTES,
  MAX_PENDING_AUDIO_ATTACHMENT_COUNT,
  MAX_PENDING_DOCUMENT_ATTACHMENT_BYTES,
  MAX_PENDING_IMAGE_ATTACHMENT_BYTES,
} from "../attachments/contracts.js";
import {
  LEGACY_MAX_RECOVERY_ACTION_DIGESTS,
  MAX_RECOVERY_ACTION_DIGESTS,
} from "../agent/recovery-contract.js";
import type { SessionAttachmentRef } from "./attachments.js";

import {
  appendSessionEvent,
  deleteSessionEvents,
  loadSessionEvents,
  MAX_USER_EVENT_ATTACHMENT_BYTES,
  MAX_USER_EVENT_ATTACHMENT_COUNT,
  SessionSteeringReceiptConflictError,
  SessionEventsCorruptionError,
  type SessionSteeringReceipt,
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
  byteLength: 15 * 1024 * 1024,
  sha256: "b".repeat(64),
};

const audioRef: SessionAttachmentRef = {
  id: "attachment-audio",
  kind: "audio",
  fileName: "reference.wav",
  mediaType: "audio/wav",
  byteLength: 10 * 1024 * 1024,
  sha256: "c".repeat(64),
  durationSeconds: 120,
  sampleRate: 48_000,
  channels: 2,
};

function steeringReceipt(
  sendId: string,
  id: string,
  content: string,
): SessionSteeringReceipt {
  return {
    sendId,
    id,
    sha256: createHash("sha256").update(content, "utf8").digest("hex"),
  };
}

test("steering receipts make identical user-event appends idempotent", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-event-receipt-"));
  const sessionId = "session-steering-idempotent";
  const content = "Keep the drums dry and move the bass down one octave.";
  const expectedReceipt = steeringReceipt("send-steering-1", "steer-1", content);
  const inputReceipt = { ...expectedReceipt };

  const first = await appendSessionEvent(dir, sessionId, {
    kind: "user",
    content,
    steeringReceipt: inputReceipt,
  });
  const target = path.join(
    dir,
    "live-smith-events",
    `${encodeURIComponent(sessionId)}.json`,
  );
  const bytesAfterFirstAppend = await fs.readFile(target);
  inputReceipt.id = "mutated-input";
  first.steeringReceipt!.id = "mutated-return";

  const retried = await appendSessionEvent(dir, sessionId, {
    kind: "user",
    content,
    steeringReceipt: { ...expectedReceipt },
  });

  assert.equal(retried.id, first.id);
  assert.equal(retried.createdAt, first.createdAt);
  assert.deepEqual(retried.steeringReceipt, expectedReceipt);
  assert.deepEqual(await fs.readFile(target), bytesAfterFirstAppend);
  assert.deepEqual(await loadSessionEvents(dir, sessionId), [{
    id: first.id,
    createdAt: first.createdAt,
    kind: "user",
    content,
    steeringReceipt: expectedReceipt,
  }]);
});

test("a steering receipt cannot be reused for different user guidance", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-event-receipt-"));
  const sessionId = "session-steering-conflict";
  const firstContent = "Keep the first arrangement.";
  const secondContent = "Replace the first arrangement.";
  const receiptIdentity = {
    sendId: "send-steering-conflict",
    id: "steer-conflict",
  };
  await appendSessionEvent(dir, sessionId, {
    kind: "user",
    content: firstContent,
    steeringReceipt: steeringReceipt(
      receiptIdentity.sendId,
      receiptIdentity.id,
      firstContent,
    ),
  });
  const target = path.join(dir, "live-smith-events", `${sessionId}.json`);
  const original = await fs.readFile(target);

  await assert.rejects(
    appendSessionEvent(dir, sessionId, {
      kind: "user",
      content: secondContent,
      steeringReceipt: steeringReceipt(
        receiptIdentity.sendId,
        receiptIdentity.id,
        secondContent,
      ),
    }),
    (error: unknown) =>
      error instanceof SessionSteeringReceiptConflictError &&
      error.sendId === receiptIdentity.sendId &&
      error.id === receiptIdentity.id,
  );
  assert.deepEqual(await fs.readFile(target), original);
  assert.equal((await loadSessionEvents(dir, sessionId)).length, 1);
});

test("new steering receipts require strict IDs, hashes, event shape, and content binding", async () => {
  const sessionId = `memory-steering-receipt-validation-${Date.now()}`;
  const content = "Use the selected track instead.";
  const valid = steeringReceipt("send-valid", "steer-valid", content);
  const inputs = [
    {
      kind: "assistant" as const,
      content,
      steeringReceipt: valid,
    },
    {
      kind: "user" as const,
      content,
      name: "steering",
      steeringReceipt: valid,
    },
    {
      kind: "user" as const,
      content,
      attachments: [imageRef],
      steeringReceipt: valid,
    },
    {
      kind: "user" as const,
      content,
      steeringReceipt: { ...valid, sendId: "unsafe/send" },
    },
    {
      kind: "user" as const,
      content,
      steeringReceipt: { ...valid, id: ".unsafe" },
    },
    {
      kind: "user" as const,
      content,
      steeringReceipt: { ...valid, sha256: valid.sha256.toUpperCase() },
    },
    {
      kind: "user" as const,
      content: `${content} changed`,
      steeringReceipt: valid,
    },
    {
      kind: "user" as const,
      content,
      steeringReceipt: { ...valid, extra: "not allowed" },
    },
  ];

  for (const [index, input] of inputs.entries()) {
    await assert.rejects(
      appendSessionEvent(undefined, `${sessionId}-${index}`, input as never),
      /Session event input is invalid/,
    );
  }
});

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
  for (const malformedAudio of [
    { ...audioRef, durationSeconds: undefined },
    { ...audioRef, durationSeconds: 120.001 },
    { ...audioRef, sampleRate: 0 },
    { ...audioRef, channels: 0 },
    { ...audioRef, mediaType: "audio/mpeg", channels: 3 },
    { ...audioRef, mediaType: "audio/mpeg", sampleRate: 8_000 },
    { ...audioRef, tags: { title: "must-not-persist" } },
  ]) {
    await assert.rejects(
      appendSessionEvent(undefined, sessionId, {
        kind: "user",
        content: "malformed audio",
        attachments: [malformedAudio as SessionAttachmentRef],
      }),
      /invalid/i,
    );
  }
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
  const legacyRefs = Array.from(
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
  ) as unknown as SessionAttachmentRef[];
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

test("current audio event refs require and preserve strict technical metadata", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-audio-events-"));
  const event = await appendSessionEvent(dir, "session-audio-event", {
    kind: "user",
    content: "Use this recording",
    attachments: [audioRef],
  });
  assert.deepEqual(event.attachments, [audioRef]);
  assert.notEqual(event.attachments?.[0], audioRef);
  assert.deepEqual(
    (await loadSessionEvents(dir, "session-audio-event"))[0]?.attachments,
    [audioRef],
  );
});

test("event attachment limits accept the exact count and image subtotal boundaries", async () => {
  const sessionId = `memory-event-boundary-${Date.now()}`;
  const refs = Array.from({ length: MAX_USER_EVENT_ATTACHMENT_COUNT }, (_, index) => ({
    ...imageRef,
    id: `attachment-boundary-${index}`,
    byteLength: MAX_PENDING_IMAGE_ATTACHMENT_BYTES /
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
    MAX_PENDING_IMAGE_ATTACHMENT_BYTES,
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
  assert.equal(MAX_PENDING_IMAGE_ATTACHMENT_BYTES, 16 * 1024 * 1024);
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
      byteLength: MAX_PENDING_DOCUMENT_ATTACHMENT_BYTES,
    }],
  });
  await assert.rejects(
    appendSessionEvent(undefined, `${sessionId}-document-over`, {
      kind: "user",
      content: "one over document subtotal",
      attachments: [{
        ...documentRef,
        id: "attachment-document-too-large",
        byteLength: MAX_PENDING_DOCUMENT_ATTACHMENT_BYTES + 1,
      }],
    }),
    /invalid/i,
  );
});

test("audio event refs enforce single, subtotal, count, and mixed raw quotas", async () => {
  const sessionId = `memory-event-audio-${Date.now()}`;
  assert.equal(MAX_PENDING_AUDIO_ATTACHMENT_BYTES, 30 * 1024 * 1024);
  assert.equal(MAX_PENDING_AUDIO_ATTACHMENT_COUNT, 2);
  const exactAudio = [0, 1].map((index) => ({
    ...audioRef,
    id: `attachment-audio-exact-${index}`,
    byteLength: MAX_PENDING_AUDIO_ATTACHMENT_BYTES / 2,
  }));
  const event = await appendSessionEvent(undefined, sessionId, {
    kind: "user",
    content: "exact audio subtotal",
    attachments: exactAudio,
  });
  assert.equal(
    event.attachments?.reduce((total, attachment) => total + attachment.byteLength, 0),
    MAX_PENDING_AUDIO_ATTACHMENT_BYTES,
  );

  await assert.rejects(
    appendSessionEvent(undefined, `${sessionId}-count-over`, {
      kind: "user",
      content: "three audio refs",
      attachments: [0, 1, 2].map((index) => ({
        ...audioRef,
        id: `attachment-audio-over-${index}`,
        byteLength: 1,
      })),
    }),
    /invalid/i,
  );
  await assert.rejects(
    appendSessionEvent(undefined, `${sessionId}-single-over`, {
      kind: "user",
      content: "single audio over",
      attachments: [{
        ...audioRef,
        id: "attachment-audio-single-over",
        byteLength: MAX_AUDIO_ATTACHMENT_BYTES + 1,
      }],
    }),
    /invalid/i,
  );

  await appendSessionEvent(undefined, `${sessionId}-mixed-exact`, {
    kind: "user",
    content: "mixed exact raw total",
    attachments: [
      { ...imageRef, id: "attachment-mixed-audio-image", byteLength: 5 * 1024 * 1024 },
      { ...documentRef, id: "attachment-mixed-audio-document" },
      { ...audioRef, id: "attachment-mixed-audio", byteLength: 10 * 1024 * 1024 },
    ],
  });
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

  const searchQueries = ["original query"];
  const appendedSearch = await appendSessionEvent(undefined, sessionId, {
    kind: "web_search",
    content: "Searched for original query",
    webSearch: {
      id: "search-memory-clone",
      status: "completed",
      action: "search",
      queries: searchQueries,
      sources: [],
    },
  });
  searchQueries[0] = "mutated-input query";
  appendedSearch.webSearch!.queries[0] = "mutated-return query";

  const steeringContent = "Keep the original steering guidance.";
  const expectedSteeringReceipt = steeringReceipt(
    "send-memory-clone",
    "steer-memory-clone",
    steeringContent,
  );
  const inputSteeringReceipt = { ...expectedSteeringReceipt };
  const appendedSteering = await appendSessionEvent(undefined, sessionId, {
    kind: "user",
    content: steeringContent,
    steeringReceipt: inputSteeringReceipt,
  });
  inputSteeringReceipt.id = "mutated-input";
  appendedSteering.steeringReceipt!.id = "mutated-return";

  const firstLoad = await loadSessionEvents(undefined, sessionId);
  assert.equal(firstLoad[0]?.attachments?.[0]?.fileName, imageRef.fileName);
  assert.deepEqual(firstLoad[1]?.recovery?.completedActionDigests, [digest]);
  assert.deepEqual(firstLoad[2]?.webSearch?.queries, ["original query"]);
  assert.deepEqual(firstLoad[3]?.steeringReceipt, expectedSteeringReceipt);
  firstLoad[0]!.attachments![0]!.fileName = "mutated-load.png";
  firstLoad[1]!.recovery!.completedActionDigests[0] = "e".repeat(64);
  firstLoad[2]!.webSearch!.queries[0] = "mutated-load query";
  firstLoad[3]!.steeringReceipt!.id = "mutated-load";

  const secondLoad = await loadSessionEvents(undefined, sessionId);
  assert.equal(secondLoad[0]?.attachments?.[0]?.fileName, imageRef.fileName);
  assert.deepEqual(secondLoad[1]?.recovery?.completedActionDigests, [digest]);
  assert.deepEqual(secondLoad[2]?.webSearch?.queries, ["original query"]);
  assert.deepEqual(secondLoad[3]?.steeringReceipt, expectedSteeringReceipt);
  const retriedSteering = await appendSessionEvent(undefined, sessionId, {
    kind: "user",
    content: steeringContent,
    steeringReceipt: { ...expectedSteeringReceipt },
  });
  assert.equal(retriedSteering.id, appendedSteering.id);
  assert.equal((await loadSessionEvents(undefined, sessionId)).length, 4);
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
  await appendSessionEvent(dir, sessionId, {
    kind: "compaction",
    content: "Conversation checkpoint",
  });

  const events = await loadSessionEvents(dir, sessionId);
  assert.deepEqual(
    events.map((event) => event.kind),
    ["assistant", "apply_requested", "apply_auto_approved", "compaction"],
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

test("recovery persistence accepts legacy and current bounds but rejects overflow", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-events-"));
  const digests = (count: number) => Array.from(
    { length: count },
    (_value, index) => createHash("sha256")
      .update(`recovery-bound-${index}`)
      .digest("hex"),
  );

  for (const [sessionId, count] of [
    ["legacy-recovery-bound", LEGACY_MAX_RECOVERY_ACTION_DIGESTS],
    ["current-recovery-bound", MAX_RECOVERY_ACTION_DIGESTS],
  ] as const) {
    await appendSessionEvent(dir, sessionId, {
      kind: "apply_result",
      content: "Recovery remains active.",
      recovery: {
        active: true,
        completedActionDigests: digests(count),
      },
    });
    const events = await loadSessionEvents(dir, sessionId);
    assert.equal(events[0]?.recovery?.completedActionDigests.length, count);
  }

  await assert.rejects(
    appendSessionEvent(dir, "overflow-recovery-bound", {
      kind: "apply_result",
      content: "Recovery exceeds its persistence bound.",
      recovery: {
        active: true,
        completedActionDigests: digests(MAX_RECOVERY_ACTION_DIGESTS + 1),
      },
    }),
    /Session event input is invalid/,
  );
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

test("duplicate persisted steering receipt identities are event-log corruption", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-event-receipt-"));
  const eventsDirectory = path.join(dir, "live-smith-events");
  await fs.mkdir(eventsDirectory);
  const target = path.join(eventsDirectory, "duplicate-steering-receipts.json");
  const firstContent = "Use the Lead track.";
  const secondContent = "Use the Rhythm track.";
  const original = JSON.stringify([
    {
      id: "event-steering-first",
      createdAt: "2026-08-15T00:00:00.000Z",
      kind: "user",
      content: firstContent,
      steeringReceipt: steeringReceipt(
        "send-duplicate-receipt",
        "steer-duplicate-receipt",
        firstContent,
      ),
    },
    {
      id: "event-steering-second",
      createdAt: "2026-08-15T00:00:01.000Z",
      kind: "user",
      content: secondContent,
      steeringReceipt: steeringReceipt(
        "send-duplicate-receipt",
        "steer-duplicate-receipt",
        secondContent,
      ),
    },
  ]);
  await fs.writeFile(target, original);

  await assert.rejects(
    loadSessionEvents(dir, "duplicate-steering-receipts"),
    (error: unknown) => error instanceof SessionEventsCorruptionError,
  );
  await assert.rejects(
    appendSessionEvent(dir, "duplicate-steering-receipts", {
      kind: "assistant",
      content: "Must not overwrite",
    }),
    (error: unknown) => error instanceof SessionEventsCorruptionError,
  );
  assert.equal(await fs.readFile(target, "utf8"), original);
});

test("persisted steering receipts reject malformed shape and content hashes", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-event-receipt-"));
  const eventsDirectory = path.join(dir, "live-smith-events");
  await fs.mkdir(eventsDirectory);
  const target = path.join(eventsDirectory, "invalid-steering-receipt.json");
  const content = "Keep the current device chain.";
  const valid = steeringReceipt("send-persisted", "steer-persisted", content);
  const invalidReceipts = [
    { ...valid, sha256: "f".repeat(64) },
    { ...valid, sendId: "unsafe/send" },
    { ...valid, id: "steer-persisted", extra: true },
  ];

  for (const invalidReceipt of invalidReceipts) {
    await fs.writeFile(target, JSON.stringify([{
      id: "event-invalid-steering-receipt",
      createdAt: "2026-08-15T00:00:00.000Z",
      kind: "user",
      content,
      steeringReceipt: invalidReceipt,
    }]));
    await assert.rejects(
      loadSessionEvents(dir, "invalid-steering-receipt"),
      (error: unknown) => error instanceof SessionEventsCorruptionError,
    );
  }
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

test("assistant events persist strict bounded citations and isolate returned arrays", async () => {
  const sessionId = `citation-memory-${Date.now()}`;
  const citations = [{
    url: "https://example.test/source",
    title: "Official source",
  }];
  const event = await appendSessionEvent(undefined, sessionId, {
    kind: "assistant",
    content: "A cited answer.",
    citations,
  });
  citations[0]!.title = "mutated";
  assert.deepEqual(event.citations, [{
    url: "https://example.test/source",
    title: "Official source",
  }]);
  assert.deepEqual((await loadSessionEvents(undefined, sessionId))[0]?.citations, [{
    url: "https://example.test/source",
    title: "Official source",
  }]);

  for (const input of [
    {
      kind: "user" as const,
      content: "Wrong kind",
      citations: [{ url: "https://example.test/", title: "Source" }],
    },
    {
      kind: "assistant" as const,
      content: "Unsafe URL",
      citations: [{ url: "javascript:alert(1)", title: "Source" }],
    },
    {
      kind: "assistant" as const,
      content: "Duplicate URL",
      citations: [
        { url: "https://example.test/", title: "First" },
        { url: "https://example.test/", title: "Second" },
      ],
    },
  ]) {
    await assert.rejects(
      appendSessionEvent(undefined, `${sessionId}-invalid`, input),
      /Session event input is invalid/,
    );
  }
});

test("provider-confirmed Web Search activity persists as its own timeline event", async () => {
  const sessionId = `web-search-memory-${Date.now()}`;
  await appendSessionEvent(undefined, sessionId, {
    kind: "web_search",
    content: "Searched for “Ableton Live release” · 2 pages",
    webSearch: {
      id: "search-1",
      status: "completed",
      action: "search",
      queries: ["Ableton Live release"],
      sources: [
        { url: "https://example.test/one", title: "First result" },
        { url: "https://example.test/two", title: "Second result" },
      ],
    },
  });
  const events = await loadSessionEvents(undefined, sessionId);
  assert.deepEqual(events, [{
    id: events[0]?.id,
    createdAt: events[0]?.createdAt,
    kind: "web_search",
    content: "Searched for “Ableton Live release” · 2 pages",
    webSearch: {
      id: "search-1",
      status: "completed",
      action: "search",
      queries: ["Ableton Live release"],
      sources: [
        { url: "https://example.test/one", title: "First result" },
        { url: "https://example.test/two", title: "Second result" },
      ],
    },
  }]);

  const failed = await appendSessionEvent(undefined, `${sessionId}-failed`, {
    kind: "web_search",
    content: "Web Search failed for “Ableton Live release”",
    webSearch: {
      id: "search-failed",
      status: "failed",
      action: "search",
      queries: ["Ableton Live release"],
      sources: [],
    },
  });
  assert.equal(failed.webSearch?.status, "failed");
  assert.equal(
    (await loadSessionEvents(undefined, `${sessionId}-failed`))[0]
      ?.webSearch?.status,
    "failed",
  );

  for (const input of [
    { kind: "web_search" as const, content: "Missing structured activity" },
    {
      kind: "web_search" as const,
      content: "Searching is transient only",
      webSearch: {
        id: "search-live-only",
        status: "searching" as const,
        action: "search" as const,
        queries: ["Ableton Live release"],
        sources: [],
      },
    },
    {
      kind: "web_search" as const,
      content: "Legacy singular query",
      webSearch: {
        id: "search-legacy-query",
        status: "completed",
        action: "search",
        query: "Ableton Live release",
        sources: [],
      } as never,
    },
    {
      kind: "assistant" as const,
      content: "Wrong event kind",
      webSearch: events[0]!.webSearch!,
    },
  ]) {
    await assert.rejects(
      appendSessionEvent(undefined, `${sessionId}-invalid`, input),
      /Session event input is invalid/,
    );
  }
});

test("persisted Web Search events reject transient searching status", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-searching-event-"));
  const eventsDirectory = path.join(dir, "live-smith-events");
  await fs.mkdir(eventsDirectory);
  await fs.writeFile(path.join(eventsDirectory, "searching-session.json"), JSON.stringify([{
    id: "event-searching",
    createdAt: "2026-08-11T00:00:00.000Z",
    kind: "web_search",
    content: "Searching the web",
    webSearch: {
      id: "search-live-only",
      status: "searching",
      action: "search",
      queries: ["Ableton Live release"],
      sources: [],
    },
  }]));

  await assert.rejects(
    loadSessionEvents(dir, "searching-session"),
    (error: unknown) => error instanceof SessionEventsCorruptionError,
  );
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
