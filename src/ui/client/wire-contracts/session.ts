import { isCreativeBrief } from "../../../agent/creative-brief.js";
import { isAttachmentProvenance } from "../../../attachments/provenance.js";
import type { AgentActionPreview, MidiActionPreview, MidiPreviewNote } from "../../../agent/action-preview.js";
import { isArtifactRef, isArtifactSelection } from "../../../agent/artifact-contracts.js";
import { isEditScopes as isWireEditScopes } from "../../../agent/edit-scopes.js";
import type { ConversationScope, ModelCitation, ModelContextUsage, ModelHostedWebSearch } from "../../../model/contracts.js";
import type { AvailableSkillSummary } from "../../../skills/builtins.js";
import type { PersistedSessionAttachmentRef, SessionAttachmentRef } from "../../../storage/attachments.js";
import type { ActionDiffGroup } from "../../action-diff.js";
import type { ChatLiveContext, ChatSessionActivity, ChatSessionEvent, ChatSessionSummary } from "../../chat-state.js";
import {
  WIRE_MAX_ACTIVE_SKILL_COUNT,
  WIRE_MAX_ATTACHMENT_FILE_NAME_BYTES,
  WIRE_MAX_AUDIO_ATTACHMENT_BYTES,
  WIRE_MAX_AUDIO_DURATION_SECONDS,
  WIRE_MAX_DOCUMENT_ATTACHMENT_BYTES,
  WIRE_MAX_IMAGE_ATTACHMENT_BYTES,
  WIRE_MAX_MIDI_ATTACHMENT_BYTES,
  WIRE_MAX_PENDING_ATTACHMENT_COUNT,
  WIRE_MAX_PENDING_AUDIO_ATTACHMENT_BYTES,
  WIRE_MAX_PENDING_AUDIO_ATTACHMENT_COUNT,
  WIRE_MAX_PENDING_DOCUMENT_ATTACHMENT_BYTES,
  WIRE_MAX_PENDING_IMAGE_ATTACHMENT_BYTES,
  WIRE_MAX_PENDING_TOTAL_ATTACHMENT_BYTES,
  WIRE_MAX_SKILL_ID_LENGTH,
  attachmentMediaTypeMatchesKind,
  maximumMidiPreviewNotes,
  maximumParameterPreviewValueItems,
  maximumRecoveryActionDigests,
  maximumSessionTitleCodePoints,
} from "./contracts.js";
import { isWireApprovalMode, isWireSessionModelSelection } from "./models.js";
import {
  hasOnlyWireKeys,
  includes,
  isFiniteNumber,
  isInteger,
  isSafeInteger,
  isWireArray,
  isWireCorrelationId,
  isWireRecord,
  isWireStorageId,
  isWireUiMessage,
  sameJsonData,
  wireCodePointLengthAtMost,
  wireUtf8ByteLength,
} from "./primitives.js";

export function isWireModelContextUsage(value: unknown): value is ModelContextUsage {
  return isWireRecord(value) &&
    hasOnlyWireKeys<NonNullable<ModelContextUsage>>(value, ["usedTokens", "contextWindowTokens"]) &&
    Object.keys(value).length === 2 &&
    isSafeInteger(value.usedTokens) &&
    value.usedTokens >= 0 &&
    isSafeInteger(value.contextWindowTokens) &&
    value.contextWindowTokens > 0;
}

export function isWireActionDiffGroups(value: unknown): value is ActionDiffGroup[] {
  return isWireArray(value) &&
    value.length > 0 &&
    value.every((group) =>
      isWireRecord(group) &&
      hasOnlyWireKeys(group, ["title", "rows"]) &&
      isWireUiMessage(group.title) &&
      Boolean(group.title) &&
      isWireArray(group.rows) &&
      group.rows.length > 0 &&
      group.rows.every((row) =>
        isWireUiMessage(row) &&
        Boolean(row)
      )
    );
}

export function wireActionDiffGroupsEqual(left: unknown, right: unknown): boolean {
  return sameJsonData(left, right);
}

export function isWireCitation(value: unknown): value is ModelCitation {
  if (
    !isWireRecord(value) ||
    !hasOnlyWireKeys<NonNullable<ModelCitation>>(value, ["url", "title"]) ||
    typeof value.url !== "string" ||
    wireUtf8ByteLength(value.url) > 2048 ||
    typeof value.title !== "string" ||
    value.title !== value.title.trim() ||
    !value.title ||
    [...value.title].length > 256 ||
    /[\u0000-\u001F\u007F\u202A-\u202E\u2066-\u2069]/u.test(value.title)
  ) return false;
  try {
    const parsed = new window.URL(value.url);
    return includes(["http:", "https:"], parsed.protocol) &&
      !parsed.username &&
      !parsed.password &&
      parsed.href === value.url;
  } catch {
    return false;
  }
}

export function isWireCitations(value: unknown, allowEmpty: boolean): value is ModelCitation[] {
  return isWireArray(value) &&
    (allowEmpty || value.length > 0) &&
    value.length <= 20 &&
    value.every(isWireCitation) &&
    new Set(value.map((citation) => citation.url)).size === value.length;
}

export function isWireWebSearch(value: unknown, allowSearching: boolean): value is ModelHostedWebSearch {
  if (
    !isWireRecord(value) ||
    !hasOnlyWireKeys<NonNullable<ModelHostedWebSearch>>(value, ["id", "status", "action", "queries", "sources"]) ||
    !isWireCorrelationId(value.id) ||
    !includes([
      ...(allowSearching ? ["searching"] : []),
      "completed",
      "failed",
    ], value.status) ||
    !includes(["search", "open_page", "find_in_page"], value.action) ||
    !isWireArray(value.queries) ||
    value.queries.length > 8 ||
    !value.queries.every((query) =>
      typeof query === "string" &&
      query === query.trim() &&
      Boolean(query) &&
      [...query].length <= 512 &&
      !/[\u0000-\u001F\u007F\u202A-\u202E\u2066-\u2069]/u.test(query)
    ) ||
    new Set(value.queries).size !== value.queries.length ||
    !isWireCitations(value.sources, true) ||
    (value.status === "failed" && value.sources.length !== 0)
  ) return false;
  return true;
}

export function isWireSessionAttachment(value: unknown): value is SessionAttachmentRef {
  if (
    !isWireRecord(value) ||
    !isWireStorageId(value.id) ||
    (value.provenance !== undefined && !isAttachmentProvenance(value.provenance, value.id)) ||
    !includes(["image", "document", "audio"], value.kind) ||
    !isWireAttachmentDisplayFileName(value.fileName) ||
    !isInteger(value.byteLength) ||
    value.byteLength <= 0 ||
    typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.sha256)
  ) return false;
  const commonKeys = [
    "id",
    "kind",
    "fileName",
    "mediaType",
    "byteLength",
    "sha256",
    "provenance",
  ] as const;
  if (value.kind === "image") {
    return hasOnlyWireKeys<NonNullable<SessionAttachmentRef>>(value, commonKeys) &&
      attachmentMediaTypeMatchesKind(value.kind, value.mediaType) &&
      value.byteLength <= WIRE_MAX_IMAGE_ATTACHMENT_BYTES;
  }
  if (value.kind === "document") {
    return hasOnlyWireKeys<NonNullable<SessionAttachmentRef>>(value, commonKeys) &&
      attachmentMediaTypeMatchesKind(value.kind, value.mediaType) &&
      value.byteLength <= (value.mediaType === "audio/midi"
        ? WIRE_MAX_MIDI_ATTACHMENT_BYTES : WIRE_MAX_DOCUMENT_ATTACHMENT_BYTES);
  }
  return hasOnlyWireKeys<NonNullable<SessionAttachmentRef>>(value, [
    ...commonKeys,
    "durationSeconds",
    "sampleRate",
    "channels",
  ]) &&
    attachmentMediaTypeMatchesKind(value.kind, value.mediaType) &&
    value.byteLength <= WIRE_MAX_AUDIO_ATTACHMENT_BYTES &&
    isFiniteNumber(value.durationSeconds) &&
    value.durationSeconds > 0 &&
    value.durationSeconds <= WIRE_MAX_AUDIO_DURATION_SECONDS &&
    isInteger(value.sampleRate) &&
    (value.mediaType === "audio/mpeg"
      ? includes([16_000, 22_050, 24_000, 32_000, 44_100, 48_000], value.sampleRate)
      : value.sampleRate >= 8_000 && value.sampleRate <= 192_000) &&
    isInteger(value.channels) &&
    value.channels >= 1 &&
    value.channels <= (value.mediaType === "audio/mpeg" ? 2 : 8);
}

export function isWireAttachmentDisplayFileName(value: unknown): value is string {
  return typeof value === "string" &&
    Boolean(value) &&
    value.length <= WIRE_MAX_ATTACHMENT_FILE_NAME_BYTES &&
    wireUtf8ByteLength(value) <= WIRE_MAX_ATTACHMENT_FILE_NAME_BYTES &&
    value === value.normalize("NFC") &&
    value === value.replaceAll("\\", "/").split("/").at(-1) &&
    !/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u
      .test(value);
}

export function isWireSessionAttachments(value: unknown): value is SessionAttachmentRef[] {
  if (
    !isWireArray(value) ||
    value.length === 0 ||
    value.length > WIRE_MAX_PENDING_ATTACHMENT_COUNT ||
    !value.every(isWireSessionAttachment) ||
    new Set(value.map((attachment) => attachment.id)).size !== value.length
  ) return false;
  const totalBytes = value.reduce(
    (total, attachment) => total + attachment.byteLength,
    0,
  );
  const imageBytes = value
    .filter((attachment) => attachment.kind === "image")
    .reduce((total, attachment) => total + attachment.byteLength, 0);
  const documentBytes = value
    .filter((attachment) => attachment.kind === "document")
    .reduce((total, attachment) => total + attachment.byteLength, 0);
  const audio = value.filter((attachment) => attachment.kind === "audio");
  const audioBytes = audio.reduce(
    (total, attachment) => total + attachment.byteLength,
    0,
  );
  return totalBytes <= WIRE_MAX_PENDING_TOTAL_ATTACHMENT_BYTES &&
    imageBytes <= WIRE_MAX_PENDING_IMAGE_ATTACHMENT_BYTES &&
    documentBytes <= WIRE_MAX_PENDING_DOCUMENT_ATTACHMENT_BYTES &&
    audioBytes <= WIRE_MAX_PENDING_AUDIO_ATTACHMENT_BYTES &&
    audio.length <= WIRE_MAX_PENDING_AUDIO_ATTACHMENT_COUNT;
}

export function isWireLegacySessionAttachment(value: unknown): value is PersistedSessionAttachmentRef {
  if (
    !isWireRecord(value) ||
    !hasOnlyWireKeys<NonNullable<PersistedSessionAttachmentRef>>(value, [
      "id",
      "kind",
      "fileName",
      "mediaType",
      "byteLength",
      "sha256",
    ]) ||
    Object.keys(value).length !== 6 ||
    !isWireStorageId(value.id) ||
    !includes(["image", "document", "audio"], value.kind) ||
    !isWireAttachmentDisplayFileName(value.fileName) ||
    !isInteger(value.byteLength) ||
    value.byteLength <= 0 ||
    value.byteLength > WIRE_MAX_IMAGE_ATTACHMENT_BYTES ||
    typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.sha256)
  ) return false;
  return attachmentMediaTypeMatchesKind(value.kind, value.mediaType);
}

export function isWireLegacySessionAttachments(value: unknown): value is PersistedSessionAttachmentRef[] {
  return isWireArray(value) &&
    value.length > 0 &&
    value.length <= WIRE_MAX_PENDING_ATTACHMENT_COUNT &&
    value.every(isWireLegacySessionAttachment) &&
    new Set(value.map((attachment) => attachment.id)).size === value.length &&
    value.reduce(
      (total, attachment) => total + attachment.byteLength,
      0,
    ) <= WIRE_MAX_PENDING_IMAGE_ATTACHMENT_BYTES;
}

export function isWireRecovery(value: unknown): value is NonNullable<ChatSessionEvent["recovery"]> {
  if (
    !isWireRecord(value) ||
    !hasOnlyWireKeys<NonNullable<NonNullable<ChatSessionEvent["recovery"]>>>(value, ["active", "completedActionDigests"]) ||
    typeof value.active !== "boolean" ||
    !isWireArray(value.completedActionDigests) ||
    value.completedActionDigests.length > maximumRecoveryActionDigests ||
    !value.completedActionDigests.every(
      (digest) => typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest),
    ) ||
    new Set(value.completedActionDigests).size !==
      value.completedActionDigests.length
  ) return false;
  return value.active || value.completedActionDigests.length === 0;
}

export function isWireSteeringAck(value: unknown): value is NonNullable<ChatSessionEvent["steeringAck"]> {
  return isWireRecord(value) &&
    hasOnlyWireKeys<NonNullable<NonNullable<ChatSessionEvent["steeringAck"]>>>(value, ["sendId", "steerId"]) &&
    isWireCorrelationId(value.sendId) &&
    isWireCorrelationId(value.steerId);
}

export function isWireSessionEvent(value: unknown, attachmentPolicy = "current"): value is ChatSessionEvent {
  if (
    !isWireRecord(value) ||
    !hasOnlyWireKeys<NonNullable<ChatSessionEvent>>(value, [
      "id",
      "createdAt",
      "kind",
      "content",
      "name",
      "recovery",
      "attachments",
      "citations",
      "webSearch",
      "steeringAck",
      "candidateSelection",
      "parentCandidate",
      "requestEventId",
    ]) ||
    !isWireStorageId(value.id) ||
    typeof value.createdAt !== "string" ||
    !includes([
      "user",
      "assistant",
      "reasoning",
      "web_search",
      "tool_call",
      "tool_result",
      "apply_requested",
      "apply_auto_approved",
      "apply_result",
      "compaction",
      "candidate",
      "error",
    ], value.kind) ||
    typeof value.content !== "string" ||
    (value.kind === "candidate" ? !isArtifactSelection(value.candidateSelection) : value.candidateSelection !== undefined) ||
    (value.parentCandidate !== undefined && ((value.kind !== "user" && value.kind !== "tool_call") || !isArtifactRef(value.parentCandidate))) ||
    (value.requestEventId !== undefined && (value.kind !== "tool_call" || !isWireStorageId(value.requestEventId))) ||
    (value.name !== undefined && typeof value.name !== "string") ||
    (value.attachments !== undefined && (
      value.kind !== "user" ||
      !isWireSessionAttachments(value.attachments) &&
        (
          attachmentPolicy !== "persisted" ||
          !isWireLegacySessionAttachments(value.attachments)
        )
    )) ||
    (value.citations !== undefined && (
      value.kind !== "assistant" ||
      !isWireCitations(value.citations, false)
    )) ||
    (value.recovery !== undefined && (
      value.kind !== "apply_result" ||
      !isWireRecovery(value.recovery)
    )) ||
    (value.steeringAck !== undefined && (
      value.kind !== "user" ||
      value.name !== undefined ||
      !isWireSteeringAck(value.steeringAck)
    ))
  ) return false;
  return value.kind === "web_search"
    ? isWireWebSearch(value.webSearch, false)
    : value.webSearch === undefined;
}

export function isWireConversationScope(value: unknown): value is ConversationScope {
  return isWireRecord(value) &&
    hasOnlyWireKeys<NonNullable<ConversationScope>>(value, ["kind", "identity", "label"]) &&
    includes(["track", "clip", "object", "selection"], value.kind) &&
    typeof value.identity === "string" &&
    typeof value.label === "string";
}

export function isWireSkillId(value: unknown): value is string {
  return typeof value === "string" &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*(?::[a-z0-9]+(?:-[a-z0-9]+)*)?$/.test(value) &&
    value.length <= WIRE_MAX_SKILL_ID_LENGTH;
}

export function isWireSkillSource(value: unknown): value is AvailableSkillSummary["source"] {
  return value === "built-in" || value === "user" || value === "plugin";
}

export function isWireSkillSummary(value: unknown): value is AvailableSkillSummary {
  if (!isWireRecord(value) ||
    !hasOnlyWireKeys<NonNullable<AvailableSkillSummary>>(value, ["id", "description", "source", "pluginId"]) ||
    !isWireSkillId(value.id) || typeof value.description !== "string" || !isWireSkillSource(value.source)) return false;
  if (value.source !== "plugin") return value.pluginId === undefined && !value.id.includes(":");
  return typeof value.pluginId === "string" &&
    /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/.test(value.pluginId) &&
    value.id.startsWith(value.pluginId + ":");
}

export function isWireSkillIds(value: unknown): value is string[] {
  return isWireArray(value) &&
    value.length <= WIRE_MAX_ACTIVE_SKILL_COUNT &&
    value.every(isWireSkillId) &&
    new Set(value).size === value.length;
}

export function isWireAgentSession(value: unknown): value is ChatSessionSummary {
  return isWireRecord(value) &&
    hasOnlyWireKeys<NonNullable<ChatSessionSummary>>(value, [
      "id",
      "title",
      "projectKey",
      "scope",
      "originScope",
      "archivedAt",
      "activeSkillIds",
      "approvalMode",
      "editScopes",
      "modelSelection",
      "creativeBrief",
      "hasContent",
      "createdAt",
      "updatedAt",
    ]) &&
    isWireStorageId(value.id) &&
    typeof value.title === "string" &&
    wireCodePointLengthAtMost(value.title, maximumSessionTitleCodePoints) &&
    typeof value.projectKey === "string" &&
    isWireConversationScope(value.scope) &&
    (value.originScope === undefined ||
      isWireConversationScope(value.originScope)) &&
    (value.archivedAt === undefined || typeof value.archivedAt === "string") &&
    (value.activeSkillIds === undefined ||
      isWireSkillIds(value.activeSkillIds)) &&
    (value.approvalMode === undefined ||
      isWireApprovalMode(value.approvalMode)) &&
    (value.editScopes === undefined || isWireEditScopes(value.editScopes)) &&
    (value.creativeBrief === undefined || isCreativeBrief(value.creativeBrief)) &&
    (value.modelSelection === undefined ||
      isWireSessionModelSelection(value.modelSelection)) &&
    (value.hasContent === undefined || typeof value.hasContent === "boolean") &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string";
}

export function isWireSessionActivity(value: unknown, sessionIds: ReadonlySet<string>): value is ChatSessionActivity {
  return isWireRecord(value) &&
    hasOnlyWireKeys<NonNullable<ChatSessionActivity>>(value, ["sessionId", "sendId", "status", "message", "unread"]) &&
    isWireStorageId(value.sessionId) &&
    sessionIds.has(value.sessionId) &&
    (value.sendId === undefined || isWireCorrelationId(value.sendId)) &&
    includes([
      "running",
      "waiting_confirmation",
      "completed",
      "failed",
      "stopped",
    ], value.status) &&
    (value.message === undefined || isWireUiMessage(value.message)) &&
    typeof value.unread === "boolean";
}

export function isWirePreviewNote(note: unknown): note is MidiPreviewNote {
  return isWireRecord(note) && hasOnlyWireKeys<NonNullable<MidiPreviewNote>>(note, [
    "pitch", "startTime", "duration", "velocity", "muted", "probability",
    "velocityDeviation", "releaseVelocity", "selected",
  ]) && isInteger(note.pitch) && note.pitch >= 0 && note.pitch <= 127 &&
    isFiniteNumber(note.startTime) && isFiniteNumber(note.duration) && note.duration > 0 &&
    ["velocity", "probability", "velocityDeviation", "releaseVelocity"].every((key) =>
      note[key] === undefined || isFiniteNumber(note[key])) &&
    ["muted", "selected"].every((key) => note[key] === undefined || typeof note[key] === "boolean");
}

export function isWirePreviewSide(side: unknown, range: { start: number; end: number }): side is MidiActionPreview["before"] {
  return isWireRecord(side) && hasOnlyWireKeys<NonNullable<MidiActionPreview["before"]>>(side, ["notes", "totalNoteCount", "omittedNoteCount"]) &&
    isWireArray(side.notes) && side.notes.length <= maximumMidiPreviewNotes && side.notes.every(isWirePreviewNote) &&
    side.notes.every((note) => note.startTime >= range.start && note.startTime < range.end &&
      note.startTime + note.duration <= range.end + 1e-7) &&
    isSafeInteger(side.totalNoteCount) && side.totalNoteCount >= side.notes.length &&
    side.omittedNoteCount === side.totalNoteCount - side.notes.length;
}

export function isWireActionPreviews(previews: unknown, kind: unknown, groups: ActionDiffGroup[]): previews is AgentActionPreview[] | undefined {
  if (previews === undefined) return true;
  if (kind !== "apply" || !isWireArray(previews) || previews.length !== 1 ||
    groups.reduce((count, group) => count + group.rows.length, 0) !== 1) return false;
  const preview = previews[0];
  if (!isWireRecord(preview) || preview.actionIndex !== 0 || preview.status !== "proposed" ||
    typeof preview.targetLabel !== "string") return false;
  if (preview.kind === "midi-notes") {
    const range = preview.range;
    return hasOnlyWireKeys(preview, ["kind", "actionIndex", "status", "targetLabel", "range", "before", "after"]) &&
      isWireRecord(range) && hasOnlyWireKeys(range, ["coordinate", "start", "end"]) &&
      range.coordinate === "clip-beats" && isFiniteNumber(range.start) && isFiniteNumber(range.end) &&
      range.start >= 0 && range.end > range.start && isWirePreviewSide(preview.before, { start: range.start, end: range.end }) && isWirePreviewSide(preview.after, { start: range.start, end: range.end });
  }
  return preview.kind === "parameter-value" && hasOnlyWireKeys(preview, [
    "kind", "actionIndex", "status", "targetLabel", "parameterName", "before", "after",
    "minimum", "maximum", "isQuantized", "valueItems",
  ]) && typeof preview.parameterName === "string" &&
    isFiniteNumber(preview.before) && isFiniteNumber(preview.after) &&
    isFiniteNumber(preview.minimum) && isFiniteNumber(preview.maximum) &&
    preview.minimum <= preview.maximum &&
    preview.before >= preview.minimum && preview.before <= preview.maximum &&
    preview.after >= preview.minimum && preview.after <= preview.maximum &&
    (preview.isQuantized === undefined || typeof preview.isQuantized === "boolean") &&
    (preview.valueItems === undefined || isWireArray(preview.valueItems) &&
      preview.valueItems.length <= maximumParameterPreviewValueItems && preview.valueItems.every((item) =>
      isWireRecord(item) && hasOnlyWireKeys(item, ["name", "shortName"]) &&
      typeof item.name === "string" && typeof item.shortName === "string"));
}

export function isWireLiveContext(context: unknown): context is ChatLiveContext {
  if (!isWireRecord(context) || !isWireStorageId(context.sessionId)) return false;
  if (context.availability === "unavailable") {
    return hasOnlyWireKeys<NonNullable<ChatLiveContext>>(context, ["sessionId", "availability", "label"]) &&
      typeof context.label === "string";
  }
  if (context.availability !== "available" ||
    !hasOnlyWireKeys<NonNullable<ChatLiveContext>>(context, ["sessionId", "availability", "value"])) return false;
  const value = context.value;
  if (!isWireRecord(value) ||
    !hasOnlyWireKeys(value, ["origin", "objectKind", "title", "details", "range"]) ||
    !includes(["object", "arrangement-selection", "clip-slot-selection"], value.origin) ||
    !includes(["midi-clip", "audio-clip", "track", "device", "other"], value.objectKind) ||
    typeof value.title !== "string" || !isWireArray(value.details) ||
    !value.details.every((line) => typeof line === "string")) return false;
  if (value.range === undefined) return true;
  const range = value.range;
  return isWireRecord(range) && hasOnlyWireKeys(range, ["coordinate", "start", "end"]) &&
    range.coordinate === "arrangement-beats" &&
    isFiniteNumber(range.start) && isFiniteNumber(range.end) &&
    range.start >= 0 && range.end >= range.start;
}
