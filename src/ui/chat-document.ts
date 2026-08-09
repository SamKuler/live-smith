import {
  serializeChatStateForHtml,
  type ChatDialogState,
} from "./chat-state.js";

export interface ChatClientScripts {
  attachments: string;
  bootstrap: string;
  bridgeClient: string;
  capabilityPreview: string;
  hostAdapter: string;
  markdownRenderer: string;
  profileEditor: string;
  sessionTimeline: string;
}

export function composeChatDocument(
  template: string,
  state: ChatDialogState,
  bridge: { baseUrl: string; token: string },
  scripts: ChatClientScripts,
): string {
  const document = template
    .replace("__STATE__", () => serializeChatStateForHtml(state))
    .replace("__BRIDGE__", () => JSON.stringify(bridge))
    .replace("__HOST_ADAPTER_SCRIPT__", () => scripts.hostAdapter)
    .replace("__PROFILE_EDITOR_SCRIPT__", () => scripts.profileEditor)
    .replace("__ATTACHMENTS_SCRIPT__", () => scripts.attachments)
    .replace("__BRIDGE_CLIENT_SCRIPT__", () => scripts.bridgeClient)
    .replace("__CAPABILITY_PREVIEW_SCRIPT__", () => scripts.capabilityPreview)
    .replace("__MARKDOWN_RENDERER_SCRIPT__", () => scripts.markdownRenderer)
    .replace("__SESSION_TIMELINE_SCRIPT__", () => scripts.sessionTimeline)
    .replace("__BOOTSTRAP_SCRIPT__", () => scripts.bootstrap);

  if (/__(?:STATE|BRIDGE|HOST_ADAPTER_SCRIPT|PROFILE_EDITOR_SCRIPT|ATTACHMENTS_SCRIPT|BRIDGE_CLIENT_SCRIPT|CAPABILITY_PREVIEW_SCRIPT|MARKDOWN_RENDERER_SCRIPT|SESSION_TIMELINE_SCRIPT|BOOTSTRAP_SCRIPT)__/.test(document)) {
    throw new Error("Chat document composition left an unresolved placeholder.");
  }
  return document;
}
