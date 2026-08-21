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
  defaultPrompt: string;
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
  events: SessionEvent[];
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
  sendId: string;
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
    inputCapabilityEvidence: runtimeProfile.inputCapabilityEvidence ?? {
      image: "unverified",
      audio: "unverified",
      pdf: "unverified",
    },
  };
}

export function serializeChatStateForHtml(state: ChatDialogState): string {
  return JSON.stringify(state)
    .replaceAll("<", "\\u003C")
    .replaceAll(">", "\\u003E")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}
