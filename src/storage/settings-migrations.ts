import {
  CURRENT_AGENT_SETTINGS_SCHEMA_VERSION,
  isApprovalMode,
  ProfileValidationError,
  validateDraftProfileForSave,
  type AgentSettings,
  type ApprovalMode,
  type SavedProfile,
} from "../model/profile.js";

export { CURRENT_AGENT_SETTINGS_SCHEMA_VERSION } from "../model/profile.js";

interface SharedAgentSettings {
  activeProfileId: string | null;
  profiles: SavedProfile[];
}

interface AgentSettingsV1 extends SharedAgentSettings {
  schemaVersion: 1;
  autoApprove: boolean;
}

interface AgentSettingsV2 extends SharedAgentSettings {
  schemaVersion: 2;
  approvalMode: ApprovalMode;
}

type SettingsMigration = (value: unknown) => unknown;

const migrations = new Map<number, SettingsMigration>([
  [1, migrateSettingsV1ToV2],
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
  return validateSettingsV2(migrated);
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

function validateSettingsV1(value: unknown): AgentSettingsV1 {
  const record = settingsRecord(value);
  if (settingsSchemaVersion(record) !== 1) throw unsupportedSchemaVersion();
  const shared = validatedSharedSettings(record);
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
  const shared = validatedSharedSettings(record);
  if (!isApprovalMode(record.approvalMode)) {
    throw new ProfileValidationError(
      "approvalMode",
      "Approval mode must be manual, low-risk, or everything.",
    );
  }
  return {
    schemaVersion: 2,
    ...shared,
    approvalMode: record.approvalMode,
  };
}

function validatedSharedSettings(
  record: Record<string, unknown>,
): SharedAgentSettings {
  if (!Array.isArray(record.profiles)) {
    throw new ProfileValidationError("profiles", "Profiles must be an array.");
  }

  const profiles: SavedProfile[] = [];
  for (const entry of record.profiles) {
    profiles.push(validateDraftProfileForSave(entry, profiles));
  }

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
  return { activeProfileId, profiles };
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

function unsupportedSchemaVersion(): ProfileValidationError {
  return new ProfileValidationError(
    "schemaVersion",
    "Unsupported settings schema.",
  );
}
