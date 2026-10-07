import audioResultsScript from "./client/audio-results.script.html";
import resultDialog from "./templates/result-dialog.html";
import chatDialog from "./templates/chat-dialog.html";
import hostAdapterScript from "./client/host-adapter.script.html";
import profileEditorScript from "./client/profile-editor.script.html";
import attachmentsScript from "./client/attachments.script.html";
import attachmentMediaScript from "./client/attachment-media.script.html";
import attachmentViewerScript from "./client/attachment-viewer.script.html";
import composerInputScript from "./client/composer-input.script.html";
import bridgeClientScript from "./client/bridge-client.script.html";
import sessionTimelineScript from "./client/session-timeline.script.html";
import skillManagerScript from "./client/skill-manager.script.html";
import pluginManagerScript from "./client/plugin-manager.script.html";
import connectionsManagerScript from "./client/connections-manager.script.html";
import toolsInspectorScript from "./client/tools-inspector.script.html";
import pluginParametersScript from "./client/plugin-parameters.script.html";
import pluginUserConfigScript from "./client/plugin-user-config.script.html";
import i18nScript from "./client/i18n.script.html";
import { serializeUiI18nData } from "./i18n/messages.js";
import bootstrapScript from "./client/bootstrap.script.html";
import type { ChatBridgeState } from "./chat-state.js";
import { composeChatDocument } from "./chat-document.js";

declare const __LIVE_SMITH_MARKDOWN_RENDERER_SCRIPT__: string;
declare const __LIVE_SMITH_PLUGIN_APPS_SCRIPT__: string;
declare const __LIVE_SMITH_AUDIO_PARAMETERS_SCRIPT__: string;
declare const __LIVE_SMITH_BRIDGE_CONTRACTS_SCRIPT__: string;
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
  bridge: { baseUrl: string; token: string; hostMode?: "modal" | "browser" },
): string {
  return composeChatDocument(chatDialog, state, bridge, {
    i18n: i18nScript,
    attachments: attachmentsScript,
    attachmentMedia: attachmentMediaScript,
    attachmentViewer: attachmentViewerScript,
    bootstrap: bootstrapScript,
    bridgeClient: bridgeClientScript,
    audioResults: audioResultsScript,
    composerInput: composerInputScript,
    hostAdapter: hostAdapterScript,
    markdownRenderer: __LIVE_SMITH_MARKDOWN_RENDERER_SCRIPT__,
    pluginApps: __LIVE_SMITH_PLUGIN_APPS_SCRIPT__,
    audioParameters: __LIVE_SMITH_AUDIO_PARAMETERS_SCRIPT__,
    bridgeContracts: __LIVE_SMITH_BRIDGE_CONTRACTS_SCRIPT__,
    profileEditor: profileEditorScript,
    pluginManager: pluginManagerScript,
    pluginParameters: pluginParametersScript,
    pluginUserConfig: pluginUserConfigScript,
    connectionsManager: connectionsManagerScript,
    sessionTimeline: sessionTimelineScript,
    skillManager: skillManagerScript,
    toolsInspector: toolsInspectorScript,
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
