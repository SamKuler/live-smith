import type { AudioServiceConnection } from "../../../src/audio-services/contracts.js";
import {
  migrateAudioServiceConnection,
  type PluginIntegrationConnection,
  type IntegrationConnectionsSettingsPatch,
} from "../../../src/plugins/integration-connections.js";
import { saveGlobalSettings } from "../../../src/storage/settings.js";
import type { RuntimeIntegrationConnection } from "../../../src/app/integration-connections.js";

export function integrationConnectionFixture(
  input: AudioServiceConnection,
): PluginIntegrationConnection {
  return migrateAudioServiceConnection(input);
}

export function integrationConnectionUpsert(
  expectedRevision: string,
  input: AudioServiceConnection,
  includeSecrets = true,
): IntegrationConnectionsSettingsPatch {
  const connection = integrationConnectionFixture(input);
  const { secrets, ...fields } = connection;
  return {
    action: "upsert",
    expectedRevision,
    connection: { ...fields, ...(includeSecrets ? { secrets } : {}) },
  };
}

export function saveIntegrationConnection(
  storageDirectory: string,
  expectedRevision: string,
  input: AudioServiceConnection,
) {
  return saveGlobalSettings(storageDirectory, {
    integrationConnections: integrationConnectionUpsert(expectedRevision, input),
  });
}

export function runtimeIntegrationConnectionFixture(
  input: AudioServiceConnection,
): RuntimeIntegrationConnection {
  return {
    ...integrationConnectionFixture(input),
    provider: input.provider,
    apiKey: input.apiKey,
    ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
    ...(input.callbackUrl === undefined ? {} : { callbackUrl: input.callbackUrl }),
  };
}
