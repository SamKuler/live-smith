import type { AudioServiceConnection } from "../audio-services/contracts.js";
import {
  migrateAudioServiceConnection,
  type IntegrationConnection,
  type IntegrationConnectionsSettingsPatch,
} from "../plugins/integration-connections.js";
import { saveGlobalSettings } from "../storage/settings.js";
import type { RuntimeIntegrationConnection } from "./integration-connections.js";

export function integrationConnectionFixture(
  input: AudioServiceConnection,
): IntegrationConnection {
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
