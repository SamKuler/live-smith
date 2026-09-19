import { isAudioServiceCallbackUrl, ProfileValidationError } from "../model/profile.js";
import { isAudioServiceModelId } from "../audio-services/model-id.js";
import type {
  AudioServiceConnection,
  AudioServicesSettings,
} from "../audio-services/contracts.js";
import {
  AUDIO_PROVIDERS,
  MAX_AUDIO_SERVICES,
  type AudioProvider,
} from "../audio-services/contracts.js";
import { isSafePluginId } from "./contracts.js";
import {
  builtInAudioPluginById,
  builtInAudioPluginId,
} from "./builtins/index.js";

export const MAX_INTEGRATION_CONNECTIONS = 20;

export interface IntegrationConnection {
  id: string;
  name: string;
  pluginId: string;
  enabled: boolean;
  configuration: Record<string, string>;
  secrets: Record<string, string>;
}

export interface IntegrationConnectionsSettings {
  connections: IntegrationConnection[];
  revision: string;
}

export interface IntegrationConnectionView extends Omit<IntegrationConnection, "secrets"> {
  configuredSecrets: string[];
}

export interface IntegrationConnectionsView {
  connections: IntegrationConnectionView[];
  revision: string;
}

export type IntegrationConnectionsSettingsPatch =
  | {
      action: "upsert";
      expectedRevision: string;
      connection: Omit<IntegrationConnection, "secrets"> & { secrets?: Record<string, string> };
    }
  | { action: "remove"; expectedRevision: string; connectionId: string };

const connectionKeys = new Set([
  "id",
  "name",
  "pluginId",
  "enabled",
  "configuration",
  "secrets",
]);

export function normalizeIntegrationConnection(value: unknown): IntegrationConnection {
  const record = plainRecord(value);
  if (!record || Object.keys(record).some((key) => !connectionKeys.has(key)) ||
      !safeConnectionId(record.id) || typeof record.name !== "string" ||
      !record.name.trim() || record.name.length > 120 || /[\x00-\x1f\x7f]/u.test(record.name) ||
      !isSafePluginId(record.pluginId) || typeof record.enabled !== "boolean") {
    throw invalid("Integration connections require a safe ID, name, Plugin ID, enabled state, configuration, and secrets.");
  }
  const plugin = builtInAudioPluginById(record.pluginId);
  if (!plugin) throw invalid("The selected Plugin does not expose a supported Integration Connection.");
  const configuration = stringMap(record.configuration, 16, 2_048, "configuration");
  const secrets = stringMap(record.secrets, 8, 4_096, "secrets", true);
  const allowedConfiguration = new Set<string>([
    ...(plugin.connection.modelConfigurable ? ["modelId"] : []),
    ...(plugin.connection.callbackUrl ? ["callbackUrl"] : []),
  ]);
  if (Object.keys(configuration).some((key) => !allowedConfiguration.has(key))) {
    throw invalid("This Plugin connection contains unsupported configuration fields.");
  }
  // Historical Suno.com records could retain an unused API-key field after a
  // provider switch. Preserve it through migration even though the website
  // Plugin authenticates through its separate private Session store.
  const allowedSecrets = new Set(["apiKey"]);
  if (Object.keys(secrets).some((key) => !allowedSecrets.has(key))) {
    throw invalid("This Plugin connection contains unsupported secret fields.");
  }
  const modelId = configuration.modelId;
  if (modelId !== undefined && !isAudioServiceModelId(modelId)) {
    throw invalid("The Plugin connection model ID is invalid.");
  }
  const callbackUrl = configuration.callbackUrl;
  if (callbackUrl !== undefined && !isAudioServiceCallbackUrl(callbackUrl) ||
      plugin.connection.callbackUrl && record.enabled && callbackUrl === undefined) {
    throw invalid("SunoAPI.org requires an HTTP or HTTPS callback URL to enable: at most 2048 characters, valid encoding, and no embedded credentials, fragment, or whitespace.");
  }
  const apiKey = secrets.apiKey ?? "";
  if (callbackUrl !== undefined && apiKey &&
      decodeURIComponent(callbackUrl).toLowerCase().includes(apiKey.toLowerCase())) {
    throw invalid("The callback URL must not contain API credentials.");
  }
  if (record.enabled && !plugin.audio.operations.length) {
    throw invalid("This Plugin has no available public tool protocol and cannot be enabled.");
  }
  if (record.enabled && !apiKey && plugin.connection.authentication === "api-key") {
    throw invalid("An enabled Integration Connection requires an API key.");
  }
  return {
    id: record.id,
    name: record.name.trim(),
    pluginId: record.pluginId,
    enabled: record.enabled,
    configuration,
    secrets,
  };
}

export function normalizeIntegrationConnectionsSettings(
  value: unknown,
): IntegrationConnectionsSettings {
  const record = plainRecord(value);
  if (!record || Object.keys(record).some((key) => !["connections", "revision"].includes(key)) ||
      !Array.isArray(record.connections) || record.connections.length > MAX_INTEGRATION_CONNECTIONS ||
      !isRevision(record.revision)) {
    throw invalid("Integration Connections require at most 20 named connections and a valid revision.");
  }
  const connections = record.connections.map(normalizeIntegrationConnection);
  if (new Set(connections.map((connection) => connection.id)).size !== connections.length ||
      new Set(connections.map((connection) => connection.name.toLowerCase())).size !== connections.length) {
    throw invalid("Integration Connection IDs and names must be unique.");
  }
  return { connections, revision: record.revision };
}

export function migrateAudioServicesSettings(
  settings: AudioServicesSettings,
): IntegrationConnectionsSettings {
  return normalizeIntegrationConnectionsSettings({
    revision: settings.revision,
    connections: settings.connections.map(migrateAudioServiceConnection),
  });
}

/** Frozen schema-v8 decoder used only by the settings migration. */
export function normalizeLegacyAudioServiceConnection(value: unknown): AudioServiceConnection {
  const record = plainRecord(value);
  if (!record || Object.keys(record).some((key) =>
    !["id", "name", "provider", "enabled", "apiKey", "modelId", "callbackUrl"].includes(key)) ||
    !safeConnectionId(record.id) || typeof record.name !== "string" ||
    !record.name.trim() || record.name.length > 120 || /[\x00-\x1f\x7f]/u.test(record.name) ||
    !AUDIO_PROVIDERS.includes(record.provider as AudioServiceConnection["provider"]) ||
    typeof record.enabled !== "boolean" || typeof record.apiKey !== "string" ||
    record.apiKey.length > 4_096 || /[^\x21-\x7e]/u.test(record.apiKey) ||
    Object.hasOwn(record, "modelId") && !isAudioServiceModelId(record.modelId)) {
    throw legacyInvalid("Audio connections require a safe ID, a name, a supported provider, valid credentials, and an optional model ID.");
  }
  const provider = record.provider as AudioServiceConnection["provider"];
  const plugin = builtInAudioPluginId(provider);
  const definition = builtInAudioPluginById(plugin)!;
  if (Object.hasOwn(record, "modelId") && !definition.connection.modelConfigurable) {
    throw legacyInvalid("A music model ID is not configurable for this provider.");
  }
  if (Object.hasOwn(record, "callbackUrl") &&
      (!definition.connection.callbackUrl || !isAudioServiceCallbackUrl(record.callbackUrl)) ||
      definition.connection.callbackUrl && record.enabled && !Object.hasOwn(record, "callbackUrl")) {
    throw legacyInvalid("SunoAPI.org requires an HTTP or HTTPS callback URL to enable: at most 2048 characters, valid encoding, and no embedded credentials, fragment, or whitespace. Other providers do not support a callback URL.");
  }
  if (typeof record.callbackUrl === "string" && record.apiKey &&
      decodeURIComponent(record.callbackUrl).toLowerCase().includes(record.apiKey.toLowerCase())) {
    throw legacyInvalid("The callback URL must not contain API credentials.");
  }
  if (record.enabled && !definition.audio.operations.length) {
    throw legacyInvalid("This audio provider has no available public protocol and cannot be enabled.");
  }
  if (record.enabled && !record.apiKey && definition.connection.authentication === "api-key") {
    throw legacyInvalid("An enabled audio connection requires an API key.");
  }
  return {
    id: record.id,
    name: record.name.trim(),
    provider,
    enabled: record.enabled,
    apiKey: record.apiKey,
    ...(typeof record.modelId === "string" ? { modelId: record.modelId } : {}),
    ...(typeof record.callbackUrl === "string" ? { callbackUrl: record.callbackUrl } : {}),
  };
}

/** Frozen schema-v8 decoder used only by the settings migration. */
export function normalizeLegacyAudioServicesSettings(value: unknown): AudioServicesSettings {
  const record = plainRecord(value);
  if (!record || Object.keys(record).some((key) => !["connections", "revision"].includes(key)) ||
      !Array.isArray(record.connections) || record.connections.length > MAX_AUDIO_SERVICES ||
      !isRevision(record.revision)) {
    throw legacyInvalid("Audio tools require at most 20 named connections and a valid revision.");
  }
  const connections = record.connections.map(normalizeLegacyAudioServiceConnection);
  if (new Set(connections.map((connection) => connection.id)).size !== connections.length ||
      new Set(connections.map((connection) => connection.name.toLowerCase())).size !== connections.length) {
    throw legacyInvalid("Audio connection IDs and names must be unique.");
  }
  return { connections, revision: record.revision };
}

export function migrateAudioServiceConnection(
  connection: AudioServiceConnection,
): IntegrationConnection {
  return normalizeIntegrationConnection({
    id: connection.id,
    name: connection.name,
    pluginId: builtInAudioPluginId(connection.provider),
    enabled: connection.enabled,
    configuration: {
      ...(connection.modelId === undefined ? {} : { modelId: connection.modelId }),
      ...(connection.callbackUrl === undefined ? {} : { callbackUrl: connection.callbackUrl }),
    },
    secrets: connection.apiKey ? { apiKey: connection.apiKey } : {},
  });
}

export function integrationConnectionsView(
  settings: IntegrationConnectionsSettings | undefined,
): IntegrationConnectionsView {
  return {
    connections: (settings?.connections ?? []).map((connection) => ({
      id: connection.id,
      name: connection.name,
      pluginId: connection.pluginId,
      enabled: connection.enabled,
      configuration: { ...connection.configuration },
      configuredSecrets: Object.entries(connection.secrets)
        .filter(([, secret]) => Boolean(secret))
        .map(([name]) => name)
        .sort(),
    })),
    revision: settings?.revision ?? "0",
  };
}

export function integrationConnectionProvider(
  connection: Pick<IntegrationConnection, "pluginId">,
): AudioProvider | undefined {
  return builtInAudioPluginById(connection.pluginId)?.provider;
}

export function isIntegrationConnectionForProvider(
  connection: Pick<IntegrationConnection, "pluginId">,
  provider: AudioProvider,
): boolean {
  return connection.pluginId === builtInAudioPluginId(provider);
}

function stringMap(
  value: unknown,
  maximumEntries: number,
  maximumValueLength: number,
  label: string,
  printableAscii = false,
): Record<string, string> {
  const record = plainRecord(value);
  if (!record || Object.keys(record).length > maximumEntries) {
    throw invalid(`Integration Connection ${label} is invalid.`);
  }
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(key) || typeof entry !== "string" ||
        entry.length > maximumValueLength || entry.includes("\0") ||
        printableAscii && /[^\x21-\x7e]/u.test(entry)) {
      throw invalid(`Integration Connection ${label} is invalid.`);
    }
    result[key] = entry;
  }
  return result;
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype
    ? value as Record<string, unknown>
    : undefined;
}

function safeConnectionId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value);
}

function isRevision(value: unknown): value is string {
  return typeof value === "string" && /^(?:0|[1-9]\d*)$/u.test(value);
}

function invalid(message: string): ProfileValidationError {
  return new ProfileValidationError("integrationConnections", message);
}

function legacyInvalid(message: string): ProfileValidationError {
  return new ProfileValidationError("audioServices", message);
}
