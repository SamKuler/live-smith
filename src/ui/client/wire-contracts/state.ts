import type { ChatBridgeState } from "../../chat-state.js";
import { maximumDiscoveredModelCount, maximumProfileModelCount } from "./contracts.js";
import {
  isWireApprovalMode,
  isWireAgentSettings,
  isWireConfiguredModel,
  isWireModelCapabilities,
  isWireModelCapabilityEvidence,
  isWireModelInfo,
  isWireModelStateSource,
  isWireOAuthAuth,
  isWireRuntimeProfile,
} from "./models.js";
import { createPluginValidators } from "./plugins.js";
import {
  compareDecimalRevisions,
  hasOnlyWireKeys,
  includes,
  isDecimalRevision,
  isSafeInteger,
  isWireArray,
  isWireCorrelationId,
  isWireRecord,
  isWireStorageId,
  isWireUiMessage,
  sameJsonValue,
  wireField,
} from "./primitives.js";
import {
  isWireAgentSession,
  isWireLiveContext,
  isWireSessionActivity,
  isWireSessionAttachments,
  isWireSessionEvent,
  isWireSkillIds,
  isWireSkillSummary,
} from "./session.js";

export function createStateValidators({ isWireIntegrationConnections, isWireSunoAccounts, isWireSunoModelCatalog, isWireAudioJobs, isWireInstalledPlugin, isWireSessionToolCatalog }: ReturnType<typeof createPluginValidators>) {
  function isWireChatBridgeState(value: unknown): value is ChatBridgeState {
    if (
      !isWireRecord(value) ||
      !hasOnlyWireKeys<NonNullable<ChatBridgeState>>(value, [
        "contextSummary",
        "integrationConnections",
        "sunoAccounts",
        "sunoModelCatalog",
        "sessionToolCatalog",
        "audioJobs",
        "liveContext",
        "sessionContinueTarget",
        "sessions",
        "previousSessions",
        "archivedSessions",
        "activeSessionId",
        "approvalMode",
        "events",
        "pendingAttachments",
        "availableSkills",
        "plugins",
        "activeSkillIds",
        "capabilities",
        "capabilityEvidence",
        "availableModels",
        "modelCatalogLoadReceipt",
        "configuredModels",
        "configuredModelsReady",
        "modelStateSource",
        "runtimeProfile",
        "settings",
        "activeProfileRevision",
        "oauthAuth",
        "oauthAuthProfileId",
        "oauthAuthProvider",
        "oauthAuthGeneration",
        "openSettingsOnLoad",
        "status",
        "sessionActivities",
        "bridgeStateRevision",
        "bridgeStateCoveredThroughRevision",
      ]) ||
      typeof value.contextSummary !== "string" ||
      (value.integrationConnections !== undefined && !isWireIntegrationConnections(value.integrationConnections)) ||
      (value.sunoAccounts !== undefined && !isWireSunoAccounts(value.sunoAccounts, value.integrationConnections)) ||
      !isWireSunoModelCatalog(value.sunoModelCatalog, value.integrationConnections, value.sunoAccounts) ||
      (value.sessionToolCatalog !== undefined &&
        !isWireSessionToolCatalog(value.sessionToolCatalog, value.activeSessionId)) ||
      (value.audioJobs !== undefined && !isWireAudioJobs(value.audioJobs, value.activeSessionId)) ||
      !isWireLiveContext(value.liveContext) ||
      !isWireRecord(value.sessionContinueTarget) ||
      !hasOnlyWireKeys(value.sessionContinueTarget, ["kind", "label"]) ||
      !includes(["track", "clip", "object", "selection"], value.sessionContinueTarget.kind) ||
      typeof value.sessionContinueTarget.label !== "string" ||
      !isWireArray(value.sessions) ||
      !isWireArray(value.previousSessions) ||
      !isWireArray(value.archivedSessions) ||
      !value.sessions.every(isWireAgentSession) ||
      !value.previousSessions.every(isWireAgentSession) ||
      !value.archivedSessions.every(isWireAgentSession) ||
      !isWireStorageId(value.activeSessionId) ||
      !isWireApprovalMode(value.approvalMode) ||
      !isWireArray(value.events) ||
      !value.events.every((event) =>
        isWireSessionEvent(event, "persisted")
      ) ||
      !isWireArray(value.pendingAttachments) ||
      !(
        value.pendingAttachments.length === 0 ||
        isWireSessionAttachments(value.pendingAttachments)
      ) ||
      !isWireArray(value.availableSkills) ||
      !value.availableSkills.every(isWireSkillSummary) ||
      !isWireArray(value.plugins) ||
      !value.plugins.every(isWireInstalledPlugin) ||
      !isWireSkillIds(value.activeSkillIds) ||
      !isWireModelCapabilities(value.capabilities) ||
      !isWireModelCapabilityEvidence(
        value.capabilityEvidence,
        value.capabilities,
      ) ||
      !isWireArray(value.availableModels) ||
      value.availableModels.length > maximumDiscoveredModelCount ||
      !value.availableModels.every(isWireModelInfo) ||
      (value.modelCatalogLoadReceipt !== undefined &&
        !isWireCorrelationId(value.modelCatalogLoadReceipt)) ||
      !isWireArray(value.configuredModels) ||
      value.configuredModels.length > maximumProfileModelCount ||
      !value.configuredModels.every(isWireConfiguredModel) ||
      typeof value.configuredModelsReady !== "boolean" ||
      !isWireModelStateSource(value.modelStateSource) ||
      !isWireRuntimeProfile(value.runtimeProfile) ||
      !isWireAgentSettings(value.settings) ||
      !(
        value.activeProfileRevision === null &&
          value.settings.activeProfileId === null ||
        typeof value.activeProfileRevision === "string" &&
          /^[a-f0-9]{64}$/.test(value.activeProfileRevision) &&
          value.settings.activeProfileId !== null
      ) ||
      (value.oauthAuth !== undefined && !isWireOAuthAuth(value.oauthAuth)) ||
      (value.oauthAuth !== undefined) !==
        (value.oauthAuthProfileId !== undefined) ||
      (value.oauthAuth !== undefined) !==
        (value.oauthAuthProvider !== undefined) ||
      (value.oauthAuthProfileId !== undefined &&
        !isWireStorageId(value.oauthAuthProfileId)) ||
      (value.oauthAuthProvider !== undefined &&
        !includes(["openai", "anthropic", "google"], value.oauthAuthProvider)) ||
      !isSafeInteger(value.oauthAuthGeneration) ||
      value.oauthAuthGeneration < 0 ||
      typeof value.openSettingsOnLoad !== "boolean" ||
      (value.status !== undefined && !isWireUiMessage(value.status)) ||
      !isDecimalRevision(value.bridgeStateRevision) ||
      !isDecimalRevision(value.bridgeStateCoveredThroughRevision) ||
      compareDecimalRevisions(
        value.bridgeStateCoveredThroughRevision,
        value.bridgeStateRevision,
      ) >= 0
    ) return false;

    const allSessions = [
      ...value.sessions,
      ...value.previousSessions,
      ...value.archivedSessions,
    ];
    const allSessionIds = allSessions.map((session) => session.id);
    if (new Set(allSessionIds).size !== allSessionIds.length) return false;
    const activeSession = value.sessions.find(
      (session) => session.id === value.activeSessionId,
    );
    if (!activeSession) return false;
    if (
      value.approvalMode !== (activeSession.approvalMode || "manual") ||
      !sameJsonValue(
        value.activeSkillIds,
        activeSession.activeSkillIds || [],
      )
    ) return false;

    if (
      new Set(value.events.map((event) => event.id)).size !==
        value.events.length
    ) return false;
    const consumedAttachmentIds = value.events.flatMap((event) =>
      (event.attachments || []).map((attachment) => attachment.id)
    );
    if (
      new Set(consumedAttachmentIds).size !== consumedAttachmentIds.length ||
      value.pendingAttachments.some((attachment) =>
        consumedAttachmentIds.includes(String(wireField(attachment, "id")))
      )
    ) return false;
    const steeringAckIds = value.events.flatMap((event) =>
      event.steeringAck
        ? [`${event.steeringAck.sendId}\u0000${event.steeringAck.steerId}`]
        : []
    );
    if (new Set(steeringAckIds).size !== steeringAckIds.length) return false;

    const availableSkillIds = new Set(
      value.availableSkills.map((skill) => skill.id),
    );
    if (
      availableSkillIds.size !== value.availableSkills.length ||
      !value.activeSkillIds.every((skillId) => availableSkillIds.has(skillId))
    ) return false;
    if (new Set(value.plugins.map((plugin) => plugin.id)).size !== value.plugins.length) return false;
    if (
      new Set(value.availableModels.map((model) => model.id)).size !==
        value.availableModels.length
    ) return false;
    if (
      new Set(value.configuredModels.map((model) => model.model)).size !==
        value.configuredModels.length ||
      value.runtimeProfile &&
        !value.configuredModels.some(
          (model) => model.model === wireField(wireField(value.runtimeProfile, "selection"), "model"),
        )
    ) return false;

    if (value.sessionActivities !== undefined) {
      const currentSessionIds = new Set(
        value.sessions.map((session) => session.id),
      );
      if (
        !isWireArray(value.sessionActivities) ||
        !value.sessionActivities.every((activity) =>
          isWireSessionActivity(activity, currentSessionIds)
        ) ||
        new Set(
          value.sessionActivities.map((activity) => activity.sessionId),
        ).size !== value.sessionActivities.length
      ) return false;
    }
    return true;
  }

  function wireErrorEnvelopeKind(payload: unknown): "send" | "command" | "global" | null {
    if (
      !isWireRecord(payload) ||
      payload.type !== "error" ||
      typeof payload.message !== "string" ||
      (payload.field !== undefined && typeof payload.field !== "string")
    ) return null;
    const hasSendCorrelation =
      payload.sendId !== undefined || payload.sessionId !== undefined;
    const hasCommandCorrelation = payload.commandId !== undefined;
    if (hasSendCorrelation) {
      if (
        hasCommandCorrelation ||
        !hasOnlyWireKeys(payload, [
          "type",
          "sendId",
          "sessionId",
          "message",
          "field",
          "promptPersistence",
          "sendFailureKind",
          "state",
        ]) ||
        !isWireCorrelationId(payload.sendId) ||
        !isWireStorageId(payload.sessionId) ||
        !includes(["persisted", "not_persisted", "unknown"], payload.promptPersistence) ||
        (payload.sendFailureKind !== undefined &&
          !includes(["session_unavailable", "state_stale"], payload.sendFailureKind)) ||
        (payload.state !== undefined &&
          !isWireChatBridgeState(payload.state))
      ) return null;
      return "send";
    }
    if (hasCommandCorrelation) {
      if (
        !hasOnlyWireKeys(payload, [
          "type",
          "commandId",
          "message",
          "field",
          "commandOutcome",
          "state",
          "reconciliationRequired",
        ]) ||
        !isWireCorrelationId(payload.commandId) ||
        (payload.commandOutcome !== undefined &&
          !includes(["stopped", "unknown"], payload.commandOutcome)) ||
        (payload.reconciliationRequired !== undefined &&
          payload.reconciliationRequired !== true) ||
        (payload.state !== undefined &&
          !isWireChatBridgeState(payload.state))
      ) return null;
      if (payload.commandOutcome === undefined) {
        if (
          payload.state !== undefined ||
          payload.reconciliationRequired !== undefined
        ) return null;
      } else if (payload.commandOutcome === "unknown") {
        if (
          (payload.state === undefined) ===
            (payload.reconciliationRequired === undefined)
        ) return null;
      } else if (payload.reconciliationRequired !== undefined) return null;
      return "command";
    }
    return hasOnlyWireKeys(payload, ["type", "message", "field"])
      ? "global"
      : null;
  }
  return { isWireChatBridgeState, wireErrorEnvelopeKind };
}
