import { URL } from "node:url";
import { isIP } from "node:net";

import { cloneJsonValue } from "./json-clone.js";

export type ApiFamily = "openai" | "anthropic";
export type ApiMode = "responses" | "chat-completions" | "messages";

export type ReasoningEffort =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export type ReasoningStrategy =
  | "effort"
  | "adaptive-thinking"
  | "budget-thinking"
  | "none";

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

/** Editable form state. Name and model may intentionally be blank. */
export interface DraftProfile {
  id: string;
  name: string;
  apiFamily: ApiFamily;
  apiMode: ApiMode;
  baseUrl: string;
  apiKey: string;
  model: string;
  parameters: {
    maxOutputTokens: number;
    temperature?: number;
    reasoning: {
      mode: "default" | "disabled" | "enabled";
      effort?: ReasoningEffort;
      budgetTokens?: number;
    };
  };
  advanced: {
    capabilityOverrides?: ModelCapabilityOverrides;
    hostedTools?: HostedToolSettings;
    extraBody?: Record<string, unknown>;
  };
}

/** Complete, normalized configuration that is safe to persist and activate. */
export interface SavedProfile {
  id: string;
  name: string;
  apiFamily: ApiFamily;
  apiMode: ApiMode;
  baseUrl: string;
  apiKey: string;
  model: string;
  parameters: {
    maxOutputTokens: number;
    temperature?: number;
    reasoning: {
      mode: "default" | "disabled" | "enabled";
      effort?: ReasoningEffort;
      budgetTokens?: number;
    };
  };
  advanced: {
    capabilityOverrides?: ModelCapabilityOverrides;
    hostedTools?: HostedToolSettings;
    extraBody?: Record<string, unknown>;
  };
}

export type ApprovalMode = "manual" | "low-risk" | "everything";
export type DefaultFollowUpBehavior = "queue" | "steer";
export type DefaultFollowUpBehaviorRevision = string;

export const CURRENT_AGENT_SETTINGS_SCHEMA_VERSION = 3 as const;

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

const reasoningEfforts = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

const reasoningStrategies = [
  "effort",
  "adaptive-thinking",
  "budget-thinking",
  "none",
] as const;

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

/**
 * Construct the Draft used for provider discovery. This gate deliberately
 * validates only connection fields; unrelated unsaved generation fields must
 * not prevent model discovery from working.
 */
export function validateDraftProfileForDiscovery(value: unknown): DraftProfile {
  const record = requiredRecord(value, "profile", "Profile must be an object.");
  const id = profileIdValue(record.id);
  const apiFamily = apiFamilyValue(record.apiFamily);
  const apiMode = apiModeValue(record.apiMode);
  if (!isValidApiModePair(apiFamily, apiMode)) {
    throw new ProfileValidationError(
      "apiMode",
      `${apiFamily} does not support API mode ${apiMode}.`,
    );
  }

  const rawBaseUrl = requiredString(
    record.baseUrl,
    "baseUrl",
    "Base URL is required.",
  );
  const baseUrl = normalizedBaseUrl(rawBaseUrl);
  return {
    id,
    name: draftString(record.name, "name"),
    apiFamily,
    apiMode,
    baseUrl,
    apiKey: apiKeyValue(record.apiKey, baseUrl),
    model: draftString(record.model, "model"),
    parameters: draftParameters(record.parameters),
    advanced: draftAdvanced(record.advanced),
  };
}

export function validateDraftProfileForSave(
  value: unknown,
  existingProfiles: SavedProfile[] = [],
): SavedProfile {
  const record = requiredRecord(value, "profile", "Profile must be an object.");
  const id = profileIdValue(record.id);
  const name = requiredString(record.name, "name", "Profile name is required.");
  const apiFamily = apiFamilyValue(record.apiFamily);
  const apiMode = apiModeValue(record.apiMode);

  if (!isValidApiModePair(apiFamily, apiMode)) {
    throw new ProfileValidationError(
      "apiMode",
      `${apiFamily} does not support API mode ${apiMode}.`,
    );
  }

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

  const rawBaseUrl = requiredString(
    record.baseUrl,
    "baseUrl",
    "Base URL is required.",
  );
  const baseUrl = normalizedBaseUrl(rawBaseUrl);
  const parameters = requiredRecord(
    record.parameters,
    "parameters",
    "Profile parameters are required.",
  );
  const reasoning = requiredRecord(
    parameters.reasoning,
    "parameters.reasoning",
    "Reasoning settings are required.",
  );
  const advanced = record.advanced === undefined
    ? {}
    : requiredRecord(record.advanced, "advanced", "Advanced settings must be an object.");

  const normalized: SavedProfile = {
    id,
    name,
    apiFamily,
    apiMode,
    baseUrl,
    apiKey: apiKeyValue(record.apiKey, baseUrl),
    model: requiredString(record.model, "model", "Model is required."),
    parameters: {
      maxOutputTokens: positiveInteger(
        parameters.maxOutputTokens,
        "parameters.maxOutputTokens",
        1_000_000,
      ),
      ...(parameters.temperature === undefined
        ? {}
        : {
            temperature: boundedNumber(
              parameters.temperature,
              "parameters.temperature",
              0,
              2,
            ),
          }),
      reasoning: reasoningSettings(reasoning),
    },
    advanced: advancedSettings(advanced),
  };

  if (
    normalized.advanced.hostedTools?.webSearch &&
    normalized.apiMode === "chat-completions"
  ) {
    throw new ProfileValidationError(
      "advanced.hostedTools.webSearch",
      "Web search requires OpenAI Responses or Anthropic Messages.",
    );
  }

  assertJsonCompatible(normalized.advanced.extraBody, "advanced.extraBody");
  return normalized;
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

function advancedSettings(record: Record<string, unknown>): SavedProfile["advanced"] {
  assertOnlyKeys(
    record,
    ["capabilityOverrides", "hostedTools", "extraBody"],
    "advanced",
  );
  const result: SavedProfile["advanced"] = {};
  if (record.capabilityOverrides !== undefined) {
    result.capabilityOverrides = capabilityOverrides(record.capabilityOverrides);
  }
  if (record.extraBody !== undefined) {
    result.extraBody = requiredRecord(
      record.extraBody,
      "advanced.extraBody",
      "Extra Body must be a JSON object.",
    );
  }
  if (record.hostedTools !== undefined) {
    const hostedTools = requiredRecord(
      record.hostedTools,
      "advanced.hostedTools",
      "Hosted tools must be an object.",
    );
    assertOnlyKeys(hostedTools, ["webSearch"], "advanced.hostedTools");
    if (hostedTools.webSearch !== undefined) {
      const enabled = booleanValue(
        hostedTools.webSearch,
        "advanced.hostedTools.webSearch",
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

function draftParameters(value: unknown): SavedProfile["parameters"] {
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

function draftAdvanced(value: unknown): SavedProfile["advanced"] {
  if (!isRecord(value)) return {};
  const advanced: SavedProfile["advanced"] = {};
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

function capabilityOverrides(value: unknown): ModelCapabilityOverrides {
  const record = requiredRecord(
    value,
    "advanced.capabilityOverrides",
    "Capability overrides must be an object.",
  );
  assertOnlyKeys(record, [
    "tools",
    "streaming",
    "temperature",
    "maxOutputTokens",
    "reasoning",
    "inputs",
  ], "advanced.capabilityOverrides");
  const result: ModelCapabilityOverrides = {};
  if (record.tools !== undefined) {
    result.tools = booleanValue(record.tools, "advanced.capabilityOverrides.tools");
  }
  if (record.streaming !== undefined) {
    result.streaming = booleanValue(
      record.streaming,
      "advanced.capabilityOverrides.streaming",
    );
  }
  if (record.temperature !== undefined) {
    if (record.temperature !== "supported" && record.temperature !== "unsupported") {
      throw new ProfileValidationError(
        "advanced.capabilityOverrides.temperature",
        "Temperature capability must be supported or unsupported.",
      );
    }
    result.temperature = record.temperature;
  }
  if (record.maxOutputTokens !== undefined) {
    result.maxOutputTokens = positiveInteger(
      record.maxOutputTokens,
      "advanced.capabilityOverrides.maxOutputTokens",
      1_000_000,
    );
  }
  if (record.reasoning !== undefined) {
    const reasoning = requiredRecord(
      record.reasoning,
      "advanced.capabilityOverrides.reasoning",
      "Reasoning override must be an object.",
    );
    const normalized: NonNullable<ModelCapabilityOverrides["reasoning"]> = {};
    assertOnlyKeys(reasoning, [
      "supported",
      "canDisable",
      "efforts",
      "budgetTokens",
      "strategy",
    ], "advanced.capabilityOverrides.reasoning");
    if (reasoning.supported !== undefined) {
      normalized.supported = booleanValue(
        reasoning.supported,
        "advanced.capabilityOverrides.reasoning.supported",
      );
    }
    if (reasoning.canDisable !== undefined) {
      normalized.canDisable = booleanValue(
        reasoning.canDisable,
        "advanced.capabilityOverrides.reasoning.canDisable",
      );
    }
    if (reasoning.budgetTokens !== undefined) {
      normalized.budgetTokens = booleanValue(
        reasoning.budgetTokens,
        "advanced.capabilityOverrides.reasoning.budgetTokens",
      );
    }
    if (reasoning.efforts !== undefined) {
      if (
        !Array.isArray(reasoning.efforts) ||
        !reasoning.efforts.every(isReasoningEffort)
      ) {
        throw new ProfileValidationError(
          "advanced.capabilityOverrides.reasoning.efforts",
          "Reasoning efforts contain an unsupported value.",
        );
      }
      normalized.efforts = [...new Set(reasoning.efforts)];
    }
    if (reasoning.strategy !== undefined) {
      if (!isReasoningStrategy(reasoning.strategy)) {
        throw new ProfileValidationError(
          "advanced.capabilityOverrides.reasoning.strategy",
          "Reasoning strategy is unsupported.",
        );
      }
      normalized.strategy = reasoning.strategy;
    }
    result.reasoning = normalized;
  }
  if (record.inputs !== undefined) {
    const inputs = requiredRecord(
      record.inputs,
      "advanced.capabilityOverrides.inputs",
      "Input capability override must be an object.",
    );
    assertOnlyKeys(
      inputs,
      ["image", "audio", "pdf"],
      "advanced.capabilityOverrides.inputs",
    );
    const normalized: NonNullable<ModelCapabilityOverrides["inputs"]> = {};
    for (const name of ["image", "audio", "pdf"] as const) {
      if (inputs[name] !== undefined) {
        normalized[name] = booleanValue(
          inputs[name],
          `advanced.capabilityOverrides.inputs.${name}`,
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
): SavedProfile["parameters"]["reasoning"] {
  if (
    record.mode !== "default" &&
    record.mode !== "disabled" &&
    record.mode !== "enabled"
  ) {
    throw new ProfileValidationError(
      "parameters.reasoning.mode",
      "Reasoning mode must be default, disabled, or enabled.",
    );
  }
  const result: SavedProfile["parameters"]["reasoning"] = {
    mode: record.mode,
  };
  if (record.effort !== undefined) {
    if (!isReasoningEffort(record.effort)) {
      throw new ProfileValidationError(
        "parameters.reasoning.effort",
        "Reasoning effort is unsupported.",
      );
    }
    result.effort = record.effort;
  }
  if (record.budgetTokens !== undefined) {
    result.budgetTokens = positiveInteger(
      record.budgetTokens,
      "parameters.reasoning.budgetTokens",
      1_000_000,
    );
  }
  return result;
}

function normalizedBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ProfileValidationError("baseUrl", "Base URL is invalid.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ProfileValidationError(
      "baseUrl",
      "Base URL must use HTTP or HTTPS.",
    );
  }
  if (parsed.username || parsed.password) {
    throw new ProfileValidationError(
      "baseUrl",
      "Base URL must not include credentials.",
    );
  }
  if (parsed.protocol === "http:" && !isLoopbackHostname(parsed.hostname)) {
    throw new ProfileValidationError(
      "baseUrl",
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

function apiKeyValue(value: unknown, baseUrl: string): string {
  if (typeof value !== "string") {
    throw new ProfileValidationError("apiKey", "API key must be a string.");
  }
  const apiKey = value.trim();
  if (apiKey || isLoopbackHostname(new URL(baseUrl).hostname)) return apiKey;
  throw new ProfileValidationError(
    "apiKey",
    "API key is required for non-local endpoints.",
  );
}

function apiFamilyValue(value: unknown): ApiFamily {
  if (value === "openai" || value === "anthropic") return value;
  throw new ProfileValidationError("apiFamily", "API family is unsupported.");
}

function apiModeValue(value: unknown): ApiMode {
  if (
    value === "responses" ||
    value === "chat-completions" ||
    value === "messages"
  ) {
    return value;
  }
  throw new ProfileValidationError("apiMode", "API mode is unsupported.");
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return (reasoningEfforts as readonly unknown[]).includes(value);
}

function isReasoningStrategy(value: unknown): value is ReasoningStrategy {
  return (reasoningStrategies as readonly unknown[]).includes(value);
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
