import { Buffer } from "node:buffer";
import { isDeepStrictEqual } from "node:util";

export const PLUGIN_CONFIG_NAMESPACE = "io.github.samkuler.live-smith";
export const MAX_PLUGIN_CONFIG_FIELDS = 64;
export const MAX_PLUGIN_CONFIG_BYTES = 64 * 1024;
export const MAX_PLUGIN_CONFIG_TEXT = 8192;

export type PluginConfigValue = string | number | boolean | string[];
export type PluginConfigValues = Record<string, PluginConfigValue>;
export interface PluginConfigField {
  name: string;
  type: "string" | "number" | "boolean" | "directory" | "file";
  title: string;
  description: string;
  required?: boolean;
  default?: PluginConfigValue;
  options?: string[];
  multiple?: boolean;
  sensitive?: boolean;
  min?: number;
  max?: number;
}
export interface StoredPluginConfig {
  revision: string;
  values: PluginConfigValues;
  secrets: PluginConfigValues;
}
export interface PluginConfigView {
  revision: string;
  fields: PluginConfigField[];
  values: PluginConfigValues;
  configuredSecrets: string[];
  invalidFields: string[];
}

export class PluginConfigError extends Error {
  constructor(message: string) { super(message); this.name = "PluginConfigError"; }
}
export class PluginConfigConflictError extends PluginConfigError {}

const keys = new Set(["type", "title", "description", "required", "default", "options", "multiple", "sensitive", "min", "max"]);
const namePattern = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
export const emptyPluginConfig = (): StoredPluginConfig => ({ revision: "0", values: {}, secrets: {} });
export const configRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, maximum = MAX_PLUGIN_CONFIG_TEXT): value is string =>
  typeof value === "string" && value.length <= maximum && !value.includes("\0");

/** Reads native userConfig and the same contract inside a namespaced extension. */
export function pluginConfigDeclaration(manifests: readonly Record<string, unknown>[]): PluginConfigField[] {
  const declarations: PluginConfigField[][] = [];
  for (const manifest of manifests) {
    const extension = configRecord(manifest.extensions) ? manifest.extensions[PLUGIN_CONFIG_NAMESPACE] : undefined;
    for (const raw of [manifest.userConfig, configRecord(extension) ? extension.userConfig : undefined]) {
      if (raw !== undefined) declarations.push(parsePluginConfig(raw));
    }
  }
  if (declarations.some((fields) => !isDeepStrictEqual(fields, declarations[0]))) {
    throw new PluginConfigError("Plugin manifests declare conflicting userConfig fields.");
  }
  return declarations[0] ?? [];
}

export function parsePluginConfig(value: unknown): PluginConfigField[] {
  if (!configRecord(value) || Object.keys(value).length > MAX_PLUGIN_CONFIG_FIELDS ||
      Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_PLUGIN_CONFIG_BYTES) {
    throw new PluginConfigError("Plugin userConfig declaration is invalid or too large.");
  }
  return Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([name, raw]) => {
    const fail = () => { throw new PluginConfigError(`Plugin userConfig field ${namePattern.test(name) ? name : "name"} is invalid.`); };
    if (!namePattern.test(name) || !configRecord(raw) || Object.keys(raw).some((key) => !keys.has(key)) ||
        !["string", "number", "boolean", "directory", "file"].includes(raw.type as string) ||
        !text(raw.title, 256) || !raw.title.trim() || !text(raw.description, 2048) ||
        ["required", "multiple", "sensitive"].some((key) => raw[key] !== undefined && typeof raw[key] !== "boolean") ||
        ["min", "max"].some((key) => raw[key] !== undefined && (raw.type !== "number" || typeof raw[key] !== "number" || !Number.isFinite(raw[key]))) ||
        raw.multiple === true && raw.type !== "string") return fail();
    const field = { name, ...raw } as unknown as PluginConfigField;
    if (field.min !== undefined && field.max !== undefined && field.min > field.max) return fail();
    if (field.options !== undefined && (field.type !== "string" || field.multiple || field.sensitive ||
        !Array.isArray(field.options) || !field.options.length || field.options.length > 64 ||
        field.options.some((option) => !text(option, 64) || !option.length) ||
        new Set(field.options).size !== field.options.length || field.default === undefined && !field.required)) return fail();
    if (field.default !== undefined && !validPluginConfigValue(field, field.default)) return fail();
    return field;
  });
}

export function validPluginConfigValue(field: PluginConfigField, value: unknown): value is PluginConfigValue {
  if (field.multiple) return Array.isArray(value) && value.length <= 64 && (!field.required || value.length > 0) &&
    value.every((entry) => text(entry) && (!field.required || entry.trim().length > 0));
  if (field.type === "number") return typeof value === "number" && Number.isFinite(value) &&
    (field.min === undefined || value >= field.min) && (field.max === undefined || value <= field.max);
  if (field.type === "boolean") return typeof value === "boolean";
  return text(value) && (!field.required || value.trim().length > 0) &&
    (field.options === undefined || field.options.includes(value));
}

export function pluginConfigValue(field: PluginConfigField, stored: StoredPluginConfig): PluginConfigValue | undefined {
  const source = field.sensitive ? stored.secrets : stored.values;
  return Object.hasOwn(source, field.name) ? source[field.name] : field.default;
}

export function invalidPluginConfigFields(fields: readonly PluginConfigField[], stored: StoredPluginConfig): string[] {
  return fields.filter((field) => {
    const value = pluginConfigValue(field, stored);
    return value === undefined ? field.required : !validPluginConfigValue(field, value);
  }).map((field) => field.name);
}

export function pluginConfigView(fields: readonly PluginConfigField[], stored: StoredPluginConfig): PluginConfigView {
  return {
    revision: stored.revision,
    fields: fields.map(({ default: initial, ...field }) => ({ ...field,
      ...(initial === undefined || field.sensitive ? {} : { default: initial }),
    })),
    values: Object.fromEntries(fields.filter((field) => !field.sensitive).flatMap((field) => {
      const value = pluginConfigValue(field, stored);
      return value === undefined ? [] : [[field.name, value]];
    })),
    configuredSecrets: fields.filter((field) => field.sensitive && pluginConfigValue(field, stored) !== undefined).map((field) => field.name),
    invalidFields: invalidPluginConfigFields(fields, stored),
  };
}

export function updatePluginConfig(
  fields: readonly PluginConfigField[], stored: StoredPluginConfig,
  values: Record<string, unknown>, secretUpdates: Record<string, unknown>,
): StoredPluginConfig {
  const definitions = new Map(fields.map((field) => [field.name, field]));
  for (const [sensitive, entries] of [[false, values], [true, secretUpdates]] as const) {
    for (const [name, value] of Object.entries(entries)) {
      const field = definitions.get(name);
      if (!field || Boolean(field.sensitive) !== sensitive ||
          !(sensitive && value === null) && !validPluginConfigValue(field, value)) {
        throw new PluginConfigError(`Plugin parameter ${namePattern.test(name) ? name : "name"} has an invalid value.`);
      }
    }
  }
  const secrets = Object.fromEntries(fields.filter((field) => field.sensitive).flatMap((field) => {
    const value = Object.hasOwn(secretUpdates, field.name) ? secretUpdates[field.name]
      : Object.hasOwn(stored.secrets, field.name) ? stored.secrets[field.name] : undefined;
    return value === undefined || value === null ? [] : [[field.name, value as PluginConfigValue]];
  }));
  const next = { revision: String(BigInt(stored.revision) + 1n), values: values as PluginConfigValues, secrets };
  const invalid = invalidPluginConfigFields(fields, next);
  if (invalid.length) throw new PluginConfigError(`Configure Plugin parameters: ${invalid.join(", ")}.`);
  if (Buffer.byteLength(JSON.stringify(next), "utf8") > MAX_PLUGIN_CONFIG_BYTES) throw new PluginConfigError("Plugin configuration is too large.");
  return next;
}

export function decodeStoredPluginConfig(value: unknown): StoredPluginConfig {
  const validValues = (source: unknown) => configRecord(source) && Object.entries(source).every(([name, entry]) =>
    namePattern.test(name) && (text(entry) || typeof entry === "boolean" || typeof entry === "number" && Number.isFinite(entry) ||
      Array.isArray(entry) && entry.length <= 64 && entry.every((item) => text(item))));
  if (!configRecord(value) || Object.keys(value).some((key) => !["revision", "values", "secrets"].includes(key)) ||
      typeof value.revision !== "string" || !/^(?:0|[1-9]\d{0,30})$/u.test(value.revision) ||
      !validValues(value.values) || !validValues(value.secrets)) throw new PluginConfigError("Plugin configuration storage is invalid.");
  return value as unknown as StoredPluginConfig;
}

export function resolvePluginConfigReference(
  name: string, fields: readonly PluginConfigField[], stored: StoredPluginConfig, audience: "skill" | "mcp",
): string {
  const field = fields.find((entry) => entry.name === name);
  if (!field) throw new PluginConfigError(`Plugin parameter ${name} is not declared.`);
  if (audience === "skill" && field.sensitive) return "[sensitive value]";
  const value = pluginConfigValue(field, stored);
  if (value === undefined || !validPluginConfigValue(field, value)) {
    throw new PluginConfigError(`Configure Plugin parameter ${name} before using it.`);
  }
  return Array.isArray(value) ? JSON.stringify(value) : String(value);
}

export function renderPluginConfigText(body: string, fields: readonly PluginConfigField[], stored: StoredPluginConfig): string {
  return body.replace(/\$\{user_config\.([A-Za-z_][A-Za-z0-9_]*)\}/gu,
    (_whole, name: string) => resolvePluginConfigReference(name, fields, stored, "skill"));
}
