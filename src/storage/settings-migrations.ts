import {
  CURRENT_AGENT_SETTINGS_SCHEMA_VERSION,
  isApprovalMode,
  isDefaultFollowUpBehavior,
  isDefaultFollowUpBehaviorRevision,
  ProfileValidationError,
  validateDraftProfileForSave,
  type AgentSettings,
  type AnthropicDirectApiConnection,
  type ApprovalMode,
  type DefaultFollowUpBehavior,
  type DefaultFollowUpBehaviorRevision,
  type OpenAIDirectApiConnection,
  type SavedProfile,
} from "../model/profile.js";

export { CURRENT_AGENT_SETTINGS_SCHEMA_VERSION } from "../model/profile.js";

interface SharedAgentSettings<Profile> {
  activeProfileId: string | null;
  profiles: Profile[];
}

type LegacyProfileFields = Omit<SavedProfile, "connection">;

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

interface SubscriptionAgentSettingsV3 extends SharedAgentSettings<SavedProfile> {
  schemaVersion: 3;
  approvalMode: ApprovalMode;
}

interface MainAgentSettingsV3 extends SharedAgentSettings<LegacySavedProfile> {
  schemaVersion: 3;
  approvalMode: ApprovalMode;
  defaultFollowUpBehavior: DefaultFollowUpBehavior;
  defaultFollowUpBehaviorRevision: DefaultFollowUpBehaviorRevision;
}

type SettingsMigration = (value: unknown) => unknown;

const migrations = new Map<number, SettingsMigration>([
  [1, migrateSettingsV1ToV2],
  [2, migrateSettingsV2ToV3],
  [3, migrateSettingsV3ToV4],
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
  return validateSettingsV4(migrated);
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

function migrateSettingsV3ToV4(value: unknown): AgentSettings {
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
  const shared = validatedSharedSettings(record, true);
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

function validateSettingsV4(value: unknown): AgentSettings {
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
  const shared = validatedSharedSettings(record, true);
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

function validatedSharedSettings(
  record: Record<string, unknown>,
  allowLegacySubscriptionMaxOutputTokens = false,
): SharedAgentSettings<SavedProfile> {
  if (!Array.isArray(record.profiles)) {
    throw new ProfileValidationError("profiles", "Profiles must be an array.");
  }

  const profiles: SavedProfile[] = [];
  for (const entry of record.profiles) {
    profiles.push(validateDraftProfileForSave(
      allowLegacySubscriptionMaxOutputTokens
        ? withoutLegacySubscriptionMaxOutputTokens(entry)
        : entry,
      profiles,
    ));
  }
  const activeProfileId = validatedActiveProfileId(record, profiles);
  return { activeProfileId, profiles };
}

function withoutLegacySubscriptionMaxOutputTokens(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  const profile = value as Record<string, unknown>;
  const connection = profile.connection;
  const parameters = profile.parameters;
  if (
    typeof connection !== "object" ||
    connection === null ||
    Array.isArray(connection) ||
    (connection as Record<string, unknown>).kind !== "codex-subscription" ||
    typeof parameters !== "object" ||
    parameters === null ||
    Array.isArray(parameters) ||
    !Object.prototype.hasOwnProperty.call(parameters, "maxOutputTokens")
  ) return value;
  const {
    maxOutputTokens: _legacySubscriptionMaxOutputTokens,
    ...supportedParameters
  } = parameters as Record<string, unknown>;
  return { ...profile, parameters: supportedParameters };
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
  const profile = validateDraftProfileForSave({
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

function migrateLegacyProfile(profile: LegacySavedProfile): SavedProfile {
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
