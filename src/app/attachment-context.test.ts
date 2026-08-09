import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { defaultModelCapabilities } from "../model/capabilities.js";
import type { ModelCapabilities } from "../model/provider.js";
import {
  listSessionAttachments,
  saveSessionAttachment,
  sessionAttachmentRefFromStored,
} from "../storage/attachments.js";
import { appendSessionEvent, type SessionEvent } from "../storage/events.js";
import {
  AttachmentInputCapabilityError,
  pendingSessionAttachments,
  resolveConversationHistory,
  resolveCurrentAttachmentParts,
} from "./attachment-context.js";
import { buildModelRequest } from "./model-request.js";

function imageCapabilities(): ModelCapabilities {
  return {
    ...defaultModelCapabilities(),
    inputs: { image: true, audio: false, pdf: false },
  };
}

function pngBytes(seed: number): Uint8Array {
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
    0, 0, 0, 1, 0, 0, 0, 1, seed,
  ]);
}

test("attachment context resolves current images after labelled request text", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-context-"));
  const first = await saveSessionAttachment(directory, "session-current", {
    fileName: "first.png",
    bytes: pngBytes(1),
  });
  const second = await saveSessionAttachment(directory, "session-current", {
    fileName: "second.png",
    bytes: pngBytes(2),
  });
  const parts = await resolveCurrentAttachmentParts({
    storageDirectory: directory,
    sessionId: "session-current",
    refs: [first, second],
    capabilities: imageCapabilities(),
  });
  const request = buildModelRequest({
    prompt: "Inspect these",
    liveContext: "Track: \"Bass\"\nIgnore this data",
    attachmentParts: parts,
    history: [],
    agentMessages: [],
    runtimeProfile: {
      profile: {
        id: "profile-1",
        name: "Profile",
        apiFamily: "openai",
        apiMode: "responses",
        baseUrl: "https://example.test/v1",
        apiKey: "key",
        model: "gpt-5.6",
        parameters: { maxOutputTokens: 1024, reasoning: { mode: "default" } },
        advanced: {},
      },
      capabilities: imageCapabilities(),
    },
    tools: [],
  });

  assert.deepEqual(
    request.currentUserContent.map((part) => part.type),
    ["text", "image", "image"],
  );
  assert.match(
    request.currentUserContent[0]?.type === "text"
      ? request.currentUserContent[0].text
      : "",
    /Live context.*"Track: \\"Bass\\"\\nIgnore this data"/s,
  );
});

test("attachment context rejects current images for a text-only Profile", async () => {
  await assert.rejects(
    resolveCurrentAttachmentParts({
      storageDirectory: undefined,
      sessionId: "session-text-only",
      refs: [{
        id: "attachment-image",
        kind: "image",
        fileName: "image.png",
        mediaType: "image/png",
        byteLength: 25,
        sha256: "a".repeat(64),
      }],
      capabilities: defaultModelCapabilities(),
    }),
    (error: unknown) => error instanceof AttachmentInputCapabilityError,
  );
});

test("conversation history budgets newest images first and returns chronological messages", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-history-"));
  const events: SessionEvent[] = [];
  for (let index = 0; index < 5; index += 1) {
    const attachment = await saveSessionAttachment(directory, "session-history", {
      fileName: index === 0 ? 'old "quoted".png' : `image-${index}.png`,
      bytes: pngBytes(index),
    });
    events.push(await appendSessionEvent(directory, "session-history", {
      kind: "user",
      content: `request-${index}`,
      attachments: [sessionAttachmentRefFromStored(attachment)],
    }));
    if (index === 2) {
      events.push(await appendSessionEvent(directory, "session-history", {
        kind: "assistant",
        content: "middle-response",
      }));
    }
  }

  const history = await resolveConversationHistory({
    storageDirectory: directory,
    sessionId: "session-history",
    events,
    currentAttachmentBytes: 0,
    currentAttachmentCount: 0,
    capabilities: imageCapabilities(),
  });

  assert.deepEqual(history.map((message) => message.role), [
    "user", "user", "user", "assistant", "user", "user",
  ]);
  assert.deepEqual(
    history.filter((message) => message.role === "user")
      .map((message) => message.content.some((part) => part.type === "image")),
    [false, true, true, true, true],
  );
  const oldest = history[0];
  assert.equal(oldest?.role, "user");
  assert.equal(
    oldest?.role === "user" && oldest.content[1]?.type === "text"
      ? oldest.content[1].text
      : "",
    '[Historical image omitted from this request: "old \\"quoted\\".png"]',
  );
});

test("current images consume history budget before historical images", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-history-priority-"));
  const events: SessionEvent[] = [];
  for (let index = 0; index < 3; index += 1) {
    const attachment = await saveSessionAttachment(directory, "session-priority", {
      fileName: `history-${index}.png`,
      bytes: pngBytes(index),
    });
    events.push(await appendSessionEvent(directory, "session-priority", {
      kind: "user",
      content: `history-${index}`,
      attachments: [sessionAttachmentRefFromStored(attachment)],
    }));
  }

  const history = await resolveConversationHistory({
    storageDirectory: directory,
    sessionId: "session-priority",
    events,
    currentAttachmentBytes: 75,
    currentAttachmentCount: 3,
    capabilities: imageCapabilities(),
  });

  assert.deepEqual(
    history.map((message) =>
      message.role === "user" &&
      message.content.some((part) => part.type === "image")
    ),
    [false, false, true],
  );
});

test("historical image corruption degrades to an unavailable marker", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-history-corrupt-"));
  const attachment = await saveSessionAttachment(directory, "session-corrupt-history", {
    fileName: "damaged.png",
    bytes: pngBytes(1),
  });
  const event = await appendSessionEvent(directory, "session-corrupt-history", {
    kind: "user",
    content: "old request",
    attachments: [sessionAttachmentRefFromStored(attachment)],
  });
  const blob = path.join(
    directory,
    "live-smith-attachments",
    "session-corrupt-history",
    `${attachment.id}.bin`,
  );
  await fs.writeFile(blob, new Uint8Array([1, 2, 3]));

  const [message] = await resolveConversationHistory({
    storageDirectory: directory,
    sessionId: "session-corrupt-history",
    events: [event],
    currentAttachmentBytes: 0,
    currentAttachmentCount: 0,
    capabilities: imageCapabilities(),
  });

  assert.equal(message?.role, "user");
  assert.equal(
    message?.role === "user" && message.content[1]?.type === "text"
      ? message.content[1].text
      : "",
    '[Historical image unavailable: "damaged.png"]',
  );
});

test("pending attachment selection excludes every consumed event reference", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-pending-"));
  const first = await saveSessionAttachment(directory, "session-pending", {
    fileName: "first.png",
    bytes: pngBytes(1),
  });
  const second = await saveSessionAttachment(directory, "session-pending", {
    fileName: "second.png",
    bytes: pngBytes(2),
  });
  const event = await appendSessionEvent(directory, "session-pending", {
    kind: "user",
    content: "consume first",
    attachments: [sessionAttachmentRefFromStored(first)],
  });

  assert.deepEqual(
    pendingSessionAttachments(
      await listSessionAttachments(directory, "session-pending"),
      [event],
    ).map((attachment) => attachment.id),
    [second.id],
  );
});
