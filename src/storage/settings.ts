import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import {
  normalizeIntegrationConnection,
  normalizeIntegrationConnectionsSettings,
  type IntegrationConnectionsSettingsPatch,
} from "../plugins/integration-connections.js";
import { builtInAudioPluginId } from "../plugins/builtins/index.js";

import {
  activeSavedProfile,
  cloneAgentSettings,
  freshEmptyAgentSettings,
  incrementContextUsageVisibilityRevision,
  incrementCustomInstructionsRevision,
  incrementDefaultFollowUpBehaviorRevision,
  incrementNetworkProxyRevision,
  incrementUiLanguageRevision,
  isUiLanguage,
  type UiLanguage,
  isDefaultFollowUpBehavior,
  normalizeNetworkProxySettings,
  normalizeCustomInstructions,
  isProfileId,
  isNetworkProxyRevision,
  ProfileValidationError,
  validateDraftProfileForSave,
  type AgentSettings,
  type DefaultFollowUpBehavior,
  type NetworkProxySettings,
  type SavedProfile,
} from "../model/profile.js";
import { isMissingFileError } from "./errors.js";
import {
  ensurePrivateFile,
  withStorageTransaction,
  writeJsonAtomically,
  StorageCommitOutcomeUnknownError,
} from "./persistence.js";
import { decodeAgentSettings } from "./settings-migrations.js";
import { prepareOAuthCredentialStoreInTransaction } from "./oauth-credentials.js";
import { SunoSessions } from "./suno-sessions.js";

export type { AgentSettings, SavedProfile } from "../model/profile.js";
export { activeSavedProfile } from "../model/profile.js";

const settingsFileName = "live-smith-settings.json";
let memorySettings = freshEmptyAgentSettings();
const oauthCredentialPreparationByStorage = new Map<string, Promise<void>>();

export class AgentSettingsCorruptionError extends Error {
  constructor(cause: unknown) {
    super(
      "Saved Live Smith settings are invalid. No changes were written; repair or remove live-smith-settings.json and try again.",
      { cause },
    );
    this.name = "AgentSettingsCorruptionError";
  }
}

export class SavedProfileConflictError extends Error {
  constructor() {
    super(
      "This Profile changed in another Live Smith window. Reload it before saving your changes.",
    );
    this.name = "SavedProfileConflictError";
  }
}

export interface SaveSavedProfileOptions {
  /** Revision of the normalized Profile snapshot from which editing started. */
  expectedCurrentProfileRevision?: string | null;
}

export type GlobalSettingsPatch =
  | {
      uiLanguage?: never;
      defaultFollowUpBehavior: DefaultFollowUpBehavior;
      showContextUsage?: never;
      networkProxy?: never;
      integrationConnections?: never;
      customInstructions?: never;
    }
  | {
      uiLanguage?: never;
      defaultFollowUpBehavior?: never;
      showContextUsage: boolean;
      networkProxy?: never;
      integrationConnections?: never;
      customInstructions?: never;
    }
  | {
      uiLanguage?: never;
      defaultFollowUpBehavior?: never;
      showContextUsage?: never;
      networkProxy: NetworkProxySettings;
      integrationConnections?: never;
      customInstructions?: never;
    }
  | {
      uiLanguage: UiLanguage;
      defaultFollowUpBehavior?: never;
      showContextUsage?: never;
      networkProxy?: never;
      integrationConnections?: never;
      customInstructions?: never;
    }
  | {
      uiLanguage?: never;
      defaultFollowUpBehavior?: never;
      showContextUsage?: never;
      networkProxy?: never;
      integrationConnections: IntegrationConnectionsSettingsPatch;
      customInstructions?: never;
    }
  | {
      uiLanguage?: never;
      defaultFollowUpBehavior?: never;
      showContextUsage?: never;
      networkProxy?: never;
      integrationConnections?: never;
      customInstructions: string;
    };

export type { IntegrationConnectionsSettingsPatch } from "../plugins/integration-connections.js";

export function normalizeIntegrationConnectionsSettingsPatch(
  value: unknown,
): IntegrationConnectionsSettingsPatch {
  const fail = (): never => {
    throw new ProfileValidationError("integrationConnections", "Integration Connection settings require an upsert or remove action, a valid revision, and only the action's fields.");
  };
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fail();
  const record = value as Record<string, unknown>;
  if (!isNetworkProxyRevision(record.expectedRevision)) return fail();
  if (record.action === "remove") {
    if (Object.keys(record).some((key) => !["action", "expectedRevision", "connectionId"].includes(key)) ||
      !isProfileId(record.connectionId)) return fail();
    return { action: "remove", expectedRevision: record.expectedRevision, connectionId: record.connectionId };
  }
  if (record.action !== "upsert" ||
    Object.keys(record).some((key) => !["action", "expectedRevision", "connection"].includes(key)) ||
    typeof record.connection !== "object" || record.connection === null || Array.isArray(record.connection)) return fail();
  const input = record.connection as Record<string, unknown>;
  // A write-only omitted key is resolved under the transaction, never from another connection.
  const connection = normalizeIntegrationConnection({
    ...input,
    secrets: Object.hasOwn(input, "secrets") ? input.secrets : {},
    enabled: false,
  });
  if (typeof input.enabled !== "boolean") return fail();
  const { secrets, ...fields } = connection;
  return { action: "upsert", expectedRevision: record.expectedRevision,
    connection: {
      ...fields,
      enabled: input.enabled,
      ...(Object.hasOwn(input, "secrets") ? { secrets } : {}),
    } };
}

export { integrationConnectionsView } from "../plugins/integration-connections.js";

export function savedProfileRevision(profile: SavedProfile): string {
  return createHash("sha256").update(JSON.stringify(profile), "utf8").digest("hex");
}

export async function loadAgentSettings(
  storageDirectory: string | undefined,
): Promise<AgentSettings> {
  return loadAgentSettingsUnlocked(storageDirectory);
}

export function prepareOAuthCredentialStoreForSavedProfiles(
  storageDirectory: string | undefined,
): Promise<void> {
  if (storageDirectory === undefined) return Promise.resolve();
  const existing = oauthCredentialPreparationByStorage.get(storageDirectory);
  if (existing) return existing;
  const preparation = withStorageTransaction(storageDirectory, async (transaction) => {
    const settings = await loadAgentSettingsUnlocked(storageDirectory);
    await prepareOAuthCredentialStoreInTransaction(
      transaction,
      storageDirectory,
      settings.profiles,
      settings.activeProfileId,
    );
  });
  oauthCredentialPreparationByStorage.set(storageDirectory, preparation);
  void preparation.catch(() => {
    if (oauthCredentialPreparationByStorage.get(storageDirectory) === preparation) {
      oauthCredentialPreparationByStorage.delete(storageDirectory);
    }
  });
  return preparation;
}

async function loadAgentSettingsUnlocked(
  storageDirectory: string | undefined,
): Promise<AgentSettings> {
  if (!storageDirectory) return cloneAgentSettings(memorySettings);

  const target = path.join(storageDirectory, settingsFileName);
  try {
    await ensurePrivateFile(target);
    const raw = await fs.readFile(target, "utf8");
    return decodeAgentSettings(JSON.parse(raw) as unknown);
  } catch (error) {
    if (isMissingFileError(error)) return freshEmptyAgentSettings();
    if (error instanceof SyntaxError || isProfileValidationError(error)) {
      throw new AgentSettingsCorruptionError(error);
    }
    throw error;
  }
}

export async function saveSavedProfile(
  storageDirectory: string | undefined,
  input: SavedProfile,
  options: SaveSavedProfileOptions = {},
): Promise<AgentSettings> {
  return withStorageTransaction(storageDirectory, async () => {
    const settings = await loadAgentSettingsUnlocked(storageDirectory);
    const currentProfile = settings.profiles.find(
      (profile) => profile.id === input.id,
    );
    if (
      options.expectedCurrentProfileRevision !== undefined &&
      (currentProfile === undefined
        ? null
        : savedProfileRevision(currentProfile)) !==
        options.expectedCurrentProfileRevision
    ) {
      throw new SavedProfileConflictError();
    }
    const otherProfiles = settings.profiles.filter((profile) => profile.id !== input.id);
    const profile = validateDraftProfileForSave(input, otherProfiles);
    const existingIndex = settings.profiles.findIndex((entry) => entry.id === profile.id);
    const profiles = [...settings.profiles];
    if (existingIndex >= 0) profiles[existingIndex] = profile;
    else profiles.push(profile);

    return persistSettings(storageDirectory, {
      ...settings,
      profiles,
      activeProfileId: profile.id,
    });
  });
}

export async function deleteSavedProfile(
  storageDirectory: string | undefined,
  profileId: string,
): Promise<AgentSettings> {
  return withStorageTransaction(storageDirectory, async () => {
    const settings = await loadAgentSettingsUnlocked(storageDirectory);
    const profiles = settings.profiles.filter((profile) => profile.id !== profileId);
    if (profiles.length === settings.profiles.length) {
      throw new Error(`Profile ${profileId} does not exist.`);
    }
    const activeProfileId = settings.activeProfileId === profileId
      ? profiles[0]?.id ?? null
      : settings.activeProfileId;
    return persistSettings(storageDirectory, {
      ...settings,
      profiles,
      activeProfileId,
    });
  });
}

export async function activateSavedProfile(
  storageDirectory: string | undefined,
  profileId: string,
): Promise<AgentSettings> {
  return withStorageTransaction(storageDirectory, async () => {
    const settings = await loadAgentSettingsUnlocked(storageDirectory);
    if (!settings.profiles.some((profile) => profile.id === profileId)) {
      throw new Error(`Profile ${profileId} does not exist.`);
    }
    return persistSettings(storageDirectory, {
      ...settings,
      activeProfileId: profileId,
    });
  });
}

export async function saveGlobalSettings(
  storageDirectory: string | undefined,
  input: GlobalSettingsPatch,
): Promise<AgentSettings> {
  const hasFollowUpBehavior = Object.prototype.hasOwnProperty.call(
    input,
    "defaultFollowUpBehavior",
  );
  const hasContextUsage = Object.prototype.hasOwnProperty.call(
    input,
    "showContextUsage",
  );
  const hasUiLanguage = Object.prototype.hasOwnProperty.call(input, "uiLanguage");
  const hasIntegrationConnections = Object.prototype.hasOwnProperty.call(input, "integrationConnections");
  const hasNetworkProxy = Object.prototype.hasOwnProperty.call(
    input,
    "networkProxy",
  );
  const hasCustomInstructions = Object.prototype.hasOwnProperty.call(
    input,
    "customInstructions",
  );
  if (
    Number(hasFollowUpBehavior) +
      Number(hasContextUsage) +
      Number(hasNetworkProxy) + Number(hasUiLanguage) + Number(hasIntegrationConnections) +
      Number(hasCustomInstructions) !== 1 ||
    Object.keys(input).length !== 1
  ) {
    throw new Error("Global settings update must contain exactly one setting.");
  }
  if (
    hasFollowUpBehavior &&
    !isDefaultFollowUpBehavior(input.defaultFollowUpBehavior)
  ) {
    throw new Error("Default follow-up behavior must be queue or steer.");
  }
  if (hasContextUsage && typeof input.showContextUsage !== "boolean") {
    throw new Error("Show context usage must be a boolean.");
  }
  if (hasUiLanguage && !isUiLanguage(input.uiLanguage)) {
    throw new Error("UI language must be system, en, or zh-CN.");
  }
  const networkProxy = hasNetworkProxy
    ? normalizeNetworkProxySettings(input.networkProxy)
    : undefined;
  const customInstructions = hasCustomInstructions
    ? normalizeCustomInstructions(input.customInstructions)
    : undefined;
  const connectionPatch = hasIntegrationConnections
    ? normalizeIntegrationConnectionsSettingsPatch(input.integrationConnections)
    : undefined;
  if (connectionPatch && !storageDirectory) {
    throw new ProfileValidationError("integrationConnections", "Integration Connections require persistent private storage.");
  }
  return withStorageTransaction(storageDirectory, async (transaction) => {
    const settings = await loadAgentSettingsUnlocked(storageDirectory);
    if (connectionPatch) {
      const revision = settings.integrationConnections?.revision ?? "0";
      if (connectionPatch.expectedRevision !== revision) {
        throw new ProfileValidationError("integrationConnections", "Integration Connection settings changed in another window. Reload before saving.");
      }
      const connections = [...(settings.integrationConnections?.connections ?? [])];
      const connectionId = connectionPatch.action === "remove"
        ? connectionPatch.connectionId
        : connectionPatch.connection.id;
      const index = connections.findIndex((connection) => connection.id === connectionId);
      if (connectionPatch.action === "remove") {
        if (index < 0) throw new ProfileValidationError("integrationConnections", "This Integration Connection no longer exists.");
        connections.splice(index, 1);
      } else {
        const previous = connections[index];
        const replacement = connectionPatch.connection;
        const connection = normalizeIntegrationConnection({
          ...replacement,
          secrets: replacement.secrets ??
            (previous?.pluginId === replacement.pluginId ? previous.secrets : {}),
        });
        if (index < 0) connections.push(connection);
        else connections[index] = connection;
      }
      const integrationConnections = normalizeIntegrationConnectionsSettings({ connections,
        revision: incrementNetworkProxyRevision(revision) });
      const previous = settings.integrationConnections?.connections.find((connection) => connection.id === connectionId);
      const next = integrationConnections.connections.find((connection) => connection.id === connectionId);
      const sunoPluginId = builtInAudioPluginId("suno");
      const clearedSession = previous?.pluginId === sunoPluginId && next?.pluginId !== sunoPluginId
        ? await new SunoSessions(storageDirectory).clear(previous.id, transaction) : false;
      try {
        return await persistSettings(storageDirectory, { ...settings, integrationConnections });
      } catch (error) {
        // The credential may already be gone even when the settings rename failed.
        // Preserve the compound command's partial outcome for authoritative readback.
        if (clearedSession) throw new StorageCommitOutcomeUnknownError(
          new Error("Suno Cookie was removed before Integration Connection settings could be saved."));
        throw error;
      }
    }
    return persistSettings(storageDirectory, {
      ...settings,
      ...(hasFollowUpBehavior
        ? {
            defaultFollowUpBehavior: input.defaultFollowUpBehavior!,
            defaultFollowUpBehaviorRevision:
              incrementDefaultFollowUpBehaviorRevision(
                settings.defaultFollowUpBehaviorRevision,
              ),
          }
        : hasContextUsage
        ? {
            showContextUsage: input.showContextUsage!,
            contextUsageVisibilityRevision:
              incrementContextUsageVisibilityRevision(
                settings.contextUsageVisibilityRevision,
              ),
          }
        : hasUiLanguage
        ? {
            uiLanguage: input.uiLanguage!,
            uiLanguageRevision: incrementUiLanguageRevision(settings.uiLanguageRevision),
          }
        : hasCustomInstructions
        ? {
            customInstructions: customInstructions!,
            customInstructionsRevision: incrementCustomInstructionsRevision(
              settings.customInstructionsRevision,
            ),
          }
        : {
            networkProxy: networkProxy!,
            networkProxyRevision: incrementNetworkProxyRevision(
              settings.networkProxyRevision,
            ),
          }),
    });
  });
}

export function requireActiveSavedProfile(
  settings: AgentSettings,
): SavedProfile {
  const profile = activeSavedProfile(settings);
  if (!profile) {
    throw new Error("No saved model profile is active. Create or select a profile in Settings.");
  }
  return profile;
}

async function persistSettings(
  storageDirectory: string | undefined,
  settings: AgentSettings,
): Promise<AgentSettings> {
  const normalized = decodeAgentSettings(settings);
  if (!storageDirectory) {
    memorySettings = cloneAgentSettings(normalized);
    return cloneAgentSettings(normalized);
  }

  const target = path.join(storageDirectory, settingsFileName);
  await writeJsonAtomically(target, normalized);
  return normalized;
}

function isProfileValidationError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === "ProfileValidationError"
  );
}
