import type { ATTACHMENT_REFERENCE_FORMATS } from "../../../attachments/contracts.js";
import type { BUILT_IN_INTEGRATION_CONNECTION_DESCRIPTORS } from "../../../plugins/builtins/index.js";
export type AudioDescriptor = (typeof BUILT_IN_INTEGRATION_CONNECTION_DESCRIPTORS)[string];
declare const __ATTACHMENT_REFERENCE_FORMATS__: typeof ATTACHMENT_REFERENCE_FORMATS;
declare const __MAX_DISCOVERED_MODEL_COUNT__: number;
declare const __MAX_PROFILE_MODEL_COUNT__: number;
declare const __MAX_DISCOVERED_MODEL_ID_CODE_POINTS__: number;
declare const __MAX_DISCOVERED_MODEL_DISPLAY_NAME_CODE_POINTS__: number;
declare const __MAX_DISCOVERED_MODEL_OUTPUT_TOKENS__: number;
declare const __MAX_DISCOVERED_MODEL_CONTEXT_WINDOW_TOKENS__: number;
declare const __MAX_SESSION_TITLE_CODE_POINTS__: number;
declare const __MAX_RECOVERY_ACTION_DIGESTS__: number;
declare const __BUILT_IN_INTEGRATION_CONNECTION_DESCRIPTORS__: typeof BUILT_IN_INTEGRATION_CONNECTION_DESCRIPTORS;
declare const __MAX_MIDI_PREVIEW_NOTES__: number;
declare const __MAX_PARAMETER_PREVIEW_VALUE_ITEMS__: number;
declare const __MAX_IMAGE_ATTACHMENT_BYTES__: number;
declare const __MAX_MIDI_ATTACHMENT_BYTES__: number;
declare const __MAX_DOCUMENT_ATTACHMENT_BYTES__: number;
declare const __MAX_AUDIO_ATTACHMENT_BYTES__: number;
declare const __MAX_AUDIO_DURATION_SECONDS__: number;
declare const __MAX_ATTACHMENT_FILE_NAME_BYTES__: number;
declare const __MAX_PENDING_ATTACHMENT_COUNT__: number;
declare const __MAX_PENDING_TOTAL_ATTACHMENT_BYTES__: number;
declare const __MAX_PENDING_IMAGE_ATTACHMENT_BYTES__: number;
declare const __MAX_PENDING_DOCUMENT_ATTACHMENT_BYTES__: number;
declare const __MAX_PENDING_AUDIO_ATTACHMENT_BYTES__: number;
declare const __MAX_PENDING_AUDIO_ATTACHMENT_COUNT__: number;
declare const __MAX_SKILL_ID_LENGTH__: number;
declare const __MAX_ACTIVE_SKILL_COUNT__: number;
declare const __CURRENT_AGENT_SETTINGS_SCHEMA_VERSION__: number;
declare const __MAX_INTEGRATION_CONNECTIONS__: number;
declare const __AUDIO_OUTPUT_LABELS__: Readonly<Record<string, string>>;
declare const __MAX_AUDIO_ASSET_BYTES__: number;
declare const __MAX_AUDIO_ASSET_DURATION_SECONDS__: number;
declare const __MAX_AUDIO_SESSION_JOBS__: number;
declare const __SEPARATION_STEMS__: readonly string[];
declare const __MAX_AUDIO_JOB_TITLE_CHARACTERS__: number;
declare const __MAX_AUDIO_JOB_OUTPUTS__: number;
declare const __MAX_PLUGIN_ARCHIVE_BYTES__: number;
declare const __MAX_SESSION_TOOL_CATALOG_TOOLS__: number;
declare const __MAX_SESSION_TOOL_CATALOG_ISSUES__: number;
declare const __MAX_SESSION_TOOL_CATALOG_DESCRIPTION_LENGTH__: number;
const attachmentFormats = __ATTACHMENT_REFERENCE_FORMATS__;
export const attachmentMediaTypeMatchesKind = (kind: unknown, mediaType: unknown) =>
  attachmentFormats.some((format) => format.kind === kind && format.mediaType === mediaType);
export const maximumDiscoveredModelCount = __MAX_DISCOVERED_MODEL_COUNT__;
export const maximumProviderReportedMimeTypeCount = 128;
export const maximumProviderReportedModalityCount = 32;
export const maximumProfileModelCount = __MAX_PROFILE_MODEL_COUNT__;
export const maximumDiscoveredModelIdCodePoints =
  __MAX_DISCOVERED_MODEL_ID_CODE_POINTS__;
export const maximumDiscoveredModelDisplayNameCodePoints =
  __MAX_DISCOVERED_MODEL_DISPLAY_NAME_CODE_POINTS__;
export const maximumDiscoveredModelOutputTokens =
  __MAX_DISCOVERED_MODEL_OUTPUT_TOKENS__;
export const maximumDiscoveredModelContextWindowTokens =
  __MAX_DISCOVERED_MODEL_CONTEXT_WINDOW_TOKENS__;
export const maximumSessionTitleCodePoints = __MAX_SESSION_TITLE_CODE_POINTS__;
export const maximumRecoveryActionDigests = __MAX_RECOVERY_ACTION_DIGESTS__;
export const audioConnectionDescriptorsByPluginId = __BUILT_IN_INTEGRATION_CONNECTION_DESCRIPTORS__;
export const isBuiltInAudioPluginId = (pluginId: string) =>
  Object.hasOwn(audioConnectionDescriptorsByPluginId, pluginId);
export const singleOutputAudioOperations = new Set<unknown>(["get_whole_song", "finish_music_replacement", "upload_music"]);
export const audioServiceCapabilities = Object.fromEntries(
  Object.values(audioConnectionDescriptorsByPluginId)
    .map((descriptor) => [descriptor.provider, descriptor]),
);
export const usesImportedSession = (descriptor: AudioDescriptor | undefined) =>
  descriptor?.authentication === "suno-session";
export const maximumMidiPreviewNotes = __MAX_MIDI_PREVIEW_NOTES__;
export const maximumParameterPreviewValueItems = __MAX_PARAMETER_PREVIEW_VALUE_ITEMS__;

export const WIRE_MAX_IMAGE_ATTACHMENT_BYTES = __MAX_IMAGE_ATTACHMENT_BYTES__;
export const WIRE_MAX_MIDI_ATTACHMENT_BYTES = __MAX_MIDI_ATTACHMENT_BYTES__;
export const WIRE_MAX_DOCUMENT_ATTACHMENT_BYTES = __MAX_DOCUMENT_ATTACHMENT_BYTES__;
export const WIRE_MAX_AUDIO_ATTACHMENT_BYTES = __MAX_AUDIO_ATTACHMENT_BYTES__;
export const WIRE_MAX_AUDIO_DURATION_SECONDS = __MAX_AUDIO_DURATION_SECONDS__;
export const WIRE_MAX_ATTACHMENT_FILE_NAME_BYTES = __MAX_ATTACHMENT_FILE_NAME_BYTES__;
export const WIRE_MAX_PENDING_ATTACHMENT_COUNT = __MAX_PENDING_ATTACHMENT_COUNT__;
export const WIRE_MAX_PENDING_TOTAL_ATTACHMENT_BYTES = __MAX_PENDING_TOTAL_ATTACHMENT_BYTES__;
export const WIRE_MAX_PENDING_IMAGE_ATTACHMENT_BYTES = __MAX_PENDING_IMAGE_ATTACHMENT_BYTES__;
export const WIRE_MAX_PENDING_DOCUMENT_ATTACHMENT_BYTES = __MAX_PENDING_DOCUMENT_ATTACHMENT_BYTES__;
export const WIRE_MAX_PENDING_AUDIO_ATTACHMENT_BYTES = __MAX_PENDING_AUDIO_ATTACHMENT_BYTES__;
export const WIRE_MAX_PENDING_AUDIO_ATTACHMENT_COUNT = __MAX_PENDING_AUDIO_ATTACHMENT_COUNT__;
export const WIRE_MAX_SKILL_ID_LENGTH = __MAX_SKILL_ID_LENGTH__;
export const WIRE_MAX_ACTIVE_SKILL_COUNT = __MAX_ACTIVE_SKILL_COUNT__;
export const WIRE_CURRENT_AGENT_SETTINGS_SCHEMA_VERSION = __CURRENT_AGENT_SETTINGS_SCHEMA_VERSION__;
export const WIRE_MAX_INTEGRATION_CONNECTIONS = __MAX_INTEGRATION_CONNECTIONS__;
export const WIRE_AUDIO_OUTPUT_LABELS = __AUDIO_OUTPUT_LABELS__;
export const WIRE_MAX_AUDIO_ASSET_BYTES = __MAX_AUDIO_ASSET_BYTES__;
export const WIRE_MAX_AUDIO_ASSET_DURATION_SECONDS = __MAX_AUDIO_ASSET_DURATION_SECONDS__;
export const WIRE_MAX_AUDIO_SESSION_JOBS = __MAX_AUDIO_SESSION_JOBS__;
export const WIRE_SEPARATION_STEMS = __SEPARATION_STEMS__;
export const WIRE_MAX_AUDIO_JOB_TITLE_CHARACTERS = __MAX_AUDIO_JOB_TITLE_CHARACTERS__;
export const WIRE_MAX_AUDIO_JOB_OUTPUTS = __MAX_AUDIO_JOB_OUTPUTS__;
export const WIRE_MAX_PLUGIN_ARCHIVE_BYTES = __MAX_PLUGIN_ARCHIVE_BYTES__;
export const WIRE_MAX_SESSION_TOOL_CATALOG_TOOLS = __MAX_SESSION_TOOL_CATALOG_TOOLS__;
export const WIRE_MAX_SESSION_TOOL_CATALOG_ISSUES = __MAX_SESSION_TOOL_CATALOG_ISSUES__;
export const WIRE_MAX_SESSION_TOOL_CATALOG_DESCRIPTION_LENGTH = __MAX_SESSION_TOOL_CATALOG_DESCRIPTION_LENGTH__;
