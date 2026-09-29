import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";

export const MAX_PLUGIN_PARAMETER_FIELDS = 32;
export const MAX_PLUGIN_PARAMETER_TEXT = 16_384;
export const MAX_PLUGIN_PARAMETER_BYTES = 64 * 1024;
export const MAX_PLUGIN_PARAMETER_PANEL_BYTES = 16 * 1024;

export type PluginParameterValue = string | number | boolean;

export interface PluginParameterField {
  name: string;
  title: string;
  description?: string;
  type: "string" | "number" | "integer" | "boolean";
  required: boolean;
  default?: PluginParameterValue;
  enum?: PluginParameterValue[];
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
  minLength?: number;
  maxLength?: number;
}

export interface PluginParameterPanel {
  toolName: string;
  signature: string;
  fields: PluginParameterField[];
}

const annotationKeys = ["title", "description"];
const objectKeys = new Set(["type", "properties", "required", "additionalProperties", "$schema", ...annotationKeys]);
const fieldKeys = new Set(["type", "default", "enum", ...annotationKeys]);
const numberKeys = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"] as const;
const stringKeys = ["minLength", "maxLength"] as const;

/** Projects only schemas whose complete argument constraints the native form can enforce. */
export function pluginParameterPanel(
  toolName: string,
  schema: unknown,
  sourceIdentity: unknown,
): PluginParameterPanel | undefined {
  if (!record(schema) || schema.type !== "object" ||
      Object.keys(schema).some((key) => !objectKeys.has(key)) ||
      schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean" ||
      schema.properties !== undefined && !record(schema.properties)) return undefined;
  const properties = (schema.properties ?? {}) as Record<string, unknown>;
  const entries = Object.entries(properties);
  if (entries.length > MAX_PLUGIN_PARAMETER_FIELDS) return undefined;
  const required = schema.required ?? [];
  if (!Array.isArray(required) || required.some((key) => typeof key !== "string" || !Object.hasOwn(properties, key)) ||
      new Set(required).size !== required.length) return undefined;
  const fields: PluginParameterField[] = [];
  for (const [name, value] of entries) {
    if (!safeText(name, 128) || !record(value) || typeof value.type !== "string" ||
        !["string", "number", "integer", "boolean"].includes(value.type)) return undefined;
    const type = value.type as PluginParameterField["type"];
    const constraintKeys = type === "string" ? stringKeys : type === "boolean" ? [] : numberKeys;
    if (Object.keys(value).some((key) => !fieldKeys.has(key) && !constraintKeys.includes(key as never)) ||
        value.title !== undefined && !safeText(value.title, 128) ||
        value.description !== undefined && !safeText(value.description, 1024)) return undefined;
    const field: PluginParameterField = {
      name, type, title: typeof value.title === "string" ? value.title : name,
      required: required.includes(name),
      ...(value.description === undefined ? {} : { description: value.description as string }),
    };
    for (const key of constraintKeys) {
      const limit = value[key];
      if (limit === undefined) continue;
      if (typeof limit !== "number" || !Number.isFinite(limit) ||
          key === "multipleOf" && limit <= 0 ||
          (key === "minLength" || key === "maxLength") && (!Number.isInteger(limit) || limit < 0)) return undefined;
      field[key] = limit;
    }
    if (field.minLength !== undefined && field.minLength > MAX_PLUGIN_PARAMETER_TEXT ||
        field.minimum !== undefined && field.maximum !== undefined && field.minimum > field.maximum ||
        field.minLength !== undefined && field.maxLength !== undefined && field.minLength > field.maxLength) return undefined;
    if (value.enum !== undefined) {
      if (!Array.isArray(value.enum) || !value.enum.length || value.enum.length > 64 ||
          value.enum.some((item) => !validValue(field, item))) return undefined;
      field.enum = [...value.enum] as PluginParameterValue[];
    }
    if (Object.hasOwn(value, "default")) {
      if (!validValue(field, value.default)) return undefined;
      field.default = value.default as PluginParameterValue;
    }
    fields.push(field);
  }
  const panel = {
    toolName,
    signature: createHash("sha256").update(JSON.stringify([toolName, schema, sourceIdentity])).digest("hex"),
    fields,
  };
  return Buffer.byteLength(JSON.stringify(panel), "utf8") <= MAX_PLUGIN_PARAMETER_PANEL_BYTES ? panel : undefined;
}

export function validatePluginParameters(panel: PluginParameterPanel, value: unknown): Record<string, PluginParameterValue> {
  if (!record(value) || Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_PLUGIN_PARAMETER_BYTES ||
      Object.keys(value).some((name) => !panel.fields.some((field) => field.name === name))) {
    throw new Error("Plugin parameters do not match this tool's form.");
  }
  for (const field of panel.fields) {
    if (!Object.hasOwn(value, field.name)) {
      if (field.required) throw new Error(`Required parameter is missing: ${field.title}.`);
    } else if (!validValue(field, value[field.name])) {
      throw new Error(`Invalid value for parameter: ${field.title}.`);
    }
  }
  return value as Record<string, PluginParameterValue>;
}

function validValue(field: PluginParameterField, value: unknown): value is PluginParameterValue {
  if (field.type === "string") {
    if (typeof value !== "string" || value.includes("\0")) return false;
    const length = [...value].length;
    if (length > MAX_PLUGIN_PARAMETER_TEXT || length < (field.minLength ?? 0) || length > (field.maxLength ?? MAX_PLUGIN_PARAMETER_TEXT)) return false;
  } else if (field.type === "boolean") {
    if (typeof value !== "boolean") return false;
  } else {
    if (typeof value !== "number" || !Number.isFinite(value) || field.type === "integer" && !Number.isInteger(value) ||
        field.minimum !== undefined && value < field.minimum || field.maximum !== undefined && value > field.maximum ||
        field.exclusiveMinimum !== undefined && value <= field.exclusiveMinimum ||
        field.exclusiveMaximum !== undefined && value >= field.exclusiveMaximum) return false;
    if (field.multipleOf !== undefined) {
      const quotient = value / field.multipleOf;
      if (!Number.isFinite(quotient) || Math.abs(quotient - Math.round(quotient)) > 1e-8) return false;
    }
  }
  return field.enum === undefined || field.enum.includes(value as PluginParameterValue);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value);
}
