import {
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
} from "../skills/format.js";
import {
  MAX_DISCOVERED_MODEL_COUNT,
  MAX_DISCOVERED_MODEL_DISPLAY_NAME_CODE_POINTS,
  MAX_DISCOVERED_MODEL_ID_CODE_POINTS,
  MAX_DISCOVERED_MODEL_OUTPUT_TOKENS,
} from "../model/catalog.js";

export interface ChatClientScripts {
  attachments: string;
  bootstrap: string;
  bridgeClient: string;
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

function injectModelCatalogContract(script: string): string {
  return script
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
    );
}

export function composeChatDocument(
  template: string,
  state: ChatBridgeState,
  bridge: { baseUrl: string; token: string },
  scripts: ChatClientScripts,
): string {
  const attachmentsScript = injectAttachmentContract(scripts.attachments);
  const bridgeClientScript = injectModelCatalogContract(injectSkillContract(
    injectAttachmentContract(scripts.bridgeClient),
  ));
  const skillManagerScript = injectSkillContract(scripts.skillManager);
  const document = template
    .replace(
      "__STATE__",
      () => JSON.stringify(serializeChatStateForHtml(state)),
    )
    .replace("__BRIDGE__", () => JSON.stringify(bridge))
    .replace("__HOST_ADAPTER_SCRIPT__", () => scripts.hostAdapter)
    .replace("__PROFILE_EDITOR_SCRIPT__", () => scripts.profileEditor)
    .replace("__ATTACHMENTS_SCRIPT__", () => attachmentsScript)
    .replace("__SKILL_MANAGER_SCRIPT__", () => skillManagerScript)
    .replace("__BRIDGE_CLIENT_SCRIPT__", () => bridgeClientScript)
    .replace("__MARKDOWN_RENDERER_SCRIPT__", () => scripts.markdownRenderer)
    .replace("__SESSION_TIMELINE_SCRIPT__", () => scripts.sessionTimeline)
    .replace("__BOOTSTRAP_SCRIPT__", () => scripts.bootstrap);

  if (/__(?:STATE|BRIDGE|HOST_ADAPTER_SCRIPT|PROFILE_EDITOR_SCRIPT|ATTACHMENTS_SCRIPT|SKILL_MANAGER_SCRIPT|BRIDGE_CLIENT_SCRIPT|MARKDOWN_RENDERER_SCRIPT|SESSION_TIMELINE_SCRIPT|BOOTSTRAP_SCRIPT)__/.test(document)) {
    throw new Error("Chat document composition left an unresolved placeholder.");
  }
  return document;
}
