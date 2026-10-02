import { sliceWaveAttachment, inspectAudioAttachment } from "../../attachments/audio.js";
import { AttachmentProcessingError } from "../../attachments/contracts.js";
import { throwIfAborted } from "../../runtime/host.js";
import { readSessionAttachment, saveSessionAttachment, sessionAttachmentRefFromStored, type StoredSessionAttachment } from "../../storage/attachments.js";
import { ChatBridgeConflictError, ChatBridgeRequestValidationError, type ChatBridgeAttachmentSelectionInput } from "../chat/chat-bridge-http.js";

/** Called under the Session attachment fence, using its authoritative pending snapshot. */
export async function selectSavedAttachment(storageDirectory: string | undefined, input: ChatBridgeAttachmentSelectionInput,
  pending: readonly StoredSessionAttachment[], signal: AbortSignal): Promise<void> {
  const replaced = pending.find((item) => item.id === input.attachmentId);
  if (input.replace && !replaced) throw new ChatBridgeConflictError("This attachment is no longer in the pending draft. Refresh before selecting it again.");
  let source = await readSessionAttachment(storageDirectory, input.sessionId, input.attachmentId, { signal });
  if (input.mode !== "convert-mp3" && input.bytes.byteLength) throw new ChatBridgeRequestValidationError("Saved attachment reuse does not accept uploaded bytes.");
  if (input.mode === "original") {
    const visited = new Set([source.attachment.id]);
    while (source.attachment.provenance) {
      const id = source.attachment.provenance.sourceId;
      if (visited.has(id)) throw new ChatBridgeRequestValidationError("The saved attachment source is invalid.");
      visited.add(id);
      source = await readSessionAttachment(storageDirectory, input.sessionId, id, { signal });
    }
  }
  let bytes = source.bytes;
  let fileName = source.attachment.fileName;
  let range: { startSeconds: number; endSeconds: number } | undefined;
  if (input.mode === "copy" && source.attachment.provenance?.startSeconds !== undefined) {
    range = { startSeconds: source.attachment.provenance.startSeconds, endSeconds: source.attachment.provenance.endSeconds! };
  }
  if (input.mode === "excerpt" || input.mode === "convert-mp3") {
    const startSeconds = input.startSeconds!;
    const endSeconds = input.endSeconds!;
    if (source.attachment.kind !== "audio" || !Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) ||
        startSeconds < 0 || endSeconds <= startSeconds || endSeconds > source.attachment.durationSeconds) {
      throw new AttachmentProcessingError("invalid_audio", "Select a valid range within the saved audio.");
    }
    if (input.mode === "excerpt") {
      const excerpt = await sliceWaveAttachment({ bytes, startSeconds, endSeconds, signal });
      bytes = excerpt.bytes;
      range = { startSeconds: excerpt.startSeconds, endSeconds: excerpt.endSeconds };
    } else {
      if (source.attachment.mediaType !== "audio/mpeg") throw new ChatBridgeRequestValidationError("Explicit MP3 conversion requires an MP3 source.");
      const decoded = await inspectAudioAttachment({ bytes: input.bytes, signal });
      if (decoded.mediaType !== "audio/wav" || decoded.sampleRate !== source.attachment.sampleRate ||
          decoded.channels !== source.attachment.channels || Math.abs(decoded.durationSeconds - (endSeconds - startSeconds)) > 2 / decoded.sampleRate) {
        throw new AttachmentProcessingError("invalid_audio", "Converted WAV must preserve the source sample rate, channels and selected duration.");
      }
      bytes = input.bytes;
      range = { startSeconds, endSeconds };
    }
    fileName = `${fileName.replace(/\.[^.]*$/u, "").slice(0, 80)} [${range.startSeconds.toFixed(3)}-${range.endSeconds.toFixed(3)}s].wav`;
  }
  throwIfAborted(signal);
  await saveSessionAttachment(storageDirectory, input.sessionId, { fileName, bytes, signal }, {
    preSavePendingAttachmentRefs: pending.filter((item) => !input.replace || item.id !== input.attachmentId).map(sessionAttachmentRefFromStored),
    provenance: {
      sourceId: input.mode === "copy" && source.attachment.provenance ? source.attachment.provenance.sourceId : source.attachment.id,
      replacedIds: input.replace ? [input.attachmentId, ...(replaced?.provenance?.replacedIds ?? [])] : [],
      ...range,
    },
  });
}
