import { serializeUiI18nData } from "./i18n/messages.js";
import {
  MAX_TRANSIENT_ASSISTANT_DRAFT_BYTES,
  serializeChatStateForHtml,
  type ChatBridgeState,
} from "./chat-state.js";
import {
  MAX_ATTACHMENT_FILE_NAME_BYTES,
  MAX_AUDIO_ATTACHMENT_BYTES,
  MAX_AUDIO_DURATION_SECONDS,
  MAX_DOCUMENT_ATTACHMENT_BYTES,
  MAX_IMAGE_ATTACHMENT_BYTES,
  MAX_PENDING_ATTACHMENT_BYTES,
  MAX_PENDING_ATTACHMENT_COUNT,
  MAX_PENDING_AUDIO_ATTACHMENT_BYTES,
  MAX_PENDING_AUDIO_ATTACHMENT_COUNT,
  MAX_PENDING_DOCUMENT_ATTACHMENT_BYTES,
  MAX_PENDING_IMAGE_ATTACHMENT_BYTES,
} from "../attachments/contracts.js";
import {
  MAX_ACTIVE_SKILL_COUNT,
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_ID_LENGTH,
  type SkillDefinition,
} from "../skills/format.js";
import { builtInSkillDefinitions } from "../skills/builtins.js";
import {
  MAX_DISCOVERED_MODEL_COUNT,
  MAX_DISCOVERED_MODEL_CONTEXT_WINDOW_TOKENS,
  MAX_DISCOVERED_MODEL_DISPLAY_NAME_CODE_POINTS,
  MAX_DISCOVERED_MODEL_ID_CODE_POINTS,
  MAX_DISCOVERED_MODEL_OUTPUT_TOKENS,
} from "../model/catalog.js";
import { MAX_PROFILE_MODEL_COUNT } from "../model/profile.js";
import { HOSTED_WEB_SEARCH_MAX_EVENTS_PER_SEND } from "../model/tools.js";
import { EDIT_SCOPES, EDIT_SCOPE_LABELS } from "../agent/edit-scopes.js";
import { MAX_RECOVERY_ACTION_DIGESTS } from "../agent/recovery-contract.js";
import { MAX_SESSION_TITLE_CODE_POINTS } from "../storage/sessions.js";
import { MAX_MIDI_PREVIEW_NOTES, MAX_PARAMETER_PREVIEW_VALUE_ITEMS } from "../agent/action-preview.js";
import { SEPARATION_STEMS, MAX_AUDIO_ASSET_BYTES, MAX_AUDIO_ASSET_DURATION_SECONDS,
  MAX_AUDIO_SESSION_JOBS, MAX_AUDIO_JOB_OUTPUTS, MAX_AUDIO_SERVICES, MAX_AUDIO_JOB_TITLE_CHARACTERS,
  AUDIO_OUTPUT_LABELS } from "../audio-services/contracts.js";

import { AUDIO_SERVICE_CAPABILITIES } from "../audio-services/capabilities.js";

export interface ChatClientScripts {
  actionPreview: string;
  i18n: string;
  attachments: string;
  bootstrap: string;
  bridgeClient: string;
  composerInput: string;
  hostAdapter: string;
  markdownRenderer: string;
  profileEditor: string;
  sessionTimeline: string;
  skillManager: string;
}

function injectAttachmentContract(script: string): string {
  return script
    .replaceAll(
      "__MAX_ATTACHMENT_FILE_NAME_BYTES__",
      String(MAX_ATTACHMENT_FILE_NAME_BYTES),
    )
    .replaceAll(
      "__MAX_AUDIO_DURATION_SECONDS__",
      String(MAX_AUDIO_DURATION_SECONDS),
    )
    .replaceAll(
      "__MAX_IMAGE_ATTACHMENT_BYTES__",
      String(MAX_IMAGE_ATTACHMENT_BYTES),
    )
    .replaceAll(
      "__MAX_AUDIO_ATTACHMENT_BYTES__",
      String(MAX_AUDIO_ATTACHMENT_BYTES),
    )
    .replaceAll(
      "__MAX_PENDING_ATTACHMENT_COUNT__",
      String(MAX_PENDING_ATTACHMENT_COUNT),
    )
    .replaceAll(
      "__MAX_PENDING_IMAGE_ATTACHMENT_BYTES__",
      String(MAX_PENDING_IMAGE_ATTACHMENT_BYTES),
    )
    .replaceAll(
      "__MAX_PENDING_DOCUMENT_ATTACHMENT_BYTES__",
      String(MAX_PENDING_DOCUMENT_ATTACHMENT_BYTES),
    )
    .replaceAll(
      "__MAX_PENDING_AUDIO_ATTACHMENT_BYTES__",
      String(MAX_PENDING_AUDIO_ATTACHMENT_BYTES),
    )
    .replaceAll(
      "__MAX_PENDING_AUDIO_ATTACHMENT_COUNT__",
      String(MAX_PENDING_AUDIO_ATTACHMENT_COUNT),
    )
    .replaceAll(
      "__MAX_DOCUMENT_ATTACHMENT_BYTES__",
      String(MAX_DOCUMENT_ATTACHMENT_BYTES),
    )
    .replaceAll(
      "__MAX_PENDING_TOTAL_ATTACHMENT_BYTES__",
      String(MAX_PENDING_ATTACHMENT_BYTES),
    );
}

function injectSkillContract(script: string): string {
  return script
    .replaceAll(
      "__MAX_ACTIVE_SKILL_COUNT__",
      String(MAX_ACTIVE_SKILL_COUNT),
    )
    .replaceAll(
      "__MAX_SKILL_FILE_BYTES__",
      String(MAX_SKILL_FILE_BYTES),
    )
    .replaceAll(
      "__MAX_SKILL_ID_LENGTH__",
      String(MAX_SKILL_ID_LENGTH),
    );
}

export function injectBuiltInSkillDefinitions(
  script: string,
  definitions: readonly SkillDefinition[],
): string {
  const serialized = JSON.stringify(definitions)
    .replaceAll("<", "\\u003C")
    .replaceAll(">", "\\u003E")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
  return script.replaceAll(
    "__BUILT_IN_SKILL_DEFINITIONS__",
    () => serialized,
  );
}

function injectModelContract(script: string): string {
  return script
    .replaceAll(
      "__MAX_PROFILE_MODEL_COUNT__",
      String(MAX_PROFILE_MODEL_COUNT),
    )
    .replaceAll(
      "__MAX_DISCOVERED_MODEL_COUNT__",
      String(MAX_DISCOVERED_MODEL_COUNT),
    )
    .replaceAll(
      "__MAX_DISCOVERED_MODEL_ID_CODE_POINTS__",
      String(MAX_DISCOVERED_MODEL_ID_CODE_POINTS),
    )
    .replaceAll(
      "__MAX_DISCOVERED_MODEL_DISPLAY_NAME_CODE_POINTS__",
      String(MAX_DISCOVERED_MODEL_DISPLAY_NAME_CODE_POINTS),
    )
    .replaceAll(
      "__MAX_DISCOVERED_MODEL_OUTPUT_TOKENS__",
      String(MAX_DISCOVERED_MODEL_OUTPUT_TOKENS),
    )
    .replaceAll(
      "__MAX_DISCOVERED_MODEL_CONTEXT_WINDOW_TOKENS__",
      String(MAX_DISCOVERED_MODEL_CONTEXT_WINDOW_TOKENS),
    )
    .replaceAll(
      "__HOSTED_WEB_SEARCH_MAX_EVENTS_PER_SEND__",
      String(HOSTED_WEB_SEARCH_MAX_EVENTS_PER_SEND),
    )
    .replaceAll(
      "__MAX_TRANSIENT_ASSISTANT_DRAFT_BYTES__",
      String(MAX_TRANSIENT_ASSISTANT_DRAFT_BYTES),
    );
}

function injectEditScopeContract(script: string): string {
  return script
    .replaceAll("__EDIT_SCOPES__", () => JSON.stringify(EDIT_SCOPES))
    .replaceAll("__EDIT_SCOPE_LABELS__", () => JSON.stringify(EDIT_SCOPE_LABELS));
}

function injectSessionContract(script: string): string {
  return script
    .replaceAll("__AUDIO_SERVICE_CAPABILITIES__", () => JSON.stringify(AUDIO_SERVICE_CAPABILITIES))
    .replaceAll("__MAX_AUDIO_SERVICES__", String(MAX_AUDIO_SERVICES))
    .replaceAll("__SEPARATION_STEMS__", () => JSON.stringify(SEPARATION_STEMS))
    .replaceAll("__AUDIO_OUTPUT_LABELS__", () => JSON.stringify(AUDIO_OUTPUT_LABELS))
    .replaceAll("__MAX_AUDIO_JOB_TITLE_CHARACTERS__", String(MAX_AUDIO_JOB_TITLE_CHARACTERS))
    .replaceAll("__MAX_AUDIO_ASSET_BYTES__", String(MAX_AUDIO_ASSET_BYTES))
    .replaceAll("__MAX_AUDIO_ASSET_DURATION_SECONDS__", String(MAX_AUDIO_ASSET_DURATION_SECONDS))
    .replaceAll("__MAX_AUDIO_SESSION_JOBS__", String(MAX_AUDIO_SESSION_JOBS))
    .replaceAll("__MAX_AUDIO_JOB_OUTPUTS__", String(MAX_AUDIO_JOB_OUTPUTS))
    .replaceAll("__MAX_MIDI_PREVIEW_NOTES__", String(MAX_MIDI_PREVIEW_NOTES))
    .replaceAll("__MAX_PARAMETER_PREVIEW_VALUE_ITEMS__", String(MAX_PARAMETER_PREVIEW_VALUE_ITEMS))
    .replaceAll(
      "__MAX_SESSION_TITLE_CODE_POINTS__",
      String(MAX_SESSION_TITLE_CODE_POINTS),
    )
    .replaceAll(
      "__MAX_RECOVERY_ACTION_DIGESTS__",
      String(MAX_RECOVERY_ACTION_DIGESTS),
    );
}

export function composeChatDocument(
  template: string,
  state: ChatBridgeState,
  bridge: { baseUrl: string; token: string },
  scripts: ChatClientScripts,
  styles = "",
): string {
  const attachmentsScript = injectSessionContract(injectAttachmentContract(scripts.attachments));
  const bridgeClientScript = injectSessionContract(injectEditScopeContract(
    injectModelContract(injectSkillContract(
      injectAttachmentContract(scripts.bridgeClient),
    )),
  ));
  const profileEditorScript = injectModelContract(scripts.profileEditor);
  const skillManagerScript = injectBuiltInSkillDefinitions(
    injectSkillContract(scripts.skillManager),
    builtInSkillDefinitions(),
  );
  const substitutions: Record<string, string> = {
    __STATE__: JSON.stringify(serializeChatStateForHtml(state)),
    __BRIDGE__: JSON.stringify(bridge),
    __HOST_ADAPTER_SCRIPT__: scripts.hostAdapter,
    __I18N_SCRIPT__: scripts.i18n.replace("__UI_I18N__", () => serializeUiI18nData()),
    __PROFILE_EDITOR_SCRIPT__: profileEditorScript,
    __ATTACHMENTS_SCRIPT__: attachmentsScript,
    __COMPOSER_INPUT_SCRIPT__: scripts.composerInput,
    __SKILL_MANAGER_SCRIPT__: skillManagerScript,
    __BRIDGE_CLIENT_SCRIPT__: bridgeClientScript,
    __MARKDOWN_RENDERER_SCRIPT__: scripts.markdownRenderer,
    __SESSION_TIMELINE_SCRIPT__: injectSessionContract(scripts.sessionTimeline),
    __ACTION_PREVIEW_SCRIPT__: scripts.actionPreview,
    __BOOTSTRAP_SCRIPT__: injectEditScopeContract(scripts.bootstrap),
  };
  // Substitute the authored template once; inserted Session data and scripts are not templates.
  return template
    .replace("/*__CHAT_STYLES__*/", () => styles)
    .replace(/__[A-Z0-9_]+__/g, (placeholder) =>
      Object.hasOwn(substitutions, placeholder) ? substitutions[placeholder]! : placeholder);
}
