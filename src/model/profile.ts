import { validateHeaderValue } from "node:http";
import { isIP } from "node:net";
import { URL, URLSearchParams } from "node:url";

import { cloneJsonValue } from "./json-clone.js";

export type ApiFamily = "openai" | "anthropic";
export type ApiMode = "responses" | "chat-completions" | "messages";

const reasoningEfforts = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

export type ReasoningEffort = (typeof reasoningEfforts)[number];

const reasoningStrategies = [
  "effort",
  "adaptive-thinking",
  "budget-thinking",
  "none",
] as const;

export type ReasoningStrategy = (typeof reasoningStrategies)[number];

export interface ModelCapabilityOverrides {
  tools?: boolean;
  streaming?: boolean;
  temperature?: "supported" | "unsupported";
  maxOutputTokens?: number;
  reasoning?: {
    supported?: boolean;
    canDisable?: boolean;
    efforts?: ReasoningEffort[];
    budgetTokens?: boolean;
    strategy?: ReasoningStrategy;
  };
  inputs?: {
    image?: boolean;
    audio?: boolean;
    pdf?: boolean;
  };
}

export interface HostedToolSettings {
  /** Provider-executed public web search. Absence means disabled. */
  webSearch?: true;
}

export interface ReasoningSettings {
  mode: "default" | "disabled" | "enabled";
  effort?: ReasoningEffort;
  budgetTokens?: number;
}

export interface GenerationParameters {
  maxOutputTokens?: number;
  temperature?: number;
  reasoning: ReasoningSettings;
}

export interface ModelAdvancedSettings {
  capabilityOverrides?: ModelCapabilityOverrides;
  hostedTools?: HostedToolSettings;
  extraBody?: Record<string, unknown>;
}

interface ModelConfigFields {
  model: string;
  parameters: GenerationParameters;
  advanced: ModelAdvancedSettings;
}

interface ProfileFields {
  id: string;
  name: string;
  defaultModel: string;
}

interface DirectApiConnectionFields {
  kind: "direct-api";
  baseUrl: string;
  apiKey: string;
}

export interface OpenAIDirectApiConnection extends DirectApiConnectionFields {
  apiFamily: "openai";
  apiMode: "responses" | "chat-completions";
}

export interface AnthropicDirectApiConnection extends DirectApiConnectionFields {
  apiFamily: "anthropic";
  apiMode: "messages";
}

export type DirectApiConnection =
  | OpenAIDirectApiConnection
  | AnthropicDirectApiConnection;

type DirectApiPair =
  | Pick<OpenAIDirectApiConnection, "apiFamily" | "apiMode">
  | Pick<AnthropicDirectApiConnection, "apiFamily" | "apiMode">;

export interface CodexSubscriptionConnection {
  kind: "codex-subscription";
  provider: "openai";
}

export type ModelConnection = DirectApiConnection | CodexSubscriptionConnection;

export interface ModelConnectionOwner {
  connection: ModelConnection;
}

export type DraftModelConfig = ModelConfigFields;

export type DirectApiModelConfig = ModelConfigFields & {
  parameters: GenerationParameters & { maxOutputTokens: number };
};

export type CodexSubscriptionModelConfig = ModelConfigFields & {
  parameters: Omit<GenerationParameters, "maxOutputTokens" | "temperature"> & {
    maxOutputTokens?: never;
    temperature?: never;
  };
  advanced: {
    capabilityOverrides?: never;
    hostedTools?: never;
    extraBody?: never;
  };
};

export type SavedModelConfig =
  | DirectApiModelConfig
  | CodexSubscriptionModelConfig;

export type DirectApiProfile = ProfileFields & {
  connection: DirectApiConnection;
  models: DirectApiModelConfig[];
};

export type CodexSubscriptionProfile = ProfileFields & {
  connection: CodexSubscriptionConnection;
  models: CodexSubscriptionModelConfig[];
};

/** Editable form state. Name and individual model fields may be blank. */
export type DraftProfile = ProfileFields & {
  connection: ModelConnection;
  models: DraftModelConfig[];
};

/** Complete, normalized configuration that is safe to persist and activate. */
export type SavedProfile = DirectApiProfile | CodexSubscriptionProfile;

/** A legacy/manual set plus one complete provider discovery catalog. */
export const MAX_PROFILE_MODEL_COUNT = 2_000;

export type ApprovalMode = "manual" | "low-risk" | "everything";
export type DefaultFollowUpBehavior = "queue" | "steer";
export type DefaultFollowUpBehaviorRevision = string;

export const CURRENT_AGENT_SETTINGS_SCHEMA_VERSION = 5 as const;

export interface AgentSettings {
  schemaVersion: typeof CURRENT_AGENT_SETTINGS_SCHEMA_VERSION;
  activeProfileId: string | null;
  profiles: SavedProfile[];
  approvalMode: ApprovalMode;
  defaultFollowUpBehavior: DefaultFollowUpBehavior;
  defaultFollowUpBehaviorRevision: DefaultFollowUpBehaviorRevision;
}

export class ProfileValidationError extends Error {
  constructor(
    public readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = "ProfileValidationError";
  }
}

const profileIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function freshEmptyAgentSettings(): AgentSettings {
  return {
    schemaVersion: CURRENT_AGENT_SETTINGS_SCHEMA_VERSION,
    activeProfileId: null,
    profiles: [],
    approvalMode: "manual",
    defaultFollowUpBehavior: "queue",
    defaultFollowUpBehaviorRevision: "0",
  };
}

export function isApprovalMode(value: unknown): value is ApprovalMode {
  return value === "manual" || value === "low-risk" || value === "everything";
}

export function isDefaultFollowUpBehavior(
  value: unknown,
): value is DefaultFollowUpBehavior {
  return value === "queue" || value === "steer";
}

export function isDefaultFollowUpBehaviorRevision(
  value: unknown,
): value is DefaultFollowUpBehaviorRevision {
  return typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value);
}

export function compareDefaultFollowUpBehaviorRevisions(
  left: DefaultFollowUpBehaviorRevision,
  right: DefaultFollowUpBehaviorRevision,
): -1 | 0 | 1 {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function incrementDefaultFollowUpBehaviorRevision(
  revision: DefaultFollowUpBehaviorRevision,
): DefaultFollowUpBehaviorRevision {
  const digits = [...revision];
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    if (digits[index] === "9") {
      digits[index] = "0";
      continue;
    }
    digits[index] = String.fromCharCode(revision.charCodeAt(index) + 1);
    return digits.join("");
  }
  return `1${digits.join("")}`;
}

export function isValidApiModePair(
  apiFamily: ApiFamily,
  apiMode: ApiMode,
): boolean {
  return apiFamily === "openai"
    ? apiMode === "responses" || apiMode === "chat-completions"
    : apiMode === "messages";
}

export function isDirectApiProfile(
  profile: SavedProfile,
): profile is DirectApiProfile;
export function isDirectApiProfile<Profile extends ModelConnectionOwner>(
  profile: Profile,
): profile is Profile & { connection: DirectApiConnection };
export function isDirectApiProfile(
  profile: ModelConnectionOwner,
): boolean {
  return profile.connection.kind === "direct-api";
}

export function profileProvider(
  profile: ModelConnectionOwner,
): ApiFamily {
  return profile.connection.kind === "direct-api"
    ? profile.connection.apiFamily
    : profile.connection.provider;
}

export function profileApiMode(
  profile: ModelConnectionOwner,
): ApiMode | null {
  return profile.connection.kind === "direct-api"
    ? profile.connection.apiMode
    : null;
}

export function requireDirectApiConnection(
  profile: ModelConnectionOwner,
): DirectApiConnection {
  if (profile.connection.kind === "direct-api") return profile.connection;
  throw new Error("The selected Profile does not use a direct API connection.");
}

export function assertApiKeyCanBeUsedInHttpHeader(apiKey: string): void {
  try {
    validateHeaderValue("authorization", apiKey);
  } catch {
    throw new Error(
      "The selected Profile API key contains characters that cannot be used in an HTTP header.",
    );
  }
}

export function profileSecrets(
  profile: ModelConnectionOwner,
): string[] {
  if (profile.connection.kind !== "direct-api") return [];
  const secrets = [profile.connection.apiKey];
  try {
    const baseUrl = new URL(profile.connection.baseUrl);
    secrets.push(...baseUrl.searchParams.values());
    addUrlComponentSecretForms(secrets, baseUrl.search.slice(1), true);
    addUrlComponentSecretForms(secrets, baseUrl.searchParams.toString(), true);
    const fragment = baseUrl.hash.slice(1);
    addUrlSecretForms(secrets, fragment, false);
    addUrlComponentSecretForms(secrets, fragment, false);
  } catch {
    // Profile validation owns invalid Base URLs; retain API-key redaction here.
  }
  return [...new Set(secrets.filter(Boolean))]
    .sort((left, right) => right.length - left.length);
}

function addUrlComponentSecretForms(
  secrets: string[],
  serialized: string,
  formEncoded: boolean,
): void {
  for (const component of serialized.split("&")) {
    const separator = component.indexOf("=");
    if (separator < 0) continue;
    addUrlSecretForms(secrets, component.slice(separator + 1), formEncoded);
  }
}

function addUrlSecretForms(
  secrets: string[],
  raw: string,
  formEncoded: boolean,
): void {
  if (!raw) return;
  secrets.push(raw);
  try {
    const decoded = decodeURIComponent(
      formEncoded ? raw.replaceAll("+", " ") : raw,
    );
    if (decoded) secrets.push(decoded);
  } catch {
    if (formEncoded) return;
    const protectedRaw = raw.replaceAll("+", "%2B").replaceAll("&", "%26");
    const decoded = new URLSearchParams(`value=${protectedRaw}`).get("value");
    if (decoded) secrets.push(decoded);
  }
}

/**
 * Construct the Draft used for provider discovery. This gate deliberately
 * validates only connection fields; unrelated unsaved generation fields must
 * not prevent model discovery from working.
 */
export function validateDraftProfileForDiscovery(value: unknown): DraftProfile {
  const record = requiredRecord(value, "profile", "Profile must be an object.");
  assertOnlyProfileKeys(record);
  const id = profileIdValue(record.id);
  const connection = connectionValue(record.connection);
  return {
    id,
    name: draftString(record.name, "name"),
    connection,
    defaultModel: draftString(record.defaultModel, "defaultModel"),
    models: draftModelConfigs(record.models, connection),
  };
}

export function validateDraftProfileForSave(
  value: unknown,
  existingProfiles: SavedProfile[] = [],
): SavedProfile {
  const record = requiredRecord(value, "profile", "Profile must be an object.");
  assertOnlyProfileKeys(record);
  const id = profileIdValue(record.id);
  const name = requiredString(record.name, "name", "Profile name is required.");
  const connection = connectionValue(record.connection);

  if (existingProfiles.some((profile) => profile.id === id)) {
    throw new ProfileValidationError("id", `Profile ID ${id} already exists.`);
  }
  if (
    existingProfiles.some(
      (profile) => profile.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase(),
    )
  ) {
    throw new ProfileValidationError("name", `Profile name ${name} already exists.`);
  }

  const defaultModel = requiredString(
    record.defaultModel,
    "defaultModel",
    "Default model is required.",
  );
  if (connection.kind === "codex-subscription") {
    const models = savedModelConfigs(record.models, connection);
    validateDefaultModel(defaultModel, models);
    return {
      id,
      name,
      connection,
      defaultModel,
      models,
    };
  }

  const models = savedModelConfigs(record.models, connection);
  validateDefaultModel(defaultModel, models);
  return {
    id,
    name,
    connection,
    defaultModel,
    models,
  };
}

export function activeSavedProfile(
  settings: AgentSettings,
): SavedProfile | null {
  if (!settings.activeProfileId) return null;
  return (
    settings.profiles.find(
      (profile) => profile.id === settings.activeProfileId,
    ) ?? null
  );
}

export function cloneAgentSettings(settings: AgentSettings): AgentSettings {
  return cloneJsonValue(settings);
}

function assertOnlyProfileKeys(record: Record<string, unknown>): void {
  assertOnlyKeys(
    record,
    ["id", "name", "connection", "defaultModel", "models"],
    "profile",
  );
}

function draftModelConfigs(
  value: unknown,
  connection: ModelConnection,
): DraftModelConfig[] {
  if (!Array.isArray(value)) return [];
  if (value.length > MAX_PROFILE_MODEL_COUNT) {
    throw new ProfileValidationError(
      "models",
      `A Profile can contain at most ${MAX_PROFILE_MODEL_COUNT} models.`,
    );
  }
  return value.map((entry) => {
    const record = isRecord(entry) ? entry : {};
    return connection.kind === "codex-subscription"
      ? {
          model: draftString(record.model, "model"),
          parameters: draftCodexSubscriptionParameters(record.parameters),
          advanced: {},
        }
      : {
          model: draftString(record.model, "model"),
          parameters: draftDirectApiParameters(record.parameters),
          advanced: draftAdvanced(record.advanced),
        };
  });
}

function savedModelConfigs(
  value: unknown,
  connection: CodexSubscriptionConnection,
): CodexSubscriptionModelConfig[];
function savedModelConfigs(
  value: unknown,
  connection: DirectApiConnection,
): DirectApiModelConfig[];
function savedModelConfigs(
  value: unknown,
  connection: ModelConnection,
): SavedModelConfig[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ProfileValidationError(
      "models",
      "A Profile must contain at least one model.",
    );
  }
  if (value.length > MAX_PROFILE_MODEL_COUNT) {
    throw new ProfileValidationError(
      "models",
      `A Profile can contain at most ${MAX_PROFILE_MODEL_COUNT} models.`,
    );
  }
  const models = value.map((entry, index) =>
    savedModelConfig(entry, connection, index)
  );
  const seen = new Set<string>();
  for (const model of models) {
    if (seen.has(model.model)) {
      throw new ProfileValidationError(
        "models",
        `Model ${model.model} appears more than once in this Profile.`,
      );
    }
    seen.add(model.model);
  }
  return models;
}

function savedModelConfig(
  value: unknown,
  connection: ModelConnection,
  index: number,
): SavedModelConfig {
  const field = `models.${index}`;
  const record = requiredRecord(
    value,
    field,
    `${field} must be an object.`,
  );
  assertOnlyKeys(record, ["model", "parameters", "advanced"], field);
  const model = modelIdValue(record.model, `${field}.model`);
  const parametersField = `${field}.parameters`;
  const reasoningField = `${parametersField}.reasoning`;
  const advancedField = `${field}.advanced`;
  const parameters = requiredRecord(
    record.parameters,
    parametersField,
    "Model parameters are required.",
  );
  const reasoning = requiredRecord(
    parameters.reasoning,
    reasoningField,
    "Reasoning settings are required.",
  );
  assertOnlyKeys(
    parameters,
    connection.kind === "codex-subscription"
      ? ["reasoning"]
      : ["maxOutputTokens", "temperature", "reasoning"],
    parametersField,
  );
  assertOnlyKeys(
    reasoning,
    ["mode", "effort", "budgetTokens"],
    reasoningField,
  );
  const advanced = record.advanced === undefined
    ? {}
    : requiredRecord(
        record.advanced,
        advancedField,
        "Advanced model settings must be an object.",
      );

  if (connection.kind === "codex-subscription") {
    validateCodexSubscriptionSettings(
      reasoning,
      advanced,
      reasoningField,
      advancedField,
    );
    return {
      model,
      parameters: {
        reasoning: reasoningSettings(reasoning, reasoningField),
      },
      advanced: {},
    };
  }

  const normalized: DirectApiModelConfig = {
    model,
    parameters: {
      maxOutputTokens: positiveInteger(
        parameters.maxOutputTokens,
        `${parametersField}.maxOutputTokens`,
        1_000_000,
      ),
      ...(parameters.temperature === undefined
        ? {}
        : {
            temperature: boundedNumber(
              parameters.temperature,
              `${parametersField}.temperature`,
              0,
              2,
            ),
          }),
      reasoning: reasoningSettings(reasoning, reasoningField),
    },
    advanced: advancedSettings(advanced, advancedField),
  };
  if (
    normalized.advanced.hostedTools?.webSearch &&
    connection.apiMode === "chat-completions"
  ) {
    throw new ProfileValidationError(
      `${advancedField}.hostedTools.webSearch`,
      "Web search requires OpenAI Responses or Anthropic Messages.",
    );
  }
  assertJsonCompatible(
    normalized.advanced.extraBody,
    `${advancedField}.extraBody`,
  );
  return normalized;
}

function validateDefaultModel(
  defaultModel: string,
  models: readonly SavedModelConfig[],
): void {
  if (models.some((entry) => entry.model === defaultModel)) return;
  throw new ProfileValidationError(
    "defaultModel",
    "Default model must reference a configured model.",
  );
}

function connectionValue(value: unknown): ModelConnection {
  const record = requiredRecord(
    value,
    "connection",
    "Profile connection is required.",
  );
  if (record.kind === "direct-api") {
    assertOnlyKeys(
      record,
      ["kind", "apiFamily", "apiMode", "baseUrl", "apiKey"],
      "connection",
    );
    const pair = directApiPairValue(
      apiFamilyValue(record.apiFamily, "connection.apiFamily"),
      apiModeValue(record.apiMode, "connection.apiMode"),
    );
    const rawBaseUrl = requiredString(
      record.baseUrl,
      "connection.baseUrl",
      "Base URL is required.",
    );
    const baseUrl = normalizedBaseUrl(rawBaseUrl, "connection.baseUrl");
    const apiKey = apiKeyValue(record.apiKey, baseUrl, "connection.apiKey");
    return {
      kind: "direct-api",
      ...pair,
      baseUrl,
      apiKey,
    };
  }
  if (record.kind === "codex-subscription") {
    assertOnlyKeys(record, ["kind", "provider"], "connection");
    if (record.provider !== "openai") {
      throw new ProfileValidationError(
        "connection.provider",
        "Codex subscription Profiles require the OpenAI provider.",
      );
    }
    return { kind: "codex-subscription", provider: "openai" };
  }
  throw new ProfileValidationError(
    "connection.kind",
    "Profile connection kind is unsupported.",
  );
}

function directApiPairValue(
  apiFamily: ApiFamily,
  apiMode: ApiMode,
): DirectApiPair {
  if (apiFamily === "openai") {
    if (apiMode !== "responses" && apiMode !== "chat-completions") {
      throw new ProfileValidationError(
        "connection.apiMode",
        `${apiFamily} does not support API mode ${apiMode}.`,
      );
    }
    return { apiFamily, apiMode };
  }
  if (apiMode !== "messages") {
    throw new ProfileValidationError(
      "connection.apiMode",
      `${apiFamily} does not support API mode ${apiMode}.`,
    );
  }
  return { apiFamily, apiMode };
}

function validateCodexSubscriptionSettings(
  reasoning: Record<string, unknown>,
  advanced: Record<string, unknown>,
  reasoningField: string,
  advancedField: string,
): void {
  if (reasoning.mode === "disabled") {
    throw new ProfileValidationError(
      `${reasoningField}.mode`,
      "Reasoning cannot be disabled for Codex subscription Profiles.",
    );
  }
  if (reasoning.budgetTokens !== undefined) {
    throw new ProfileValidationError(
      `${reasoningField}.budgetTokens`,
      "Reasoning token budgets are not supported by Codex subscription Profiles.",
    );
  }
  if (advanced.hostedTools !== undefined) {
    throw new ProfileValidationError(
      `${advancedField}.hostedTools`,
      "Provider-hosted tools are not supported by Codex subscription Profiles.",
    );
  }
  if (advanced.capabilityOverrides !== undefined) {
    throw new ProfileValidationError(
      `${advancedField}.capabilityOverrides`,
      "Capability overrides are not supported by Codex subscription Profiles.",
    );
  }
  if (advanced.extraBody !== undefined) {
    throw new ProfileValidationError(
      `${advancedField}.extraBody`,
      "Extra Body is not supported by Codex subscription Profiles.",
    );
  }
}

function advancedSettings(
  record: Record<string, unknown>,
  field: string,
): DirectApiModelConfig["advanced"] {
  assertOnlyKeys(
    record,
    ["capabilityOverrides", "hostedTools", "extraBody"],
    field,
  );
  const result: DirectApiModelConfig["advanced"] = {};
  if (record.capabilityOverrides !== undefined) {
    result.capabilityOverrides = capabilityOverrides(
      record.capabilityOverrides,
      `${field}.capabilityOverrides`,
    );
  }
  if (record.extraBody !== undefined) {
    result.extraBody = requiredRecord(
      record.extraBody,
      `${field}.extraBody`,
      "Extra Body must be a JSON object.",
    );
  }
  if (record.hostedTools !== undefined) {
    const hostedTools = requiredRecord(
      record.hostedTools,
      `${field}.hostedTools`,
      "Hosted tools must be an object.",
    );
    assertOnlyKeys(hostedTools, ["webSearch"], `${field}.hostedTools`);
    if (hostedTools.webSearch !== undefined) {
      const enabled = booleanValue(
        hostedTools.webSearch,
        `${field}.hostedTools.webSearch`,
      );
      if (enabled) result.hostedTools = { webSearch: true };
    }
  }
  return result;
}

function draftString(value: unknown, field: string): string {
  if (value === undefined) return "";
  if (typeof value !== "string") {
    throw new ProfileValidationError(field, `${field} must be a string.`);
  }
  return value.trim();
}

function draftDirectApiParameters(
  value: unknown,
): DirectApiModelConfig["parameters"] {
  if (!isRecord(value)) {
    return {
      maxOutputTokens: 16_384,
      reasoning: { mode: "default" },
    };
  }
  const maxOutputTokens = typeof value.maxOutputTokens === "number"
    ? value.maxOutputTokens
    : 16_384;
  const temperature = typeof value.temperature === "number"
    ? value.temperature
    : undefined;
  const rawReasoning = isRecord(value.reasoning) ? value.reasoning : {};
  const mode = rawReasoning.mode === "disabled" || rawReasoning.mode === "enabled"
    ? rawReasoning.mode
    : "default";
  return {
    maxOutputTokens,
    ...(temperature === undefined ? {} : { temperature }),
    reasoning: {
      mode,
      ...(isReasoningEffort(rawReasoning.effort)
        ? { effort: rawReasoning.effort }
        : {}),
      ...(typeof rawReasoning.budgetTokens === "number"
        ? { budgetTokens: rawReasoning.budgetTokens }
        : {}),
    },
  };
}

function draftCodexSubscriptionParameters(
  value: unknown,
): CodexSubscriptionModelConfig["parameters"] {
  const rawReasoning = isRecord(value) && isRecord(value.reasoning)
    ? value.reasoning
    : {};
  return {
    reasoning: {
      mode: rawReasoning.mode === "enabled" ? "enabled" : "default",
      ...(isReasoningEffort(rawReasoning.effort)
        ? { effort: rawReasoning.effort }
        : {}),
    },
  };
}

function draftAdvanced(value: unknown): DirectApiModelConfig["advanced"] {
  if (!isRecord(value)) return {};
  const advanced: DirectApiModelConfig["advanced"] = {};
  if (isRecord(value.capabilityOverrides)) {
    advanced.capabilityOverrides = cloneJsonValue(
      value.capabilityOverrides,
    ) as ModelCapabilityOverrides;
  }
  if (isRecord(value.extraBody)) {
    advanced.extraBody = cloneJsonValue(value.extraBody);
  }
  if (isRecord(value.hostedTools) && value.hostedTools.webSearch === true) {
    advanced.hostedTools = { webSearch: true };
  }
  return advanced;
}

function capabilityOverrides(
  value: unknown,
  field: string,
): ModelCapabilityOverrides {
  const record = requiredRecord(
    value,
    field,
    "Capability overrides must be an object.",
  );
  assertOnlyKeys(record, [
    "tools",
    "streaming",
    "temperature",
    "maxOutputTokens",
    "reasoning",
    "inputs",
  ], field);
  const result: ModelCapabilityOverrides = {};
  if (record.tools !== undefined) {
    result.tools = booleanValue(record.tools, `${field}.tools`);
  }
  if (record.streaming !== undefined) {
    result.streaming = booleanValue(
      record.streaming,
      `${field}.streaming`,
    );
  }
  if (record.temperature !== undefined) {
    if (record.temperature !== "supported" && record.temperature !== "unsupported") {
      throw new ProfileValidationError(
        `${field}.temperature`,
        "Temperature capability must be supported or unsupported.",
      );
    }
    result.temperature = record.temperature;
  }
  if (record.maxOutputTokens !== undefined) {
    result.maxOutputTokens = positiveInteger(
      record.maxOutputTokens,
      `${field}.maxOutputTokens`,
      1_000_000,
    );
  }
  if (record.reasoning !== undefined) {
    const reasoningField = `${field}.reasoning`;
    const reasoning = requiredRecord(
      record.reasoning,
      reasoningField,
      "Reasoning override must be an object.",
    );
    const normalized: NonNullable<ModelCapabilityOverrides["reasoning"]> = {};
    assertOnlyKeys(reasoning, [
      "supported",
      "canDisable",
      "efforts",
      "budgetTokens",
      "strategy",
    ], reasoningField);
    if (reasoning.supported !== undefined) {
      normalized.supported = booleanValue(
        reasoning.supported,
        `${reasoningField}.supported`,
      );
    }
    if (reasoning.canDisable !== undefined) {
      normalized.canDisable = booleanValue(
        reasoning.canDisable,
        `${reasoningField}.canDisable`,
      );
    }
    if (reasoning.budgetTokens !== undefined) {
      normalized.budgetTokens = booleanValue(
        reasoning.budgetTokens,
        `${reasoningField}.budgetTokens`,
      );
    }
    if (reasoning.efforts !== undefined) {
      if (
        !Array.isArray(reasoning.efforts) ||
        !reasoning.efforts.every(isReasoningEffort)
      ) {
        throw new ProfileValidationError(
          `${reasoningField}.efforts`,
          "Reasoning efforts contain an unsupported value.",
        );
      }
      normalized.efforts = [...new Set(reasoning.efforts)];
    }
    if (reasoning.strategy !== undefined) {
      if (!isReasoningStrategy(reasoning.strategy)) {
        throw new ProfileValidationError(
          `${reasoningField}.strategy`,
          "Reasoning strategy is unsupported.",
        );
      }
      normalized.strategy = reasoning.strategy;
    }
    result.reasoning = normalized;
  }
  if (record.inputs !== undefined) {
    const inputsField = `${field}.inputs`;
    const inputs = requiredRecord(
      record.inputs,
      inputsField,
      "Input capability override must be an object.",
    );
    assertOnlyKeys(
      inputs,
      ["image", "audio", "pdf"],
      inputsField,
    );
    const normalized: NonNullable<ModelCapabilityOverrides["inputs"]> = {};
    for (const name of ["image", "audio", "pdf"] as const) {
      if (inputs[name] !== undefined) {
        normalized[name] = booleanValue(
          inputs[name],
          `${inputsField}.${name}`,
        );
      }
    }
    result.inputs = normalized;
  }
  return result;
}

function assertOnlyKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(record).find((key) => !allowedKeys.has(key));
  if (unknown) {
    throw new ProfileValidationError(
      `${field}.${unknown}`,
      `${field} does not support property ${unknown}.`,
    );
  }
}

function reasoningSettings(
  record: Record<string, unknown>,
  field: string,
): ReasoningSettings {
  if (
    record.mode !== "default" &&
    record.mode !== "disabled" &&
    record.mode !== "enabled"
  ) {
    throw new ProfileValidationError(
      `${field}.mode`,
      "Reasoning mode must be default, disabled, or enabled.",
    );
  }
  const result: ReasoningSettings = {
    mode: record.mode,
  };
  if (record.effort !== undefined) {
    if (!isReasoningEffort(record.effort)) {
      throw new ProfileValidationError(
        `${field}.effort`,
        "Reasoning effort is unsupported.",
      );
    }
    result.effort = record.effort;
  }
  if (record.budgetTokens !== undefined) {
    result.budgetTokens = positiveInteger(
      record.budgetTokens,
      `${field}.budgetTokens`,
      1_000_000,
    );
  }
  return result;
}

function normalizedBaseUrl(value: string, field = "baseUrl"): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ProfileValidationError(field, "Base URL is invalid.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ProfileValidationError(
      field,
      "Base URL must use HTTP or HTTPS.",
    );
  }
  if (parsed.username || parsed.password) {
    throw new ProfileValidationError(
      field,
      "Base URL must not include credentials.",
    );
  }
  if (parsed.protocol === "http:" && !isLoopbackHostname(parsed.hostname)) {
    throw new ProfileValidationError(
      field,
      "Base URL must use HTTPS unless the provider is on a loopback address.",
    );
  }
  return value.replace(/\/+$/, "");
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLocaleLowerCase();
  if (normalized === "localhost" || normalized.endsWith(".localhost")) {
    return true;
  }
  if (isIP(normalized) === 4) return normalized.startsWith("127.");

  const unbracketed = normalized.startsWith("[") && normalized.endsWith("]")
    ? normalized.slice(1, -1)
    : normalized;
  if (isIP(unbracketed) !== 6) return false;
  return unbracketed === "::1" ||
    /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/i.test(unbracketed);
}

function apiKeyValue(value: unknown, baseUrl: string, field = "apiKey"): string {
  if (typeof value !== "string") {
    throw new ProfileValidationError(field, "API key must be a string.");
  }
  const apiKey = value.trim();
  try {
    assertApiKeyCanBeUsedInHttpHeader(apiKey);
  } catch {
    throw new ProfileValidationError(
      field,
      "API key contains characters that cannot be used in an HTTP header.",
    );
  }
  if (apiKey || isLoopbackHostname(new URL(baseUrl).hostname)) return apiKey;
  throw new ProfileValidationError(
    field,
    "API key is required for non-local endpoints.",
  );
}

function apiFamilyValue(value: unknown, field = "apiFamily"): ApiFamily {
  if (value === "openai" || value === "anthropic") return value;
  throw new ProfileValidationError(field, "API family is unsupported.");
}

function apiModeValue(value: unknown, field = "apiMode"): ApiMode {
  if (
    value === "responses" ||
    value === "chat-completions" ||
    value === "messages"
  ) {
    return value;
  }
  throw new ProfileValidationError(field, "API mode is unsupported.");
}

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return (reasoningEfforts as readonly unknown[]).includes(value);
}

export function isReasoningStrategy(value: unknown): value is ReasoningStrategy {
  return (reasoningStrategies as readonly unknown[]).includes(value);
}

export function isModelId(value: unknown): value is string {
  return typeof value === "string" &&
    Boolean(value) &&
    value === value.trim() &&
    [...value].length <= 256 &&
    !/[\u0000-\u001F\u007F\u202A-\u202E\u2066-\u2069]/u.test(value);
}

function requiredRecord(
  value: unknown,
  field: string,
  message: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProfileValidationError(field, message);
  }
  return value as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string, message: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ProfileValidationError(field, message);
  }
  return value.trim();
}

function modelIdValue(value: unknown, field: string): string {
  const model = requiredString(value, field, "Model is required.");
  if (!isModelId(model)) {
    throw new ProfileValidationError(
      field,
      "Model must be at most 256 visible characters without control or bidirectional formatting characters.",
    );
  }
  return model;
}

function profileIdValue(value: unknown): string {
  const id = requiredString(value, "id", "Profile ID is required.");
  if (!profileIdPattern.test(id)) {
    throw new ProfileValidationError(
      "id",
      "Profile ID must be 1-128 letters, numbers, underscores, or hyphens and start with a letter or number.",
    );
  }
  return id;
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new ProfileValidationError(field, `${field} must be a boolean.`);
  }
  return value;
}

function positiveInteger(value: unknown, field: string, max: number): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > max
  ) {
    throw new ProfileValidationError(
      field,
      `${field} must be an integer between 1 and ${max}.`,
    );
  }
  return value;
}

function boundedNumber(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  ) {
    throw new ProfileValidationError(
      field,
      `${field} must be between ${min} and ${max}.`,
    );
  }
  return value;
}

function assertJsonCompatible(value: unknown, field: string): void {
  if (value === undefined) return;
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error("not JSON");
    JSON.parse(serialized);
  } catch {
    throw new ProfileValidationError(field, `${field} must contain valid JSON.`);
  }
}
