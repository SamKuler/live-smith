import { Buffer } from "node:buffer";

import type {
  ConversationMessage,
  ModelInputPart,
} from "../model/contracts.js";
import type { ModelCapabilities } from "../model/provider.js";
import {
  isImageAttachmentMediaType,
  listSessionAttachments,
  MAX_PENDING_SESSION_ATTACHMENT_BYTES,
  MAX_PENDING_SESSION_ATTACHMENT_COUNT,
  readSessionAttachmentBytes,
  type SessionAttachmentRef,
  type StoredSessionAttachment,
} from "../storage/attachments.js";
import type { SessionEvent } from "../storage/events.js";

const maxConversationMessages = 24;

export class AttachmentInputCapabilityError extends Error {
  constructor() {
    super(
      "The active model Profile does not support image input. Remove the pending images or enable the verified image capability override.",
    );
    this.name = "AttachmentInputCapabilityError";
  }
}

export async function resolveCurrentAttachmentParts(input: {
  storageDirectory: string | undefined;
  sessionId: string;
  refs: readonly SessionAttachmentRef[];
  capabilities: ModelCapabilities;
}): Promise<ModelInputPart[]> {
  if (!input.refs.length) return [];
  if (!input.capabilities.inputs.image) {
    throw new AttachmentInputCapabilityError();
  }
  assertRequestBudget(input.refs);
  const stored = new Map(
    (await listSessionAttachments(input.storageDirectory, input.sessionId))
      .map((attachment) => [attachment.id, attachment]),
  );
  const parts: ModelInputPart[] = [];
  for (const ref of input.refs) {
    const metadata = stored.get(ref.id);
    if (!metadata || !attachmentRefMatchesStored(ref, metadata)) {
      throw new Error("Current attachment metadata no longer matches its Session reference.");
    }
    if (ref.kind !== "image" || !isImageAttachmentMediaType(ref.mediaType)) {
      throw new Error("Only image attachments are supported in this request.");
    }
    const bytes = await readSessionAttachmentBytes(
      input.storageDirectory,
      input.sessionId,
      ref.id,
    );
    parts.push({
      type: "image",
      fileName: ref.fileName,
      mediaType: ref.mediaType,
      base64: Buffer.from(bytes).toString("base64"),
    });
  }
  return parts;
}

export async function resolveConversationHistory(input: {
  storageDirectory: string | undefined;
  sessionId: string;
  events: readonly SessionEvent[];
  currentAttachmentBytes: number;
  currentAttachmentCount: number;
  capabilities: ModelCapabilities;
}): Promise<ConversationMessage[]> {
  const events = input.events.filter(
    (event) => event.kind === "user" || event.kind === "assistant",
  ).slice(-maxConversationMessages);
  let remainingBytes = Math.max(
    0,
    MAX_PENDING_SESSION_ATTACHMENT_BYTES - input.currentAttachmentBytes,
  );
  let remainingCount = Math.max(
    0,
    MAX_PENDING_SESSION_ATTACHMENT_COUNT - input.currentAttachmentCount,
  );
  const selectedIds = new Set<string>();
  if (input.capabilities.inputs.image) {
    for (const event of [...events].reverse()) {
      if (event.kind !== "user") continue;
      for (const attachment of event.attachments ?? []) {
        if (
          selectedIds.has(attachment.id) ||
          attachment.kind !== "image" ||
          attachment.byteLength > remainingBytes ||
          remainingCount === 0
        ) continue;
        selectedIds.add(attachment.id);
        remainingBytes -= attachment.byteLength;
        remainingCount -= 1;
      }
    }
  }

  let stored = new Map<string, StoredSessionAttachment>();
  try {
    stored = new Map(
      (await listSessionAttachments(input.storageDirectory, input.sessionId))
        .map((attachment) => [attachment.id, attachment]),
    );
  } catch {
    // Historical corruption degrades only the affected media context.
  }

  const messages: ConversationMessage[] = [];
  for (const event of events) {
    if (event.kind === "assistant") {
      messages.push({ role: "assistant", content: event.content });
      continue;
    }
    if (event.kind !== "user") continue;
    const content: ModelInputPart[] = [{ type: "text", text: event.content }];
    for (const ref of event.attachments ?? []) {
      if (!selectedIds.has(ref.id)) {
        content.push(historicalMarker("omitted from this request", ref.fileName));
        continue;
      }
      const metadata = stored.get(ref.id);
      if (
        !metadata ||
        !attachmentRefMatchesStored(ref, metadata) ||
        ref.kind !== "image" ||
        !isImageAttachmentMediaType(ref.mediaType)
      ) {
        content.push(historicalMarker("unavailable", ref.fileName));
        continue;
      }
      try {
        const bytes = await readSessionAttachmentBytes(
          input.storageDirectory,
          input.sessionId,
          ref.id,
        );
        content.push({
          type: "image",
          fileName: ref.fileName,
          mediaType: ref.mediaType,
          base64: Buffer.from(bytes).toString("base64"),
        });
      } catch {
        content.push(historicalMarker("unavailable", ref.fileName));
      }
    }
    messages.push({ role: "user", content });
  }
  return messages;
}

export function pendingSessionAttachments(
  stored: readonly StoredSessionAttachment[],
  events: readonly SessionEvent[],
): StoredSessionAttachment[] {
  const consumedIds = new Set(
    events.flatMap((event) => event.attachments?.map((attachment) => attachment.id) ?? []),
  );
  return stored.filter((attachment) => !consumedIds.has(attachment.id));
}

function historicalMarker(
  state: "omitted from this request" | "unavailable",
  fileName: string,
): ModelInputPart {
  return {
    type: "text",
    text: `[Historical image ${state}: ${JSON.stringify(fileName)}]`,
  };
}

function assertRequestBudget(refs: readonly SessionAttachmentRef[]): void {
  if (
    refs.length > MAX_PENDING_SESSION_ATTACHMENT_COUNT ||
    refs.reduce((total, ref) => total + ref.byteLength, 0) >
      MAX_PENDING_SESSION_ATTACHMENT_BYTES
  ) {
    throw new Error("Image attachments exceed the model request limit.");
  }
}

function attachmentRefMatchesStored(
  ref: SessionAttachmentRef,
  stored: StoredSessionAttachment,
): boolean {
  return ref.id === stored.id &&
    ref.kind === stored.kind &&
    ref.fileName === stored.fileName &&
    ref.mediaType === stored.mediaType &&
    ref.byteLength === stored.byteLength &&
    ref.sha256 === stored.sha256;
}
