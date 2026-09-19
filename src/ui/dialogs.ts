import resultDialog from "./templates/result-dialog.html";
import chatDialog from "./templates/chat-dialog.html";
import hostAdapterScript from "./client/host-adapter.script.html";
import profileEditorScript from "./client/profile-editor.script.html";
import attachmentsScript from "./client/attachments.script.html";
import composerInputScript from "./client/composer-input.script.html";
import bridgeClientScript from "./client/bridge-client.script.html";
import sessionTimelineScript from "./client/session-timeline.script.html";
import skillManagerScript from "./client/skill-manager.script.html";
import pluginManagerScript from "./client/plugin-manager.script.html";
import actionPreviewScript from "./client/action-preview.script.html";
import i18nScript from "./client/i18n.script.html";
import { serializeUiI18nData } from "./i18n/messages.js";
import bootstrapScript from "./client/bootstrap.script.html";
import type { ChatBridgeState } from "./chat-state.js";
import { composeChatDocument } from "./chat-document.js";

declare const __LIVE_SMITH_MARKDOWN_RENDERER_SCRIPT__: string;
declare const __LIVE_SMITH_CHAT_STYLES__: string;
declare const __LIVE_SMITH_RESULT_STYLES__: string;

export function resultUrl(title: string, body: string): string {
  return toDataUrl(
    resultDialog
      .replace("/*__RESULT_STYLES__*/", () => __LIVE_SMITH_RESULT_STYLES__)
      .replace("__HOST_ADAPTER_SCRIPT__", () => hostAdapterScript)
      .replace("__I18N_SCRIPT__", () => i18nScript.replace("__UI_I18N__", () => serializeUiI18nData()))
      .replace("__TITLE__", () => escapeHtml(title))
      .replace("__BODY__", () => escapeHtml(body)),
  );
}

export function chatHtml(
  state: ChatBridgeState,
  bridge: { baseUrl: string; token: string },
): string {
  return composeChatDocument(chatDialog, state, bridge, {
    actionPreview: actionPreviewScript,
    i18n: i18nScript,
    attachments: attachmentsScript,
    bootstrap: bootstrapScript,
    bridgeClient: bridgeClientScript,
    composerInput: composerInputScript,
    hostAdapter: hostAdapterScript,
    markdownRenderer: __LIVE_SMITH_MARKDOWN_RENDERER_SCRIPT__,
    profileEditor: profileEditorScript,
    pluginManager: pluginManagerScript,
    sessionTimeline: sessionTimelineScript,
    skillManager: skillManagerScript,
  }, __LIVE_SMITH_CHAT_STYLES__);
}

function toDataUrl(html: string): string {
  return `data:text/html,${encodeURIComponent(html)}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
