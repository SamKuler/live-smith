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
import type { UiLanguage } from "../i18n/languages.js";
import type { UiMessage } from "../i18n/ui-message.js";
import { composeResultDocument } from "./result-document.js";
import bootstrapScript from "./client/bootstrap.script.html";
import type { ChatBridgeState } from "./chat-state.js";
import { composeChatDocument } from "./chat-document.js";

declare const __LIVE_SMITH_MARKDOWN_RENDERER_SCRIPT__: string;
declare const __LIVE_SMITH_PLUGIN_APPS_SCRIPT__: string;
declare const __LIVE_SMITH_AUDIO_PARAMETERS_SCRIPT__: string;
declare const __LIVE_SMITH_BRIDGE_CONTRACTS_SCRIPT__: string;
declare const __LIVE_SMITH_CHAT_STYLES__: string;
declare const __LIVE_SMITH_RESULT_STYLES__: string;

export function resultUrl(body: UiMessage, uiLanguage: UiLanguage): string {
  return toDataUrl(composeResultDocument(resultDialog, body, uiLanguage, {
    hostAdapter: hostAdapterScript,
    i18n: i18nScript,
  }, __LIVE_SMITH_RESULT_STYLES__));
}

export function chatHtml(
  state: ChatBridgeState,
  bridge: { baseUrl: string; token: string; viewId?: string; hostMode?: "modal" | "browser" | "native"; nativeWindowAvailable?: boolean; nativeArtifactDrag?: boolean },
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
