import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  activeSavedProfile,
  cloneAgentSettings,
  freshEmptyAgentSettings,
  validateDraftProfileForSave,
  isApprovalMode,
  type AgentSettings,
  type ApprovalMode,
  type SavedProfile,
} from "../model/profile.js";
import { isMissingFileError } from "./errors.js";
import {
  ensurePrivateFile,
  withStorageTransaction,
  writeJsonAtomically,
} from "./persistence.js";
import { decodeAgentSettings } from "./settings-migrations.js";

export type { AgentSettings, SavedProfile } from "../model/profile.js";
export { activeSavedProfile } from "../model/profile.js";

const settingsFileName = "live-smith-settings.json";
let memorySettings = freshEmptyAgentSettings();

export class AgentSettingsCorruptionError extends Error {
  constructor(cause: unknown) {
    super(
      "Saved Live Smith settings are invalid. No changes were written; repair or remove live-smith-settings.json and try again.",
      { cause },
    );
    this.name = "AgentSettingsCorruptionError";
  }
}

export async function loadAgentSettings(
  storageDirectory: string | undefined,
): Promise<AgentSettings> {
  return loadAgentSettingsUnlocked(storageDirectory);
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
): Promise<AgentSettings> {
  return withStorageTransaction(storageDirectory, async () => {
    const settings = await loadAgentSettingsUnlocked(storageDirectory);
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
  input: { approvalMode: ApprovalMode },
): Promise<AgentSettings> {
  if (!isApprovalMode(input.approvalMode)) {
    throw new Error("Approval mode must be manual, low-risk, or everything.");
  }
  return withStorageTransaction(storageDirectory, async () => {
    const settings = await loadAgentSettingsUnlocked(storageDirectory);
    return persistSettings(storageDirectory, {
      ...settings,
      approvalMode: input.approvalMode,
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
