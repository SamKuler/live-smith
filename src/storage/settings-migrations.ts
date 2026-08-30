import {
  CURRENT_AGENT_SETTINGS_SCHEMA_VERSION,
  isApprovalMode,
  isContextUsageVisibilityRevision,
  isDefaultFollowUpBehavior,
  isDefaultFollowUpBehaviorRevision,
  isNetworkProxyRevision,
  normalizeNetworkProxySettings,
  ProfileValidationError,
  validateDraftProfileForSave,
  type AgentSettings,
  type AnthropicDirectApiConnection,
  type ApprovalMode,
  type ContextUsageVisibilityRevision,
  type DefaultFollowUpBehavior,
  type DefaultFollowUpBehaviorRevision,
  type GenerationParameters,
  type ModelAdvancedSettings,
  type ModelConnection,
  type NetworkProxyRevision,
  type OpenAIDirectApiConnection,
  type SavedProfile,
} from "../model/profile.js";

export { CURRENT_AGENT_SETTINGS_SCHEMA_VERSION } from "../model/profile.js";

interface SharedAgentSettings<Profile> {
  activeProfileId: string | null;
  profiles: Profile[];
}

/** Frozen schema-v4 single-model shape. Do not derive historical shapes from current types. */
interface SavedProfileV4 {
  id: string;
  name: string;
  connection: ModelConnection;
  model: string;
  parameters: GenerationParameters;
  advanced: ModelAdvancedSettings;
}

type LegacyProfileFields = Omit<SavedProfileV4, "connection">;

type LegacySavedProfile = LegacyProfileFields & (
  | Omit<OpenAIDirectApiConnection, "kind">
  | Omit<AnthropicDirectApiConnection, "kind">
);

interface AgentSettingsV1 extends SharedAgentSettings<LegacySavedProfile> {
  schemaVersion: 1;
  autoApprove: boolean;
}

interface AgentSettingsV2 extends SharedAgentSettings<LegacySavedProfile> {
  schemaVersion: 2;
  approvalMode: ApprovalMode;
}

interface SubscriptionAgentSettingsV3 extends SharedAgentSettings<SavedProfileV4> {
  schemaVersion: 3;
  approvalMode: ApprovalMode;
}

interface MainAgentSettingsV3 extends SharedAgentSettings<LegacySavedProfile> {
  schemaVersion: 3;
  approvalMode: ApprovalMode;
  defaultFollowUpBehavior: DefaultFollowUpBehavior;
  defaultFollowUpBehaviorRevision: DefaultFollowUpBehaviorRevision;
}

interface AgentSettingsV4 extends SharedAgentSettings<SavedProfileV4> {
  schemaVersion: 4;
  approvalMode: ApprovalMode;
  defaultFollowUpBehavior: DefaultFollowUpBehavior;
  defaultFollowUpBehaviorRevision: DefaultFollowUpBehaviorRevision;
}

/** Schema-v5 multi-model shape. */
interface AgentSettingsV5 extends SharedAgentSettings<SavedProfile> {
  schemaVersion: 5;
  approvalMode: ApprovalMode;
  defaultFollowUpBehavior: DefaultFollowUpBehavior;
  defaultFollowUpBehaviorRevision: DefaultFollowUpBehaviorRevision;
}

interface AgentSettingsV6 extends SharedAgentSettings<SavedProfile> {
  schemaVersion: 6;
  approvalMode: ApprovalMode;
  defaultFollowUpBehavior: DefaultFollowUpBehavior;
  defaultFollowUpBehaviorRevision: DefaultFollowUpBehaviorRevision;
  showContextUsage: boolean;
  contextUsageVisibilityRevision: ContextUsageVisibilityRevision;
}

interface AgentSettingsV7 extends SharedAgentSettings<SavedProfile> {
  schemaVersion: 7;
  approvalMode: ApprovalMode;
  defaultFollowUpBehavior: DefaultFollowUpBehavior;
  defaultFollowUpBehaviorRevision: DefaultFollowUpBehaviorRevision;
  showContextUsage: boolean;
  contextUsageVisibilityRevision: ContextUsageVisibilityRevision;
}

type SettingsMigration = (value: unknown) => unknown;

const migrations = new Map<number, SettingsMigration>([
  [1, migrateSettingsV1ToV2],
  [2, migrateSettingsV2ToV3],
  [3, migrateSettingsV3ToV4],
  [4, migrateSettingsV4ToV5],
  [5, migrateSettingsV5ToV6],
  [6, migrateSettingsV6ToV7],
  [7, migrateSettingsV7ToV8],
]);

export function decodeAgentSettings(value: unknown): AgentSettings {
  let migrated = value;
  let version = settingsSchemaVersion(migrated);

  while (version < CURRENT_AGENT_SETTINGS_SCHEMA_VERSION) {
    const migrate = migrations.get(version);
    if (!migrate) throw unsupportedSchemaVersion();
    migrated = migrate(migrated);
    const nextVersion = settingsSchemaVersion(migrated);
    if (nextVersion !== version + 1) throw unsupportedSchemaVersion();
    version = nextVersion;
  }

  if (version !== CURRENT_AGENT_SETTINGS_SCHEMA_VERSION) {
    throw unsupportedSchemaVersion();
  }
  return validateSettingsV8(migrated);
}

function migrateSettingsV1ToV2(value: unknown): AgentSettingsV2 {
  const settings = validateSettingsV1(value);
  return {
    schemaVersion: 2,
    activeProfileId: settings.activeProfileId,
    profiles: settings.profiles,
    approvalMode: settings.autoApprove ? "low-risk" : "manual",
  };
}

function migrateSettingsV2ToV3(value: unknown): SubscriptionAgentSettingsV3 {
  const settings = validateSettingsV2(value);
  return {
    schemaVersion: 3,
    activeProfileId: settings.activeProfileId,
    profiles: settings.profiles.map(migrateLegacyProfile),
    approvalMode: settings.approvalMode,
  };
}

function migrateSettingsV3ToV4(value: unknown): AgentSettingsV4 {
  const record = settingsRecord(value);
  if (settingsSchemaVersion(record) !== 3) throw unsupportedSchemaVersion();

  const hasBehavior = Object.prototype.hasOwnProperty.call(
    record,
    "defaultFollowUpBehavior",
  );
  const hasRevision = Object.prototype.hasOwnProperty.call(
    record,
    "defaultFollowUpBehaviorRevision",
  );
  if (hasBehavior !== hasRevision) {
    throw new ProfileValidationError(
      "defaultFollowUpBehavior",
      "Schema version 3 settings must contain both follow-up fields or neither.",
    );
  }

  if (hasBehavior) {
    const settings = validateMainSettingsV3(record);
    return {
      schemaVersion: 4,
      activeProfileId: settings.activeProfileId,
      profiles: settings.profiles.map(migrateLegacyProfile),
      approvalMode: settings.approvalMode,
      defaultFollowUpBehavior: settings.defaultFollowUpBehavior,
      defaultFollowUpBehaviorRevision:
        settings.defaultFollowUpBehaviorRevision,
    };
  }

  const settings = validateSubscriptionSettingsV3(record);
  return {
    schemaVersion: 4,
    activeProfileId: settings.activeProfileId,
    profiles: settings.profiles,
    approvalMode: settings.approvalMode,
    defaultFollowUpBehavior: "queue",
    defaultFollowUpBehaviorRevision: "0",
  };
}

function migrateSettingsV4ToV5(value: unknown): AgentSettingsV5 {
  const settings = validateSettingsV4(value);
  return {
    schemaVersion: 5,
    activeProfileId: settings.activeProfileId,
    profiles: settings.profiles.map(migrateProfileV4),
    approvalMode: settings.approvalMode,
    defaultFollowUpBehavior: settings.defaultFollowUpBehavior,
    defaultFollowUpBehaviorRevision: settings.defaultFollowUpBehaviorRevision,
  };
}

function migrateSettingsV5ToV6(value: unknown): AgentSettingsV6 {
  const settings = validateSettingsV5(value);
  return {
    schemaVersion: 6,
    activeProfileId: settings.activeProfileId,
    profiles: settings.profiles,
    approvalMode: settings.approvalMode,
    defaultFollowUpBehavior: settings.defaultFollowUpBehavior,
    defaultFollowUpBehaviorRevision:
      settings.defaultFollowUpBehaviorRevision,
    showContextUsage: true,
    contextUsageVisibilityRevision: "0",
  };
}

function migrateSettingsV6ToV7(value: unknown): AgentSettingsV7 {
  const settings = validateSettingsV6(value, true);
  return {
    ...settings,
    schemaVersion: 7,
  };
}

function migrateSettingsV7ToV8(value: unknown): AgentSettings {
  const settings = validateSettingsV7(value);
  return {
    ...settings,
    schemaVersion: 8,
    networkProxy: { mode: "none", url: "" },
    networkProxyRevision: "0",
  };
}

function validateSettingsV1(value: unknown): AgentSettingsV1 {
  const record = settingsRecord(value);
  if (settingsSchemaVersion(record) !== 1) throw unsupportedSchemaVersion();
  assertOnlyKeys(
    record,
    ["schemaVersion", "activeProfileId", "profiles", "autoApprove"],
    "settings",
  );
  const shared = validatedLegacySharedSettings(record);
  if (typeof record.autoApprove !== "boolean") {
    throw new ProfileValidationError(
      "autoApprove",
      "Legacy Auto approve must be a boolean.",
    );
  }
  return {
    schemaVersion: 1,
    ...shared,
    autoApprove: record.autoApprove,
  };
}

function validateSettingsV2(value: unknown): AgentSettingsV2 {
  const record = settingsRecord(value);
  if (settingsSchemaVersion(record) !== 2) throw unsupportedSchemaVersion();
  assertOnlyKeys(
    record,
    ["schemaVersion", "activeProfileId", "profiles", "approvalMode"],
    "settings",
  );
  const shared = validatedLegacySharedSettings(record);
  const approvalMode = approvalModeValue(record.approvalMode);
  return {
    schemaVersion: 2,
    ...shared,
    approvalMode,
  };
}

function validateSubscriptionSettingsV3(
  value: unknown,
): SubscriptionAgentSettingsV3 {
  const record = settingsRecord(value);
  if (settingsSchemaVersion(record) !== 3) throw unsupportedSchemaVersion();
  assertOnlyKeys(
    record,
    ["schemaVersion", "activeProfileId", "profiles", "approvalMode"],
    "settings",
  );
  const shared = validatedV4SharedSettings(record, true);
  const approvalMode = approvalModeValue(record.approvalMode);
  return {
    schemaVersion: 3,
    ...shared,
    approvalMode,
  };
}

function validateMainSettingsV3(value: unknown): MainAgentSettingsV3 {
  const record = settingsRecord(value);
  if (settingsSchemaVersion(record) !== 3) throw unsupportedSchemaVersion();
  assertOnlyKeys(
    record,
    [
      "schemaVersion",
      "activeProfileId",
      "profiles",
      "approvalMode",
      "defaultFollowUpBehavior",
      "defaultFollowUpBehaviorRevision",
    ],
    "settings",
  );
  const shared = validatedLegacySharedSettings(record);
  const approvalMode = approvalModeValue(record.approvalMode);
  const defaultFollowUpBehavior = followUpBehaviorValue(
    record.defaultFollowUpBehavior,
  );
  const defaultFollowUpBehaviorRevision = followUpRevisionValue(
    record.defaultFollowUpBehaviorRevision,
  );
  return {
    schemaVersion: 3,
    ...shared,
    approvalMode,
    defaultFollowUpBehavior,
    defaultFollowUpBehaviorRevision,
  };
}

function validateSettingsV4(value: unknown): AgentSettingsV4 {
  const record = settingsRecord(value);
  if (settingsSchemaVersion(record) !== 4) throw unsupportedSchemaVersion();
  assertOnlyKeys(
    record,
    [
      "schemaVersion",
      "activeProfileId",
      "profiles",
      "approvalMode",
      "defaultFollowUpBehavior",
      "defaultFollowUpBehaviorRevision",
    ],
    "settings",
  );
  const shared = validatedV4SharedSettings(record, true);
  const approvalMode = approvalModeValue(record.approvalMode);
  const defaultFollowUpBehavior = followUpBehaviorValue(
    record.defaultFollowUpBehavior,
  );
  const defaultFollowUpBehaviorRevision = followUpRevisionValue(
    record.defaultFollowUpBehaviorRevision,
  );
  return {
    schemaVersion: 4,
    ...shared,
    approvalMode,
    defaultFollowUpBehavior,
    defaultFollowUpBehaviorRevision,
  };
}

function validateSettingsV5(value: unknown): AgentSettingsV5 {
  const record = settingsRecord(value);
  if (settingsSchemaVersion(record) !== 5) throw unsupportedSchemaVersion();
  assertOnlyKeys(
    record,
    [
      "schemaVersion",
      "activeProfileId",
      "profiles",
      "approvalMode",
      "defaultFollowUpBehavior",
      "defaultFollowUpBehaviorRevision",
    ],
    "settings",
  );
  const shared = validatedSharedSettings(record, true);
  const approvalMode = approvalModeValue(record.approvalMode);
  const defaultFollowUpBehavior = followUpBehaviorValue(
    record.defaultFollowUpBehavior,
  );
  const defaultFollowUpBehaviorRevision = followUpRevisionValue(
    record.defaultFollowUpBehaviorRevision,
  );
  return {
    schemaVersion: 5,
    ...shared,
    approvalMode,
    defaultFollowUpBehavior,
    defaultFollowUpBehaviorRevision,
  };
}

function validateSettingsV6(
  value: unknown,
  allowHistoricalConnection = false,
): AgentSettingsV6 {
  const record = settingsRecord(value);
  if (settingsSchemaVersion(record) !== 6) throw unsupportedSchemaVersion();
  assertOnlyKeys(
    record,
    [
      "schemaVersion",
      "activeProfileId",
      "profiles",
      "approvalMode",
      "defaultFollowUpBehavior",
      "defaultFollowUpBehaviorRevision",
      "showContextUsage",
      "contextUsageVisibilityRevision",
    ],
    "settings",
  );
  const shared = validatedSharedSettings(record, allowHistoricalConnection);
  const approvalMode = approvalModeValue(record.approvalMode);
  const defaultFollowUpBehavior = followUpBehaviorValue(
    record.defaultFollowUpBehavior,
  );
  const defaultFollowUpBehaviorRevision = followUpRevisionValue(
    record.defaultFollowUpBehaviorRevision,
  );
  if (typeof record.showContextUsage !== "boolean") {
    throw new ProfileValidationError(
      "showContextUsage",
      "Show context usage must be a boolean.",
    );
  }
  const contextUsageVisibilityRevision = contextUsageRevisionValue(
    record.contextUsageVisibilityRevision,
  );
  return {
    schemaVersion: 6,
    ...shared,
    approvalMode,
    defaultFollowUpBehavior,
    defaultFollowUpBehaviorRevision,
    showContextUsage: record.showContextUsage,
    contextUsageVisibilityRevision,
  };
}

function validateSettingsV7(value: unknown): AgentSettingsV7 {
  const record = settingsRecord(value);
  if (settingsSchemaVersion(record) !== 7) throw unsupportedSchemaVersion();
  const validated = validateSettingsV6(
    { ...record, schemaVersion: 6 },
    false,
  );
  return { ...validated, schemaVersion: 7 };
}

function validateSettingsV8(value: unknown): AgentSettings {
  const record = settingsRecord(value);
  if (settingsSchemaVersion(record) !== 8) throw unsupportedSchemaVersion();
  assertOnlyKeys(
    record,
    [
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
    ],
    "settings",
  );
  const {
    networkProxy: networkProxyValue,
    networkProxyRevision: networkProxyRevisionValue,
    ...settingsV7
  } = record;
  const validated = validateSettingsV7({ ...settingsV7, schemaVersion: 7 });
  return {
    ...validated,
    schemaVersion: 8,
    networkProxy: normalizeNetworkProxySettings(networkProxyValue),
    networkProxyRevision: networkProxyRevision(networkProxyRevisionValue),
  };
}

function validatedSharedSettings(
  record: Record<string, unknown>,
  allowHistoricalConnection = false,
): SharedAgentSettings<SavedProfile> {
  if (!Array.isArray(record.profiles)) {
    throw new ProfileValidationError("profiles", "Profiles must be an array.");
  }

  const profiles: SavedProfile[] = [];
  for (const entry of record.profiles) {
    profiles.push(validateDraftProfileForSave(
      allowHistoricalConnection ? withHistoricalOAuthConnection(entry) : entry,
      profiles,
    ));
  }
  const activeProfileId = validatedActiveProfileId(record, profiles);
  return { activeProfileId, profiles };
}

function validatedV4SharedSettings(
  record: Record<string, unknown>,
  allowLegacySubscriptionMaxOutputTokens = false,
): SharedAgentSettings<SavedProfileV4> {
  if (!Array.isArray(record.profiles)) {
    throw new ProfileValidationError("profiles", "Profiles must be an array.");
  }

  const profiles: SavedProfileV4[] = [];
  for (const entry of record.profiles) {
    profiles.push(validateProfileV4(
      allowLegacySubscriptionMaxOutputTokens
        ? withoutLegacySubscriptionMaxOutputTokens(entry)
        : withHistoricalOAuthConnection(entry),
      profiles,
    ));
  }
  const activeProfileId = validatedActiveProfileId(record, profiles);
  return { activeProfileId, profiles };
}

function validateProfileV4(
  value: unknown,
  existingProfiles: SavedProfileV4[] = [],
): SavedProfileV4 {
  const record = settingsRecord(value);
  assertOnlyKeys(
    record,
    ["id", "name", "connection", "model", "parameters", "advanced"],
    "profile",
  );
  const normalized = validateDraftProfileForSave({
    id: record.id,
    name: record.name,
    connection: record.connection,
    defaultModel: record.model,
    models: [{
      model: record.model,
      parameters: record.parameters,
      advanced: record.advanced,
    }],
  }, existingProfiles.map(migrateProfileV4));
  const model = normalized.models[0];
  if (!model) {
    throw new ProfileValidationError(
      "model",
      "Historical Profile model is missing.",
    );
  }
  return {
    id: normalized.id,
    name: normalized.name,
    connection: normalized.connection,
    model: model.model,
    parameters: model.parameters,
    advanced: model.advanced,
  };
}

function withoutLegacySubscriptionMaxOutputTokens(value: unknown): unknown {
  const normalized = withHistoricalOAuthConnection(value);
  if (typeof normalized !== "object" || normalized === null || Array.isArray(normalized)) {
    return normalized;
  }
  const profile = normalized as Record<string, unknown>;
  const connection = profile.connection;
  const parameters = profile.parameters;
  if (
    typeof connection !== "object" ||
    connection === null ||
    Array.isArray(connection) ||
    (connection as Record<string, unknown>).kind !== "oauth-subscription" ||
    typeof parameters !== "object" ||
    parameters === null ||
    Array.isArray(parameters) ||
    !Object.prototype.hasOwnProperty.call(parameters, "maxOutputTokens")
  ) return normalized;
  const {
    maxOutputTokens: _legacySubscriptionMaxOutputTokens,
    ...supportedParameters
  } = parameters as Record<string, unknown>;
  return { ...profile, parameters: supportedParameters };
}

function withHistoricalOAuthConnection(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  const profile = value as Record<string, unknown>;
  const connection = profile.connection;
  if (typeof connection !== "object" || connection === null ||
    Array.isArray(connection)) {
    return value;
  }
  const record = connection as Record<string, unknown>;
  if (record.kind !== "codex-subscription") return value;
  assertOnlyKeys(record, ["kind", "provider"], "connection");
  if (record.provider !== "openai") {
    throw new ProfileValidationError(
      "connection.provider",
      "Legacy Codex subscription Profiles require the OpenAI provider.",
    );
  }
  return {
    ...profile,
    connection: { kind: "oauth-subscription", provider: "openai" },
  };
}

function validatedLegacySharedSettings(
  record: Record<string, unknown>,
): SharedAgentSettings<LegacySavedProfile> {
  if (!Array.isArray(record.profiles)) {
    throw new ProfileValidationError("profiles", "Profiles must be an array.");
  }

  const profiles: LegacySavedProfile[] = [];
  for (const entry of record.profiles) {
    profiles.push(validateLegacyProfile(entry, profiles));
  }
  const activeProfileId = validatedActiveProfileId(record, profiles);
  return { activeProfileId, profiles };
}

function validateLegacyProfile(
  value: unknown,
  existingProfiles: LegacySavedProfile[],
): LegacySavedProfile {
  const record = settingsRecord(value);
  assertOnlyKeys(
    record,
    [
      "id",
      "name",
      "apiFamily",
      "apiMode",
      "baseUrl",
      "apiKey",
      "model",
      "parameters",
      "advanced",
    ],
    "profile",
  );
  const profile = validateProfileV4({
    id: record.id,
    name: record.name,
    connection: {
      kind: "direct-api",
      apiFamily: record.apiFamily,
      apiMode: record.apiMode,
      baseUrl: record.baseUrl,
      apiKey: record.apiKey,
    },
    model: record.model,
    parameters: record.parameters,
    advanced: record.advanced,
  }, existingProfiles.map(migrateLegacyProfile));
  if (profile.connection.kind !== "direct-api") {
    throw new ProfileValidationError(
      "connection",
      "Legacy Profile connection is invalid.",
    );
  }

  const fields: LegacyProfileFields = {
    id: profile.id,
    name: profile.name,
    model: profile.model,
    parameters: profile.parameters,
    advanced: profile.advanced,
  };
  if (profile.connection.apiFamily === "openai") {
    return {
      ...fields,
      apiFamily: profile.connection.apiFamily,
      apiMode: profile.connection.apiMode,
      baseUrl: profile.connection.baseUrl,
      apiKey: profile.connection.apiKey,
    };
  }
  return {
    ...fields,
    apiFamily: profile.connection.apiFamily,
    apiMode: profile.connection.apiMode,
    baseUrl: profile.connection.baseUrl,
    apiKey: profile.connection.apiKey,
  };
}

function migrateLegacyProfile(profile: LegacySavedProfile): SavedProfileV4 {
  const fields: LegacyProfileFields = {
    id: profile.id,
    name: profile.name,
    model: profile.model,
    parameters: profile.parameters,
    advanced: profile.advanced,
  };
  if (profile.apiFamily === "openai") {
    return {
      ...fields,
      connection: {
        kind: "direct-api",
        apiFamily: profile.apiFamily,
        apiMode: profile.apiMode,
        baseUrl: profile.baseUrl,
        apiKey: profile.apiKey,
      },
    };
  }
  return {
    ...fields,
    connection: {
      kind: "direct-api",
      apiFamily: profile.apiFamily,
      apiMode: profile.apiMode,
      baseUrl: profile.baseUrl,
      apiKey: profile.apiKey,
    },
  };
}

function migrateProfileV4(profile: SavedProfileV4): SavedProfile {
  return validateDraftProfileForSave({
    id: profile.id,
    name: profile.name,
    connection: profile.connection,
    defaultModel: profile.model,
    models: [{
      model: profile.model,
      parameters: profile.parameters,
      advanced: profile.advanced,
    }],
  });
}

function validatedActiveProfileId<Profile extends { id: string }>(
  record: Record<string, unknown>,
  profiles: Profile[],
): string | null {
  const activeProfileId = record.activeProfileId;
  if (activeProfileId !== null && typeof activeProfileId !== "string") {
    throw new ProfileValidationError(
      "activeProfileId",
      "Active profile ID must be a string or null.",
    );
  }
  if (
    typeof activeProfileId === "string" &&
    !profiles.some((profile) => profile.id === activeProfileId)
  ) {
    throw new ProfileValidationError(
      "activeProfileId",
      "Active profile does not exist.",
    );
  }
  return activeProfileId;
}

function approvalModeValue(value: unknown): ApprovalMode {
  if (!isApprovalMode(value)) {
    throw new ProfileValidationError(
      "approvalMode",
      "Approval mode must be manual, low-risk, or everything.",
    );
  }
  return value;
}

function followUpBehaviorValue(value: unknown): DefaultFollowUpBehavior {
  if (!isDefaultFollowUpBehavior(value)) {
    throw new ProfileValidationError(
      "defaultFollowUpBehavior",
      "Default follow-up behavior must be queue or steer.",
    );
  }
  return value;
}

function followUpRevisionValue(
  value: unknown,
): DefaultFollowUpBehaviorRevision {
  if (!isDefaultFollowUpBehaviorRevision(value)) {
    throw new ProfileValidationError(
      "defaultFollowUpBehaviorRevision",
      "Default follow-up behavior revision must be a canonical nonnegative decimal string.",
    );
  }
  return value;
}

function contextUsageRevisionValue(
  value: unknown,
): ContextUsageVisibilityRevision {
  if (!isContextUsageVisibilityRevision(value)) {
    throw new ProfileValidationError(
      "contextUsageVisibilityRevision",
      "Context usage visibility revision must be a canonical nonnegative decimal string.",
    );
  }
  return value;
}

function networkProxyRevision(value: unknown): NetworkProxyRevision {
  if (!isNetworkProxyRevision(value)) {
    throw new ProfileValidationError(
      "networkProxyRevision",
      "Network proxy revision must be a canonical nonnegative decimal string.",
    );
  }
  return value;
}

function settingsSchemaVersion(value: unknown): number {
  const version = settingsRecord(value).schemaVersion;
  if (typeof version !== "number" || !Number.isSafeInteger(version)) {
    throw unsupportedSchemaVersion();
  }
  return version;
}

function settingsRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProfileValidationError("settings", "Settings must be an object.");
  }
  return value as Record<string, unknown>;
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

function unsupportedSchemaVersion(): ProfileValidationError {
  return new ProfileValidationError(
    "schemaVersion",
    "Unsupported settings schema.",
  );
}
