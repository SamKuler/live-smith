import { isUiLanguage } from "../../../i18n/languages.js";
import type {
  AgentSettings,
  ApprovalMode,
  DefaultFollowUpBehavior,
  ModelAdvancedSettings,
  ModelCapabilityOverrides,
  ModelConnection,
  NetworkProxySettings,
  ReasoningEffort,
  ReasoningSettings,
  SavedModelConfig,
  SavedProfile,
} from "../../../model/profile.js";
import type {
  InputCapabilities,
  InputCapabilityEvidence,
  ModelCapabilities,
  ModelCapabilityEvidence,
  ModelInfo,
  OAuthAuthState,
  ProviderReportedModelMetadata,
  ReasoningCapabilities,
} from "../../../model/provider.js";
import type { ChatConfiguredModel, ChatModelStateSource, ChatRuntimeSummary, ChatSessionSummary } from "../../chat-state.js";
import {
  WIRE_CURRENT_AGENT_SETTINGS_SCHEMA_VERSION,
  maximumDiscoveredModelContextWindowTokens,
  maximumDiscoveredModelDisplayNameCodePoints,
  maximumDiscoveredModelIdCodePoints,
  maximumDiscoveredModelOutputTokens,
  maximumProfileModelCount,
  maximumProviderReportedMimeTypeCount,
  maximumProviderReportedModalityCount,
} from "./contracts.js";
import {
  hasOnlyWireKeys,
  includes,
  isDecimalRevision,
  isFiniteNumber,
  isInteger,
  isWireArray,
  isWireRecord,
  isWireStorageId,
  wireCodePointLengthAtMost,
} from "./primitives.js";

export function isDefaultFollowUpBehavior(value: unknown): value is DefaultFollowUpBehavior {
  return value === "queue" || value === "steer";
}

export function isNetworkProxySettings(value: unknown): value is NetworkProxySettings {
  if (
    !isWireRecord(value) ||
    !hasOnlyWireKeys<NonNullable<NetworkProxySettings>>(value, ["mode", "url"]) ||
    !includes(["none", "system", "manual"], value.mode) ||
    typeof value.url !== "string" ||
    value.url.length > 2048 ||
    (value.mode === "manual" && !value.url)
  ) return false;
  if (!value.url) return true;
  try {
    const parsed = new window.URL(value.url);
    return includes(["http:", "https:", "socks:", "socks5:"], parsed.protocol) &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash &&
      (parsed.pathname === "" || parsed.pathname === "/");
  } catch {
    return false;
  }
}

export function isWireSessionModelSelection(value: unknown): value is NonNullable<ChatSessionSummary["modelSelection"]> {
  return isWireRecord(value) &&
    hasOnlyWireKeys<NonNullable<NonNullable<ChatSessionSummary["modelSelection"]>>>(value, [
      "profileId",
      "model",
      "reasoningEffort",
    ]) &&
    isWireStorageId(value.profileId) &&
    isWireModelDisplayString(
      value.model,
      maximumDiscoveredModelIdCodePoints,
    ) &&
    (value.reasoningEffort === undefined ||
      isWireReasoningEffort(value.reasoningEffort));
}

export function isWireReasoningEffort(value: unknown): value is ReasoningEffort {
  return includes([
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultra",
  ], value);
}

export function isWireReasoningCapabilities(value: unknown): value is ReasoningCapabilities {
  return isWireRecord(value) &&
    hasOnlyWireKeys<NonNullable<ReasoningCapabilities>>(value, [
      "supported",
      "canDisable",
      "efforts",
      "budgetTokens",
      "strategy",
    ]) &&
    typeof value.supported === "boolean" &&
    typeof value.canDisable === "boolean" &&
    isWireArray(value.efforts) &&
    value.efforts.every(isWireReasoningEffort) &&
    new Set(value.efforts).size === value.efforts.length &&
    typeof value.budgetTokens === "boolean" &&
    includes([
      "effort",
      "adaptive-thinking",
      "budget-thinking",
      "none",
    ], value.strategy);
}

export function isWireInputCapabilities(value: unknown): value is InputCapabilities {
  return isWireRecord(value) &&
    hasOnlyWireKeys<NonNullable<InputCapabilities>>(value, ["image", "audio", "pdf"]) &&
    typeof value.image === "boolean" &&
    typeof value.audio === "boolean" &&
    typeof value.pdf === "boolean";
}

export function isWireModelCapabilities(value: unknown): value is ModelCapabilities {
  return isWireRecord(value) &&
    hasOnlyWireKeys<NonNullable<ModelCapabilities>>(value, [
      "tools",
      "streaming",
      "temperature",
      "maxOutputTokens",
      "contextWindowTokens",
      "reasoning",
      "inputs",
    ]) &&
    typeof value.tools === "boolean" &&
    typeof value.streaming === "boolean" &&
    includes(["supported", "unsupported"], value.temperature) &&
    (value.maxOutputTokens === undefined ||
      isInteger(value.maxOutputTokens) &&
        value.maxOutputTokens > 0 &&
        value.maxOutputTokens <= maximumDiscoveredModelOutputTokens) &&
    (value.contextWindowTokens === undefined ||
      isInteger(value.contextWindowTokens) &&
        value.contextWindowTokens > 0 &&
        value.contextWindowTokens <=
          maximumDiscoveredModelContextWindowTokens) &&
    isWireReasoningCapabilities(value.reasoning) &&
    isWireInputCapabilities(value.inputs);
}

export function isWireInputCapabilityEvidence(value: unknown): value is InputCapabilityEvidence {
  const allowed = ["supported", "unsupported", "unverified"];
  return isWireRecord(value) &&
    hasOnlyWireKeys<NonNullable<InputCapabilityEvidence>>(value, ["image", "audio", "pdf"]) &&
    includes(allowed, value.image) &&
    includes(allowed, value.audio) &&
    includes(allowed, value.pdf);
}

export function isWireModelCapabilityEvidence(value: unknown, capabilities: unknown): value is ModelCapabilityEvidence {
  const supportEvidence = ["supported", "unsupported", "unverified"];
  const numericEvidence = ["verified", "configured", "unverified"];
  if (
    !isWireRecord(value) ||
    !isWireModelCapabilities(capabilities) ||
    !hasOnlyWireKeys<NonNullable<ModelCapabilityEvidence>>(value, [
      "temperature",
      "maxOutputTokens",
      "contextWindowTokens",
      "reasoning",
      "inputs",
    ]) ||
    !includes(supportEvidence, value.temperature) ||
    !includes(numericEvidence, value.maxOutputTokens) ||
    !includes(numericEvidence, value.contextWindowTokens) ||
    !includes(supportEvidence, value.reasoning) ||
    !isWireInputCapabilityEvidence(value.inputs)
  ) return false;
  return supportEvidenceMatches(value.temperature, capabilities.temperature) &&
    numericEvidenceMatches(
      value.maxOutputTokens,
      capabilities.maxOutputTokens,
    ) &&
    numericEvidenceMatches(
      value.contextWindowTokens,
      capabilities.contextWindowTokens,
    ) &&
    supportEvidenceMatches(
      value.reasoning,
      capabilities.reasoning.supported,
    ) &&
    Object.entries(value.inputs).every(([key, evidence]) =>
      supportEvidenceMatches(evidence, capabilities.inputs[key as keyof InputCapabilities])
    );
}

export function supportEvidenceMatches(evidence: unknown, capability: unknown): boolean {
  if (evidence === "unverified") return true;
  const expected = capability === true || capability === "supported"
    ? "supported"
    : "unsupported";
  return evidence === expected;
}

export function numericEvidenceMatches(evidence: unknown, capability: unknown): boolean {
  return evidence === "unverified"
    ? capability === undefined
    : capability !== undefined;
}

export function isWireCapabilityOverrides(value: unknown): value is ModelCapabilityOverrides {
  if (
    !isWireRecord(value) ||
    !hasOnlyWireKeys<NonNullable<ModelCapabilityOverrides>>(value, [
      "tools",
      "streaming",
      "temperature",
      "maxOutputTokens",
      "reasoning",
      "inputs",
    ]) ||
    (value.tools !== undefined && typeof value.tools !== "boolean") ||
    (value.streaming !== undefined && typeof value.streaming !== "boolean") ||
    (value.temperature !== undefined &&
      !includes(["supported", "unsupported"], value.temperature)) ||
    (value.maxOutputTokens !== undefined &&
      (!isInteger(value.maxOutputTokens) ||
        value.maxOutputTokens <= 0 ||
        value.maxOutputTokens > maximumDiscoveredModelOutputTokens))
  ) return false;
  if (value.reasoning !== undefined) {
    const reasoning = value.reasoning;
    if (
      !isWireRecord(reasoning) ||
      !hasOnlyWireKeys(reasoning, [
        "supported",
        "canDisable",
        "efforts",
        "budgetTokens",
        "strategy",
      ]) ||
      (reasoning.supported !== undefined &&
        typeof reasoning.supported !== "boolean") ||
      (reasoning.canDisable !== undefined &&
        typeof reasoning.canDisable !== "boolean") ||
      (reasoning.efforts !== undefined && (
        !isWireArray(reasoning.efforts) ||
        !reasoning.efforts.every(isWireReasoningEffort) ||
        new Set(reasoning.efforts).size !== reasoning.efforts.length
      )) ||
      (reasoning.budgetTokens !== undefined &&
        typeof reasoning.budgetTokens !== "boolean") ||
      (reasoning.strategy !== undefined &&
        !includes([
          "effort",
          "adaptive-thinking",
          "budget-thinking",
          "none",
        ], reasoning.strategy))
    ) return false;
  }
  if (value.inputs !== undefined) {
    const inputs = value.inputs;
    if (
      !isWireRecord(inputs) ||
      !hasOnlyWireKeys(inputs, ["image", "audio", "pdf"]) ||
      ["image", "audio", "pdf"].some(
        (key) => inputs[key] !== undefined && typeof inputs[key] !== "boolean",
      )
    ) return false;
  }
  return true;
}

export function isWireProfileReasoning(value: unknown): value is ReasoningSettings {
  return isWireRecord(value) &&
    hasOnlyWireKeys<NonNullable<ReasoningSettings>>(value, ["mode", "effort", "budgetTokens"]) &&
    includes(["default", "disabled", "enabled"], value.mode) &&
    (value.effort === undefined || isWireReasoningEffort(value.effort)) &&
    (value.budgetTokens === undefined ||
      isInteger(value.budgetTokens) &&
        value.budgetTokens > 0 &&
        value.budgetTokens <= maximumDiscoveredModelOutputTokens);
}

export function isWireModelConnection(value: unknown): value is ModelConnection {
  if (!isWireRecord(value)) return false;
  if (value.kind === "oauth-subscription") {
    return hasOnlyWireKeys<NonNullable<ModelConnection>>(value, ["kind", "provider"]) &&
      includes(["openai", "anthropic", "google"], value.provider);
  }
  return value.kind === "direct-api" &&
    hasOnlyWireKeys<NonNullable<ModelConnection>>(value, [
      "kind",
      "apiFamily",
      "apiMode",
      "baseUrl",
      "apiKey",
    ]) &&
    (
      value.apiFamily === "openai" &&
        includes(["responses", "chat-completions"], value.apiMode) ||
      value.apiFamily === "anthropic" && value.apiMode === "messages"
    ) &&
    typeof value.baseUrl === "string" &&
    typeof value.apiKey === "string";
}

export function isWireModelAdvanced(value: unknown): value is ModelAdvancedSettings {
  return isWireRecord(value) &&
    hasOnlyWireKeys<NonNullable<ModelAdvancedSettings>>(value, [
      "capabilityOverrides",
      "hostedTools",
      "extraBody",
    ]) &&
    (value.capabilityOverrides === undefined ||
      isWireCapabilityOverrides(value.capabilityOverrides)) &&
    (value.hostedTools === undefined ||
      isWireRecord(value.hostedTools) &&
        hasOnlyWireKeys(value.hostedTools, ["webSearch"]) &&
        value.hostedTools.webSearch === true) &&
    (value.extraBody === undefined || isWireRecord(value.extraBody));
}

export function isWireSavedModelConfig(value: unknown, subscription: boolean): value is SavedModelConfig {
  if (
    !isWireRecord(value) ||
    !hasOnlyWireKeys<NonNullable<SavedModelConfig>>(value, ["model", "parameters", "advanced"]) ||
    !isWireModelDisplayString(
      value.model,
      maximumDiscoveredModelIdCodePoints,
    ) ||
    !isWireRecord(value.parameters) ||
    !isWireProfileReasoning(value.parameters.reasoning) ||
    !isWireRecord(value.advanced)
  ) return false;
  if (subscription) {
    return hasOnlyWireKeys(value.parameters, [
        "contextWindowTokens",
        "autoCompactTokenLimit",
        "reasoning",
      ]) &&
      isWireContextManagementParameters(value.parameters) &&
      value.parameters.reasoning.mode !== "disabled" &&
      value.parameters.reasoning.budgetTokens === undefined &&
      hasOnlyWireKeys(value.advanced, []);
  }
  return hasOnlyWireKeys(value.parameters, [
      "maxOutputTokens",
      "contextWindowTokens",
      "autoCompactTokenLimit",
      "temperature",
      "reasoning",
    ]) &&
    isWireContextManagementParameters(value.parameters) &&
    isInteger(value.parameters.maxOutputTokens) &&
    value.parameters.maxOutputTokens > 0 &&
    value.parameters.maxOutputTokens <= maximumDiscoveredModelOutputTokens &&
    (value.parameters.temperature === undefined ||
      isFiniteNumber(value.parameters.temperature) &&
        value.parameters.temperature >= 0 &&
        value.parameters.temperature <= 2) &&
    isWireModelAdvanced(value.advanced);
}

export function isWireContextManagementParameters(value: Record<string, unknown>): value is Record<string, unknown> {
  const windowTokens = value.contextWindowTokens;
  const compactAt = value.autoCompactTokenLimit;
  if (
    (windowTokens !== undefined && (
      !isInteger(windowTokens) ||
      windowTokens <= 0 ||
      windowTokens > maximumDiscoveredModelContextWindowTokens
    )) ||
    (compactAt !== undefined && (
      !isInteger(compactAt) ||
      compactAt <= 0 ||
      compactAt > maximumDiscoveredModelContextWindowTokens
    ))
  ) return false;
  return windowTokens === undefined || compactAt === undefined ||
    compactAt < windowTokens;
}

export function isWireSavedProfile(value: unknown): value is SavedProfile {
  if (
    !isWireRecord(value) ||
    !hasOnlyWireKeys<NonNullable<SavedProfile>>(value, [
      "id",
      "name",
      "connection",
      "defaultModel",
      "models",
    ]) ||
    !isWireStorageId(value.id) ||
    typeof value.name !== "string" ||
    !isWireModelConnection(value.connection) ||
    !isWireModelDisplayString(
      value.defaultModel,
      maximumDiscoveredModelIdCodePoints,
    ) ||
    !isWireArray(value.models) ||
    value.models.length === 0 ||
    value.models.length > maximumProfileModelCount ||
    !value.models.every((model) =>
      isWireSavedModelConfig(
        model,
        isWireRecord(value.connection) && value.connection.kind === "oauth-subscription",
      )
    ) ||
    new Set(value.models.map((model) => model.model)).size !==
      value.models.length
  ) return false;
  return value.models.some((model) => model.model === value.defaultModel);
}

export function isWireAgentSettings(value: unknown): value is AgentSettings {
  if (
    !isWireRecord(value) ||
    !hasOnlyWireKeys<NonNullable<AgentSettings>>(value, [
      "schemaVersion",
      "activeProfileId",
      "profiles",
      "approvalMode",
      "defaultFollowUpBehavior",
      "defaultFollowUpBehaviorRevision",
      "showContextUsage",
      "contextUsageVisibilityRevision",
      "networkProxy",
      "networkProxyRevision",
      "uiLanguage",
      "uiLanguageRevision",
      "customInstructions",
      "customInstructionsRevision",
    ]) ||
    value.schemaVersion !== WIRE_CURRENT_AGENT_SETTINGS_SCHEMA_VERSION ||
    !isWireArray(value.profiles) ||
    !value.profiles.every(isWireSavedProfile) ||
    new Set(value.profiles.map((profile) => profile.id)).size !==
      value.profiles.length ||
    !isWireApprovalMode(value.approvalMode) ||
    !isDefaultFollowUpBehavior(value.defaultFollowUpBehavior) ||
    !isDecimalRevision(value.defaultFollowUpBehaviorRevision) ||
    typeof value.showContextUsage !== "boolean" ||
    !isDecimalRevision(value.contextUsageVisibilityRevision) ||
    !isNetworkProxySettings(value.networkProxy) ||
    !isUiLanguage(value.uiLanguage) ||
    !isDecimalRevision(value.uiLanguageRevision) ||
    typeof value.customInstructions !== "string" ||
    value.customInstructions.includes("\0") ||
    Array.from(value.customInstructions).length > 8000 ||
    !isDecimalRevision(value.customInstructionsRevision) ||
    !isDecimalRevision(value.networkProxyRevision)
  ) return false;
  return value.activeProfileId === null ||
    isWireStorageId(value.activeProfileId) &&
      value.profiles.some((profile) => profile.id === value.activeProfileId);
}

export function isWireModelInfo(value: unknown): value is ModelInfo {
  return isWireRecord(value) &&
    hasOnlyWireKeys<NonNullable<ModelInfo>>(value, [
      "id",
      "displayName",
      "capabilities",
      "capabilityEvidence",
      "providerReported",
    ]) &&
    isWireModelDisplayString(
      value.id,
      maximumDiscoveredModelIdCodePoints,
    ) &&
    isWireModelDisplayString(
      value.displayName,
      maximumDiscoveredModelDisplayNameCodePoints,
    ) &&
    isWireModelCapabilities(value.capabilities) &&
    isWireModelCapabilityEvidence(
      value.capabilityEvidence,
      value.capabilities,
    ) &&
    (value.providerReported === undefined ||
      isWireProviderReportedModelMetadata(value.providerReported));
}

export function isWireProviderReportedModelMetadata(value: unknown): value is ProviderReportedModelMetadata {
  if (!isWireRecord(value) ||
    !hasOnlyWireKeys<NonNullable<ProviderReportedModelMetadata>>(value, ["inputs", "reasoning"])) return false;
  if (value.inputs !== undefined) {
    const inputs = value.inputs;
    if (!isWireRecord(inputs) || !hasOnlyWireKeys(inputs, [
      "inputModalities",
      "supportsImages",
      "supportsPdf",
      "supportsVideo",
      "supportedMimeTypes",
    ])) return false;
    for (const key of ["supportsImages", "supportsPdf", "supportsVideo"]) {
      if (inputs[key] !== undefined && typeof inputs[key] !== "boolean") {
        return false;
      }
    }
    if (inputs.inputModalities !== undefined && (
      !isWireArray(inputs.inputModalities) ||
      inputs.inputModalities.length > maximumProviderReportedModalityCount ||
      !inputs.inputModalities.every((item) =>
        isWireModelDisplayString(
          item,
          maximumDiscoveredModelIdCodePoints,
        )
      ) ||
      new Set(inputs.inputModalities).size !== inputs.inputModalities.length
    )) return false;
    if (inputs.supportedMimeTypes !== undefined &&
      !isWireProviderReportedMimeTypes(inputs.supportedMimeTypes)) return false;
  }
  if (value.reasoning !== undefined) {
    const reasoning = value.reasoning;
    if (!isWireRecord(reasoning) || !hasOnlyWireKeys(reasoning, [
      "supportsThinking",
      "supportsAdaptiveThinking",
      "thinkingBudget",
      "minThinkingBudget",
      "thinkingLevel",
    ])) return false;
    for (const key of ["supportsThinking", "supportsAdaptiveThinking"]) {
      if (reasoning[key] !== undefined && typeof reasoning[key] !== "boolean") {
        return false;
      }
    }
    for (const key of ["thinkingBudget", "minThinkingBudget", "thinkingLevel"]) {
      if (reasoning[key] !== undefined && (
        !isInteger(reasoning[key]) ||
        reasoning[key] < -2147483648 ||
        reasoning[key] > 2147483647
      )) return false;
    }
  }
  return true;
}

export function isWireProviderReportedMimeTypes(value: unknown): value is Record<string, boolean> {
  if (!isWireRecord(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= maximumProviderReportedMimeTypeCount &&
    entries.every(([mimeType, supported]) =>
      typeof supported === "boolean" &&
      isWireModelDisplayString(
        mimeType,
        maximumDiscoveredModelIdCodePoints,
      ) &&
      !/\s/.test(mimeType) &&
      mimeType.indexOf("/") > 0 &&
      mimeType.indexOf("/") < mimeType.length - 1
    );
}

export function isWireModelDisplayString(value: unknown, maximumCodePoints: number): value is string {
  return typeof value === "string" &&
    Boolean(value) &&
    value === value.trim() &&
    wireCodePointLengthAtMost(value, maximumCodePoints) &&
    !/[\u0000-\u001F\u007F\u202A-\u202E\u2066-\u2069]/u.test(value);
}

export function isWireModelStateSource(value: unknown): value is ChatModelStateSource | null {
  return value === null ||
    isWireRecord(value) &&
      hasOnlyWireKeys<NonNullable<ChatModelStateSource | null>>(value, ["profileId", "connection", "model"]) &&
      isWireStorageId(value.profileId) &&
      isWireModelConnection(value.connection) &&
      typeof value.model === "string";
}

export function isWireRuntimeProfile(value: unknown): value is ChatRuntimeSummary | null {
  if (value === null) return true;
  if (
    !isWireRecord(value) ||
    !hasOnlyWireKeys<NonNullable<ChatRuntimeSummary | null>>(value, [
      "profile",
      "selection",
      "capabilities",
      "inputCapabilityEvidence",
    ]) ||
    !isWireRecord(value.profile) ||
    !hasOnlyWireKeys(value.profile, [
      "id",
      "name",
      "connectionKind",
      "apiFamily",
      "apiMode",
    ]) ||
    !isWireStorageId(value.profile.id) ||
    typeof value.profile.name !== "string" ||
    !isWireRecord(value.selection) ||
    !hasOnlyWireKeys(value.selection, ["model", "reasoning"]) ||
    !isWireModelDisplayString(
      value.selection.model,
      maximumDiscoveredModelIdCodePoints,
    ) ||
    !isWireProfileReasoning(value.selection.reasoning) ||
    !isWireModelCapabilities(value.capabilities) ||
    !isWireInputCapabilityEvidence(value.inputCapabilityEvidence)
  ) return false;
  return value.profile.connectionKind === "oauth-subscription"
    ? includes(["openai", "anthropic", "google"], value.profile.apiFamily) && value.profile.apiMode === null
    : value.profile.connectionKind === "direct-api" &&
        (
          value.profile.apiFamily === "openai" &&
            includes(["responses", "chat-completions"], value.profile.apiMode) ||
          value.profile.apiFamily === "anthropic" &&
            value.profile.apiMode === "messages"
        );
}

export function isWireConfiguredModel(value: unknown): value is ChatConfiguredModel {
  return isWireRecord(value) &&
    hasOnlyWireKeys<NonNullable<ChatConfiguredModel>>(value, ["model", "label"]) &&
    isWireModelDisplayString(
      value.model,
      maximumDiscoveredModelIdCodePoints,
    ) &&
    isWireModelDisplayString(
      value.label,
      maximumDiscoveredModelDisplayNameCodePoints,
    );
}

export function isWireOAuthAuth(value: unknown): value is OAuthAuthState {
  if (!isWireRecord(value) || typeof value.status !== "string") return false;
  if (value.status === "signed-out") {
    return hasOnlyWireKeys<NonNullable<OAuthAuthState>>(value, ["status"]);
  }
  if (value.status === "unavailable") {
    return hasOnlyWireKeys<NonNullable<OAuthAuthState>>(value, [
      "status",
      "message",
      "definitive",
      "verificationUrl",
      "verificationLabel",
    ]) &&
      typeof value.message === "string" &&
      (value.definitive === undefined || typeof value.definitive === "boolean") &&
      (value.verificationUrl === undefined ||
        typeof value.verificationUrl === "string") &&
      (value.verificationLabel === undefined ||
        typeof value.verificationLabel === "string");
  }
  if (value.status === "pending") {
    return hasOnlyWireKeys<NonNullable<OAuthAuthState>>(value, [
      "status",
      "verificationUrl",
      "userCode",
      "authorizationCodeInput",
      "browserLaunchFailed",
    ]) &&
      typeof value.verificationUrl === "string" &&
      (value.userCode === undefined || typeof value.userCode === "string") &&
      (value.authorizationCodeInput === undefined ||
        value.authorizationCodeInput === true) &&
      (value.browserLaunchFailed === undefined ||
        typeof value.browserLaunchFailed === "boolean");
  }
  return value.status === "signed-in" &&
    hasOnlyWireKeys<NonNullable<OAuthAuthState>>(value, [
      "status",
      "accountLabel",
      "planType",
      "subscriptionEligible",
    ]) &&
    (value.accountLabel === null || typeof value.accountLabel === "string") &&
    typeof value.planType === "string" &&
    typeof value.subscriptionEligible === "boolean";
}

export function isWireApprovalMode(value: unknown): value is ApprovalMode {
  return includes(["manual", "low-risk", "everything"], value);
}
