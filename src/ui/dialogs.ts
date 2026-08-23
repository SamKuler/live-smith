import resultDialog from "./templates/result-dialog.html";
import chatDialog from "./templates/chat-dialog.html";
import hostAdapterScript from "./client/host-adapter.script.html";
import profileEditorScript from "./client/profile-editor.script.html";
import attachmentsScript from "./client/attachments.script.html";
import bridgeClientScript from "./client/bridge-client.script.html";
import sessionTimelineScript from "./client/session-timeline.script.html";
import skillManagerScript from "./client/skill-manager.script.html";
import bootstrapScript from "./client/bootstrap.script.html";
import type { ChatBridgeState } from "./chat-state.js";
import { composeChatDocument } from "./chat-document.js";

declare const __LIVE_SMITH_MARKDOWN_RENDERER_SCRIPT__: string;

export function resultUrl(title: string, body: string): string {
  return toDataUrl(
    resultDialog
      .replace("__HOST_ADAPTER_SCRIPT__", () => hostAdapterScript)
      .replace("__TITLE__", () => escapeHtml(title))
      .replace("__BODY__", () => escapeHtml(body)),
  );
}

export function chatHtml(
  state: ChatBridgeState,
  bridge: { baseUrl: string; token: string },
): string {
  return composeChatDocument(chatDialog, state, bridge, {
    attachments: attachmentsScript,
    bootstrap: bootstrapScript,
    bridgeClient: bridgeClientScript,
    hostAdapter: hostAdapterScript,
    markdownRenderer: __LIVE_SMITH_MARKDOWN_RENDERER_SCRIPT__,
    profileEditor: profileEditorScript,
    sessionTimeline: sessionTimelineScript,
    skillManager: skillManagerScript,
  });
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
