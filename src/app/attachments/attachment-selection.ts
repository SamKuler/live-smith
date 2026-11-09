import { createHash } from "node:crypto";
import { sliceWaveAttachmentRange, inspectAudioAttachment } from "../../attachments/audio.js";
import { AttachmentProcessingError } from "../../attachments/contracts.js";
import { throwIfAborted } from "../../runtime/host.js";
import { openSessionAttachmentRange, readSessionAttachmentMetadata, reuseSessionAttachment, saveSessionAttachment, sessionAttachmentRefFromStored, type StoredSessionAttachment } from "../../storage/attachments.js";
import { ChatBridgeConflictError, ChatBridgeRequestValidationError, type ChatBridgeAttachmentSelectionInput } from "../chat/chat-bridge-http.js";

/** Called under the Session attachment fence, using its authoritative pending snapshot. */
export async function selectSavedAttachment(storageDirectory: string | undefined, input: ChatBridgeAttachmentSelectionInput,
  pending: readonly StoredSessionAttachment[], signal: AbortSignal): Promise<void> {
  const replaced = pending.find((item) => item.id === input.attachmentId);
  if (input.replace && !replaced) throw new ChatBridgeConflictError("This attachment is no longer in the pending draft. Refresh before selecting it again.");
  let source = sessionAttachmentRefFromStored(await readSessionAttachmentMetadata(storageDirectory, input.sessionId, input.attachmentId));
  if (input.mode !== "convert-mp3" && input.bytes.byteLength) throw new ChatBridgeRequestValidationError("Saved attachment reuse does not accept uploaded bytes.");
  if (input.mode === "original") {
    const visited = new Set([source.id]);
    while (source.provenance) {
      const id = source.provenance.sourceId;
      if (visited.has(id)) throw new ChatBridgeRequestValidationError("The saved attachment source is invalid.");
      visited.add(id);
      source = sessionAttachmentRefFromStored(await readSessionAttachmentMetadata(storageDirectory, input.sessionId, id));
    }
  }
  let bytes = input.bytes;
  let fileName = source.fileName;
  let range: { startSeconds: number; endSeconds: number } | undefined;
  if (input.mode === "copy" && source.provenance?.startSeconds !== undefined) {
    range = { startSeconds: source.provenance.startSeconds, endSeconds: source.provenance.endSeconds! };
  }
  if (input.mode === "excerpt" || input.mode === "convert-mp3") {
    const startSeconds = input.startSeconds!;
    const endSeconds = input.endSeconds!;
    if (source.kind !== "audio" || !Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) ||
        startSeconds < 0 || endSeconds <= startSeconds || endSeconds > source.durationSeconds) {
      throw new AttachmentProcessingError("invalid_audio", "Select a valid range within the saved audio.");
    }
    if (input.mode === "excerpt") {
      const reader = await openSessionAttachmentRange(storageDirectory, input.sessionId, source.id);
      try {
        const hash = createHash("sha256");
        for (let offset = 0; offset < source.byteLength; offset += 64 * 1024) {
          throwIfAborted(signal);
          hash.update(await reader.readRange(offset, Math.min(64 * 1024, source.byteLength - offset)));
        }
        if (hash.digest("hex") !== source.sha256) throw new AttachmentProcessingError("invalid_audio", "The saved audio content failed verification.");
        const excerpt = await sliceWaveAttachmentRange({ byteLength: source.byteLength, readRange: reader.readRange, startSeconds, endSeconds, signal });
        bytes = excerpt.bytes;
        range = { startSeconds: excerpt.startSeconds, endSeconds: excerpt.endSeconds };
      } finally { await reader.close(); }
    } else {
      if (source.mediaType !== "audio/mpeg") throw new ChatBridgeRequestValidationError("Explicit MP3 conversion requires an MP3 source.");
      const decoded = await inspectAudioAttachment({ bytes: input.bytes, signal });
      if (decoded.mediaType !== "audio/wav" || decoded.sampleRate !== source.sampleRate ||
          decoded.channels !== source.channels || Math.abs(decoded.durationSeconds - (endSeconds - startSeconds)) > 2 / decoded.sampleRate) {
        throw new AttachmentProcessingError("invalid_audio", "Converted WAV must preserve the source sample rate, channels and selected duration.");
      }
      bytes = input.bytes;
      range = { startSeconds, endSeconds };
    }
    fileName = `${fileName.replace(/\.[^.]*$/u, "").slice(0, 80)} [${range.startSeconds.toFixed(3)}-${range.endSeconds.toFixed(3)}s].wav`;
  }
  throwIfAborted(signal);
  if (input.mode === "copy" || input.mode === "original") {
    await reuseSessionAttachment(storageDirectory, input.sessionId, source.id, {
      signal,
      preSavePendingAttachmentRefs: pending.filter((item) => !input.replace || item.id !== input.attachmentId).map(sessionAttachmentRefFromStored),
      provenance: {
        sourceId: input.mode === "copy" && source.provenance ? source.provenance.sourceId : source.id,
        replacedIds: input.replace ? [input.attachmentId, ...(replaced?.provenance?.replacedIds ?? [])] : [],
        ...range,
      },
    });
    return;
  }
  await saveSessionAttachment(storageDirectory, input.sessionId, { fileName, bytes, signal }, {
    preSavePendingAttachmentRefs: pending.filter((item) => !input.replace || item.id !== input.attachmentId).map(sessionAttachmentRefFromStored),
    provenance: {
      sourceId: source.id,
      replacedIds: input.replace ? [input.attachmentId, ...(replaced?.provenance?.replacedIds ?? [])] : [],
      ...range,
    },
  });
}
