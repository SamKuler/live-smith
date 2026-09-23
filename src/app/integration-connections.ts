import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type { AudioOperation, AudioProvider } from "../audio-services/contracts.js";
import {
  builtInAudioPluginById,
} from "../plugins/builtins/index.js";
import type { BuiltInAudioPluginDefinition } from "../plugins/builtins/contracts.js";
import type { BuiltInIntegrationConnectionChoice } from "../plugins/builtins/contracts.js";
import type { IntegrationConnection } from "../plugins/integration-connections.js";
import { loadAgentSettings } from "../storage/settings.js";
import {
  SunoSessions,
  SunoSessionStorageError,
  type StoredSunoSession,
} from "../storage/suno-sessions.js";

/** Private only: never serialize this record into tool schemas or UI state. */
export interface RuntimeIntegrationConnection extends IntegrationConnection {
  provider: AudioProvider;
  apiKey: string;
  modelId?: string;
  callbackUrl?: string;
  sunoSession?: Readonly<StoredSunoSession>;
}

export function integrationConnectionFingerprint(
  connection: RuntimeIntegrationConnection,
): string {
  // Preserve the historical credential fingerprint so in-flight jobs remain
  // recoverable across the settings migration.
  const owner = connection.provider === "suno"
    ? connection.sunoSession?.accountId
    : connection.apiKey;
  if (!owner) throw new Error("Integration Connection credential owner is unavailable.");
  return createHash("sha256")
    .update(JSON.stringify([connection.provider, owner]))
    .digest("hex");
}

/** Private send snapshot; only credential-free choices may enter model tools. */
export async function captureIntegrationConnections(
  storageDirectory: string | undefined,
): Promise<RuntimeIntegrationConnection[]> {
  if (!storageDirectory) return [];
  const settings = await loadAgentSettings(storageDirectory);
  const result: RuntimeIntegrationConnection[] = [];
  for (const connection of settings.integrationConnections?.connections ?? []) {
    if (!connection.enabled || !builtInAudioPluginById(connection.pluginId)) continue;
    try {
      const credential = await runtimeConnection(storageDirectory, connection);
      if (credential) result.push(Object.freeze(credential));
    } catch (error) {
      // Account-level availability is already reported by the session manager.
      // A damaged credential must not disable healthy accounts or ordinary chat.
      if (!(error instanceof SunoSessionStorageError)) throw error;
    }
  }
  return result;
}

async function runtimeConnection(
  storageDirectory: string,
  connection: IntegrationConnection,
): Promise<RuntimeIntegrationConnection | undefined> {
  const plugin = requiredPlugin(connection);
  const runtime = {
    ...connection,
    provider: plugin.provider,
    apiKey: connection.secrets.apiKey ?? "",
    ...(connection.configuration.modelId === undefined ? {} : {
      modelId: connection.configuration.modelId,
    }),
    ...(connection.configuration.callbackUrl === undefined ? {} : {
      callbackUrl: connection.configuration.callbackUrl,
    }),
  };
  if (plugin.provider !== "suno") return runtime.apiKey ? runtime : undefined;
  const session = await new SunoSessions(storageDirectory).load(connection.id);
  return session
    ? { ...runtime, sunoSession: Object.freeze({ ...session }) }
    : undefined;
}

export async function availableIntegrationConnections(
  storageDirectory: string | undefined,
): Promise<BuiltInIntegrationConnectionChoice[]> {
  return (await captureIntegrationConnections(storageDirectory))
    .map(({ id, name, pluginId, provider, modelId }) => ({
      id,
      name,
      pluginId,
      provider,
      ...(modelId === undefined ? {} : { modelId }),
    }));
}

export async function resolveIntegrationConnection(
  storageDirectory: string | undefined,
  connectionId: string,
  operation: AudioOperation,
  admittedConnections?: readonly RuntimeIntegrationConnection[],
): Promise<RuntimeIntegrationConnection> {
  if (!storageDirectory) {
    throw new Error("Integration Connections require private persistent storage.");
  }
  const admitted = admittedConnections?.find((entry) => entry.id === connectionId);
  if (admittedConnections && !admitted) {
    throw new Error("The selected Integration Connection was not admitted for this request. Send a new request to use its saved configuration.");
  }
  const settings = await loadAgentSettings(storageDirectory);
  const saved = settings.integrationConnections?.connections.find(
    (entry) => entry.id === connectionId,
  );
  const connection = saved?.enabled
    ? await runtimeConnection(storageDirectory, saved)
    : undefined;
  if (!connection) {
    throw new Error("The selected Integration Connection is unavailable. Enable it in Inspector → App.");
  }
  if (admitted && (
    connection.name !== admitted.name ||
    connection.pluginId !== admitted.pluginId ||
    connection.enabled !== admitted.enabled ||
    !isDeepStrictEqual(connection.configuration, admitted.configuration) ||
    !isDeepStrictEqual(connection.secrets, admitted.secrets) ||
    connection.sunoSession?.accountId !== admitted.sunoSession?.accountId
  )) {
    throw new Error("The selected Integration Connection changed after this request was admitted. Send a new request to use its saved configuration.");
  }
  if (!requiredPlugin(connection).audio.operations.includes(operation)) {
    throw new Error("The selected Integration Connection does not expose this tool.");
  }
  // Clerk rotates __session while preserving the verified account owner. Use
  // the current private credential after all user-controlled owner fields match.
  return admitted && connection.provider !== "suno" ? admitted : connection;
}

function requiredPlugin(
  connection: Pick<IntegrationConnection, "pluginId">,
): BuiltInAudioPluginDefinition {
  const plugin = builtInAudioPluginById(connection.pluginId);
  if (!plugin) {
    throw new Error("The selected Integration Connection Plugin is unavailable.");
  }
  return plugin;
}
