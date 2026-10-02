import type { AudioParameterPanel } from "../plugins/builtins/parameter-panel.js";
import type { MidiContinuationView } from "../agent/midi-continuation-contracts.js";
import { safeAttachmentDisplayFileName } from "../attachments/contracts.js";
import type { AudioJobView } from "../audio-services/contracts.js";
import { isStandaloneMcpConnection, type IntegrationConnectionsView } from "../plugins/integration-connections.js";
import type { SunoAccountView } from "../audio-services/suno/suno-session-contracts.js";
import type { LiveContextPresentation } from "../live/context.js";
import type { ConversationScope } from "../model/contracts.js";
import type {
  DiscoveredModelInfo,
  InputCapabilityEvidence,
  ModelCapabilityEvidence,
  ModelCapabilities,
  ModelInfo,
  OAuthAuthState,
  RuntimeProfile,
} from "../model/provider.js";
import {
  profileApiMode,
  profileProvider,
  type ApiFamily,
  type ApiMode,
  type DraftProfile,
  type ModelConnection,
  type OAuthSubscriptionProvider,
  type ReasoningSettings,
  type SavedProfile,
} from "../model/profile.js";
import { cloneJsonValue } from "../model/json-clone.js";
import type { ApprovalMode } from "../model/profile.js";
import type { SessionEvent } from "../storage/events.js";
import type { SessionAttachmentRef } from "../storage/attachments.js";
import type { AgentSession } from "../storage/sessions.js";
import type { AgentSettings } from "../storage/settings.js";
import type { AvailableSkillSummary } from "../skills/builtins.js";
import type { InstalledPluginView } from "../plugins/view.js";
import { pluginConfigView } from "../plugins/user-config.js";
import type { PluginAppDescriptor } from "../plugins/mcp/apps.js";
import type { PluginToolIssue } from "../plugins/contracts.js";
import type { PluginParameterPanel } from "../plugins/parameter-panel.js";
import type { UiMessage } from "../i18n/ui-message.js";

export const MAX_TRANSIENT_ASSISTANT_DRAFT_BYTES = 1024 * 1024;
export const MAX_SESSION_TOOL_CATALOG_TOOLS = 512;
export const MAX_SESSION_TOOL_CATALOG_ISSUES = 256;
export const MAX_SESSION_TOOL_CATALOG_DESCRIPTION_LENGTH = 512;

export interface ChatSessionSummary extends AgentSession {
  /** Derived display metadata; never part of the stored Session record. */
  hasContent?: boolean;
}

export type ChatLiveContext =
  | { sessionId: string; availability: "available"; value: LiveContextPresentation }
  | { sessionId: string; availability: "unavailable"; label: string };

export interface SunoModelCatalogView {
  serviceId: string;
  accountId: string;
  integrationConnectionsRevision: string;
  models: Array<{ id: string; name: string; canUse?: boolean; isDefault?: boolean }>;
}

export interface SessionToolCatalog {
  sessionId: string;
  loadedAt: string;
  modelToolsSupported: boolean;
  truncated: boolean;
  groups: Array<{
    kind: "live" | "audio" | "mcp";
    pluginId?: string;
    serverId?: string;
    connectionId?: string;
    connectionName?: string;
    tools: Array<{ name: string; description: string; panel?: PluginParameterPanel; audioPanel?: AudioParameterPanel; app?: PluginAppDescriptor }>;
  }>;
  issues: PluginToolIssue[];
}

export interface ChatDialogState {
  mcpOAuthStates?: import("../plugins/mcp/oauth-contract.js").McpOAuthState[];
  contextSummary: string;
  liveContext: ChatLiveContext;
  sessionContinueTarget: {
    kind: ConversationScope["kind"];
    label: string;
  };
  sessions: ChatSessionSummary[];
  previousSessions: ChatSessionSummary[];
  archivedSessions: ChatSessionSummary[];
  activeSessionId: string;
  approvalMode: ApprovalMode;
  events: ChatSessionEvent[];
  pendingAttachments: SessionAttachmentRef[];
  availableSkills: AvailableSkillSummary[];
  plugins: InstalledPluginView[];
  activeSkillIds: string[];
  capabilities: ModelCapabilities;
  capabilityEvidence: ModelCapabilityEvidence;
  availableModels: ModelInfo[];
  /** Command receipt for the latest confirmed explicit model-catalog load. */
  modelCatalogLoadReceipt?: string;
  configuredModels: ChatConfiguredModel[];
  configuredModelsReady: boolean;
  modelStateSource: ChatModelStateSource | null;
  runtimeProfile: ChatRuntimeSummary | null;
  /** SHA-256 of the normalized active Saved Profile, or null with no active Profile. */
  activeProfileRevision: string | null;
  settings: AgentSettings;
  integrationConnections?: IntegrationConnectionsView;
  audioJobs?: AudioJobView[];
  midiContinuation?: MidiContinuationView;
  /** Imported website-session evidence, not a generation capability or credential. */
  sunoAccounts?: SunoAccountView[];
  /** Modal-only catalog for one saved connection; omission clears prior results. */
  sunoModelCatalog?: SunoModelCatalogView;
  /** Explicit, dialog-local discovery snapshot; never persisted. */
  sessionToolCatalog?: SessionToolCatalog;
  /** Credential-free state for the selected native OAuth provider. */
  oauthAuth?: OAuthAuthState;
  oauthAuthProfileId?: string;
  oauthAuthProvider?: OAuthSubscriptionProvider;
  /** Non-sensitive process-local epoch for subscription catalog ownership. */
  oauthAuthGeneration: number;
  openSettingsOnLoad: boolean;
  status?: UiMessage | undefined;
  sessionActivities?: ChatSessionActivity[];
}

export interface ChatSessionEvent extends Omit<SessionEvent, "steeringReceipt"> {
  /** Durable steering correlation projected without storage-only content hashes. */
  steeringAck?: {
    sendId: string;
    steerId: string;
  };
}

export function chatSessionEvent(
  event: SessionEvent | ChatSessionEvent,
): ChatSessionEvent {
  const { steeringReceipt, attachments, ...projected } = event as SessionEvent;
  return {
    ...projected,
    ...(attachments === undefined
      ? {}
      : {
          attachments: attachments.map(attachmentForDisplay),
        }),
    ...(steeringReceipt === undefined
      ? {}
      : {
          steeringAck: {
            sendId: steeringReceipt.sendId,
            steerId: steeringReceipt.id,
          },
        }),
  };
}

/** Creates public browser projections of host-owned state. */
export function chatDialogStateForWire<State extends ChatDialogState>(
  state: State,
): State {
  const settings = state.settings && { ...state.settings };
  if (settings) delete settings.integrationConnections;
  return {
    ...state,
    ...(settings ? { settings } : {}),
    ...(state.mcpOAuthStates ? { mcpOAuthStates: state.mcpOAuthStates.map(({ connectionId, status, generation }) => ({ connectionId, status, generation })) } : {}),
    ...(Array.isArray(state.plugins) ? { plugins: state.plugins.map((plugin) => ({
      id: plugin.id,
      sha256: plugin.sha256,
      ...(plugin.version === undefined ? {} : { version: plugin.version }),
      ...(plugin.description === undefined ? {} : { description: plugin.description }),
      sourceFormat: plugin.sourceFormat,
      enabled: plugin.enabled,
      skillCount: plugin.skillCount,
      ...(plugin.skills === undefined ? {} : { skills: plugin.skills.map(({ id, description }) => ({ id, description })) }),
      mcpServers: plugin.mcpServers.map((server) => ({
        id: server.id,
        type: server.type,
        approved: server.approved,
        artifactInputApproved: server.artifactInputApproved,
        artifactOutputApproved: server.artifactOutputApproved,
        target: server.target,
        ...(server.args === undefined ? {} : { args: [...server.args] }),
        ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
        ...(server.envNames === undefined ? {} : { envNames: [...server.envNames] }),
        credentialFields: server.credentialFields.map(({ name, required }) => ({ name, required })),
      })),
      unsupportedComponents: [...plugin.unsupportedComponents],
      issues: [...plugin.issues],
      ...(plugin.userConfig ? { userConfig: {
        ...pluginConfigView(plugin.userConfig.fields, { revision: plugin.userConfig.revision,
          values: plugin.userConfig.values, secrets: {} }),
        configuredSecrets: [...plugin.userConfig.configuredSecrets], invalidFields: [...plugin.userConfig.invalidFields],
      } } : {}),
    })) } : {}),
    ...(state.sunoModelCatalog === undefined ? {} : { sunoModelCatalog: {
      serviceId: state.sunoModelCatalog.serviceId,
      accountId: state.sunoModelCatalog.accountId,
      integrationConnectionsRevision: state.sunoModelCatalog.integrationConnectionsRevision,
      models: state.sunoModelCatalog.models.slice(0, 100).map(({ id, name, canUse, isDefault }) => ({
        id, name,
        ...(typeof canUse === "boolean" ? { canUse } : {}),
        ...(typeof isDefault === "boolean" ? { isDefault } : {}),
      })),
    } }),
    ...(state.sessionToolCatalog === undefined ? {} : { sessionToolCatalog: {
      sessionId: state.sessionToolCatalog.sessionId,
      loadedAt: state.sessionToolCatalog.loadedAt,
      modelToolsSupported: state.sessionToolCatalog.modelToolsSupported,
      truncated: state.sessionToolCatalog.truncated,
      groups: state.sessionToolCatalog.groups.map((group) => ({
        kind: group.kind,
        ...(group.pluginId === undefined ? {} : { pluginId: group.pluginId }),
        ...(group.serverId === undefined ? {} : { serverId: group.serverId }),
        ...(group.connectionId === undefined ? {} : { connectionId: group.connectionId }),
        ...(group.connectionName === undefined ? {} : { connectionName: group.connectionName }),
        tools: group.tools.map(({ name, description, panel, app, audioPanel }) => ({ name, description,
          ...(audioPanel ? { audioPanel: { toolName: audioPanel.toolName, signature: audioPanel.signature,
            ...(audioPanel.connectionId === undefined ? {} : { connectionId: audioPanel.connectionId }),
            schema: cloneJsonValue(audioPanel.schema),
            ...(audioPanel.suggestions ? { suggestions: cloneJsonValue(audioPanel.suggestions) } : {}),
          } } : {}),
          ...(app ? { app: { resourceUri: app.resourceUri, signature: app.signature, toolName: app.toolName } } : {}),
          ...(panel === undefined ? {} : { panel: {
            toolName: panel.toolName, signature: panel.signature,
            fields: panel.fields.map((field) => ({
              name: field.name, title: field.title, type: field.type, required: field.required,
              ...Object.fromEntries([
                "description", "default", "enum", "minimum", "maximum", "exclusiveMinimum",
                "exclusiveMaximum", "multipleOf", "minLength", "maxLength",
              ].filter((key) => Object.hasOwn(field, key)).map((key) => [key, field[key as keyof typeof field]])),
            })),
          } }),
        })),
      })),
      issues: state.sessionToolCatalog.issues.map(({ pluginId, connectionId, serverId, code, message }) => ({
        ...(pluginId === undefined ? {} : { pluginId }),
        ...(connectionId === undefined ? {} : { connectionId }),
        ...(serverId === undefined ? {} : { serverId }),
        code,
        message,
      })),
    } }),
    ...(state.sunoAccounts === undefined ? {} : { sunoAccounts: state.sunoAccounts.map(({ serviceId, status, accountId, accountName }) => ({
      serviceId, status,
      ...((status === "signed_in" || status === "saved") && accountId ? { accountId } : {}),
      ...((status === "signed_in" || status === "saved") && accountName ? { accountName } : {}),
    })) }),
    ...(state.integrationConnections === undefined ? {} : { integrationConnections: {
      revision: state.integrationConnections.revision,
      ...(state.integrationConnections.lastChangeTouchesAudio === undefined ? {} : {
        lastChangeTouchesAudio: state.integrationConnections.lastChangeTouchesAudio,
      }),
      connections: state.integrationConnections.connections.map((connection) => ({
        id: connection.id,
        name: connection.name,
        enabled: connection.enabled,
        ...(isStandaloneMcpConnection(connection) ? {
          mcp: connection.mcp.type === "stdio" ? {
            type: connection.mcp.type,
            command: connection.mcp.command,
            args: [...connection.mcp.args],
            ...(connection.mcp.cwd === undefined ? {} : { cwd: connection.mcp.cwd }),
          } : { type: connection.mcp.type, url: connection.mcp.url },
          artifactInputApproved: connection.artifactInputApproved,
          artifactOutputApproved: connection.artifactOutputApproved,
        } : {
          pluginId: connection.pluginId,
          configuration: { ...connection.configuration },
        }),
        ...(connection.oauth === undefined ? {} : { oauth: {
          ...(connection.oauth.clientId === undefined ? {} : { clientId: connection.oauth.clientId }),
          ...(connection.oauth.callbackPort === undefined ? {} : { callbackPort: connection.oauth.callbackPort }),
        } }),
        configuredSecrets: [...connection.configuredSecrets],
      })),
    } }),
    ...(Array.isArray(state.events)
      ? { events: state.events.map(chatSessionEvent) }
      : {}),
    ...(Array.isArray(state.pendingAttachments)
      ? {
          pendingAttachments: state.pendingAttachments.map(attachmentForDisplay),
        }
      : {}),
  } as State;
}

function attachmentForDisplay<Attachment extends { fileName: string }>(
  attachment: Attachment,
): Attachment {
  return {
    ...attachment,
    fileName: safeAttachmentDisplayFileName(attachment.fileName),
  };
}

/** Wire projection ordered only within one modal bridge. */
export interface ChatBridgeState extends ChatDialogState {
  /** Publication identity; it does not imply that the snapshot is fresh. */
  bridgeStateRevision: string;
  /** Latest projection patch that this snapshot is guaranteed to include. */
  bridgeStateCoveredThroughRevision: string;
}

/** Credential-free projection used only to render the active runtime header. */
export interface ChatRuntimeSummary {
  profile: {
    id: string;
    name: string;
    connectionKind: ModelConnection["kind"];
    apiFamily: ApiFamily | OAuthSubscriptionProvider;
    apiMode: ApiMode | null;
  };
  selection: {
    model: string;
    reasoning: ReasoningSettings;
  };
  capabilities: ModelCapabilities;
  inputCapabilityEvidence: InputCapabilityEvidence;
}

export interface ChatConfiguredModel {
  model: string;
  label: string;
}

export type ChatSessionActivityStatus =
  | "running"
  | "waiting_confirmation"
  | "completed"
  | "failed"
  | "stopped";

export interface ChatSessionActivity {
  sessionId: string;
  /** Correlates send-owned terminal activity with the exact request attempt. */
  sendId?: string;
  status: ChatSessionActivityStatus;
  message?: UiMessage;
  unread: boolean;
}

export interface ChatModelStateSource {
  profileId: string;
  connection: ModelConnection;
  model: string;
}

export function modelStateSourceForProfile(
  profile: DraftProfile | SavedProfile,
): ChatModelStateSource {
  const previewModel = profile.models.find(
    (model) => model.model === profile.defaultModel,
  ) ?? profile.models[0];
  return {
    profileId: profile.id,
    connection: profile.connection.kind === "direct-api"
      ? {
          ...cloneJsonValue(profile.connection),
          baseUrl: profile.connection.baseUrl.trim().replace(/\/+$/, ""),
          apiKey: profile.connection.apiKey.trim(),
        }
      : cloneJsonValue(profile.connection),
    model: previewModel?.model.trim() ?? profile.defaultModel.trim(),
  };
}

export function chatConfiguredModels(
  profile: SavedProfile,
  discoveredModels: DiscoveredModelInfo[],
): ChatConfiguredModel[] {
  const labels = new Map(
    discoveredModels.map((model) => [model.id, model.displayName] as const),
  );
  return profile.models.map((model) => ({
    model: model.model,
    label: labels.get(model.model) || model.model,
  }));
}

export function chatRuntimeSummary(
  runtimeProfile: RuntimeProfile,
): ChatRuntimeSummary {
  const { profile, capabilities } = runtimeProfile;
  return {
    profile: {
      id: profile.id,
      name: profile.name,
      connectionKind: profile.connection.kind,
      apiFamily: profileProvider(profile),
      apiMode: profileApiMode(profile),
    },
    selection: {
      model: runtimeProfile.model.model,
      reasoning: cloneJsonValue(runtimeProfile.model.parameters.reasoning),
    },
    capabilities,
    inputCapabilityEvidence: runtimeProfile.inputCapabilityEvidence,
  };
}

export function serializeChatStateForHtml(state: ChatBridgeState): string {
  return JSON.stringify(chatDialogStateForWire(state))
    .replaceAll("<", "\\u003C")
    .replaceAll(">", "\\u003E")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}
