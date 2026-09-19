import { createHash } from "node:crypto";
import type { AudioOperation, AudioServiceConnection } from "../audio-services/contracts.js";
import { audioServiceSupports, type AudioServiceChoice } from "../audio-services/capabilities.js";
import { loadAgentSettings } from "../storage/settings.js";
import { SunoSessions, SunoSessionStorageError, type StoredSunoSession } from "../storage/suno-sessions.js";

/** Private only: never serialize this record into tool schemas or UI state. */
export interface RuntimeAudioServiceConnection extends AudioServiceConnection {
  sunoSession?: Readonly<StoredSunoSession>;
}

export function audioConnectionFingerprint(settings: RuntimeAudioServiceConnection): string {
  // Preserve the legacy credential fingerprint. Connection ID is independently
  // checked on the job, and a model change cannot retarget an accepted task.
  const owner = settings.provider === "suno" ? settings.sunoSession?.accountId : settings.apiKey;
  if (!owner) throw new Error("Audio credential owner is unavailable.");
  return createHash("sha256").update(JSON.stringify([settings.provider, owner])).digest("hex");
}

/** Private send snapshot; only credential-free choices may enter model tools. */
export async function captureAudioServiceConnections(
  storageDirectory: string | undefined,
): Promise<RuntimeAudioServiceConnection[]> {
  if (!storageDirectory) return [];
  const settings = await loadAgentSettings(storageDirectory);
  const result: RuntimeAudioServiceConnection[] = [];
  for (const connection of settings.audioServices?.connections ?? []) {
    if (!connection.enabled) continue;
    try {
      const credential = await runtimeConnection(storageDirectory, connection);
      if (credential) result.push(Object.freeze(credential));
    } catch (error) {
      // Account-level availability is already reported by the session manager.
      // A damaged credential must not disable healthy accounts or ordinary chat.
      // Targeted resolution below still reports the error; global settings errors
      // are outside this catch and retain their existing fail-closed semantics.
      if (!(error instanceof SunoSessionStorageError)) throw error;
    }
  }
  return result;
}

async function runtimeConnection(storageDirectory: string, connection: AudioServiceConnection): Promise<RuntimeAudioServiceConnection | undefined> {
  if (connection.provider !== "suno") return connection.apiKey ? { ...connection } : undefined;
  const session = await new SunoSessions(storageDirectory).load(connection.id);
  return session ? { ...connection, sunoSession: Object.freeze({ ...session }) } : undefined;
}

export async function availableAudioServices(storageDirectory: string | undefined): Promise<AudioServiceChoice[]> {
  return (await captureAudioServiceConnections(storageDirectory))
    .map(({ id, name, provider, modelId }) => ({
      id, name, provider, ...(modelId === undefined ? {} : { modelId }),
    }));
}

export async function resolveAudioService(
  storageDirectory: string | undefined, serviceId: string, operation: AudioOperation,
  admittedConnections?: readonly RuntimeAudioServiceConnection[],
): Promise<RuntimeAudioServiceConnection> {
  if (!storageDirectory) throw new Error("Audio processing requires private persistent storage.");
  const admitted = admittedConnections?.find((entry) => entry.id === serviceId);
  if (admittedConnections && !admitted) {
    throw new Error("The selected audio service was not admitted for this request. Send a new request to use its saved connection.");
  }
  const settings = await loadAgentSettings(storageDirectory);
  const saved = settings.audioServices?.connections.find((entry) => entry.id === serviceId);
  const connection = saved?.enabled ? await runtimeConnection(storageDirectory, saved) : undefined;
  if (!connection) {
    throw new Error("The selected audio service is unavailable. Enable its saved connection in Inspector → App.");
  }
  // Compare this connection, not the collection revision. The persisted job
  // fingerprint binds an accepted task's credential owner; send admission also
  // binds configuration that can change a new submission or its destination.
  if (admitted && (connection.name !== admitted.name || connection.provider !== admitted.provider ||
    connection.enabled !== admitted.enabled || connection.apiKey !== admitted.apiKey ||
    connection.modelId !== admitted.modelId || connection.callbackUrl !== admitted.callbackUrl ||
    connection.sunoSession?.accountId !== admitted.sunoSession?.accountId)) {
    throw new Error("The selected audio service changed after this request was admitted. Send a new request to use its saved connection.");
  }
  if (!audioServiceSupports(connection.provider, operation)) {
    throw new Error("The selected audio service does not support this operation.");
  }
  // Clerk rotates __session while preserving the verified account owner. Use the
  // current private credential after all user-controlled configuration and owner
  // fields match the admitted snapshot.
  return admitted && connection.provider !== "suno" ? admitted : connection;
}
