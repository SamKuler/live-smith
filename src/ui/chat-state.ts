import { safeAttachmentDisplayFileName } from "../attachments/contracts.js";
import type { ConversationScope } from "../model/contracts.js";
import type {
  InputCapabilityEvidence,
  ModelCapabilities,
  ModelInfo,
  ManagedAuthState,
  RuntimeProfile,
} from "../model/provider.js";
import {
  profileApiMode,
  profileProvider,
  type ApiFamily,
  type ApiMode,
  type DraftProfile,
  type ModelConnection,
  type SavedProfile,
} from "../model/profile.js";
import { cloneJsonValue } from "../model/json-clone.js";
import type { ApprovalMode } from "../model/profile.js";
import type { SessionEvent } from "../storage/events.js";
import type { SessionAttachmentRef } from "../storage/attachments.js";
import type { AgentSession } from "../storage/sessions.js";
import type { AgentSettings } from "../storage/settings.js";
import type { SkillSummary } from "../skills/format.js";

export interface ChatDialogState {
  contextSummary: string;
  sessionContinueTarget: {
    kind: ConversationScope["kind"];
    label: string;
  };
  sessions: AgentSession[];
  previousSessions: AgentSession[];
  archivedSessions: AgentSession[];
  activeSessionId: string;
  approvalMode: ApprovalMode;
  events: ChatSessionEvent[];
  pendingAttachments: SessionAttachmentRef[];
  availableSkills: SkillSummary[];
  activeSkillIds: string[];
  capabilities: ModelCapabilities;
  availableModels: ModelInfo[];
  modelStateSource: ChatModelStateSource | null;
  runtimeProfile: ChatRuntimeSummary | null;
  settings: AgentSettings;
  /** Credential-free state from the isolated official Codex runtime. */
  codexAuth?: ManagedAuthState;
  openSettingsOnLoad: boolean;
  status?: string | undefined;
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

/** Converts storage-backed attachment names into the complete browser wire view. */
export function chatDialogStateForWire<State extends ChatDialogState>(
  state: State,
): State {
  return {
    ...state,
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
    apiFamily: ApiFamily;
    apiMode: ApiMode | null;
    model: string;
  };
  capabilities: ModelCapabilities;
  inputCapabilityEvidence: InputCapabilityEvidence;
}

export type ChatSessionActivityStatus =
  | "running"
  | "waiting_confirmation"
  | "completed"
  | "failed"
  | "stopped";

export interface ChatSessionActivity {
  sessionId: string;
  status: ChatSessionActivityStatus;
  message?: string;
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
  return {
    profileId: profile.id,
    connection: profile.connection.kind === "direct-api"
      ? {
          ...cloneJsonValue(profile.connection),
          baseUrl: profile.connection.baseUrl.trim().replace(/\/+$/, ""),
          apiKey: profile.connection.apiKey.trim(),
        }
      : cloneJsonValue(profile.connection),
    model: profile.model.trim(),
  };
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
      model: profile.model,
    },
    capabilities,
    inputCapabilityEvidence: runtimeProfile.inputCapabilityEvidence,
  };
}

export function serializeChatStateForHtml(state: ChatBridgeState): string {
  return JSON.stringify(state)
    .replaceAll("<", "\\u003C")
    .replaceAll(">", "\\u003E")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}
