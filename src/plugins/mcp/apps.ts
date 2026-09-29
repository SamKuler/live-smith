import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { McpUiResourceCsp } from "@modelcontextprotocol/ext-apps/app-bridge";

export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";
export const MAX_MCP_APP_BYTES = 2 * 1024 * 1024;
export interface PluginAppMetadata { resourceUri?: string; visibility?: ("app" | "model")[] }
export interface PluginAppDescriptor { resourceUri: string; signature: string; toolName: string }

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
export function pluginAppMetadata(meta: unknown): PluginAppMetadata | undefined {
  if (!record(meta)) return undefined;
  const ui = record(meta.ui) ? meta.ui : {};
  const uri = ui.resourceUri ?? meta["ui/resourceUri"];
  const visibility = ui.visibility;
  if (uri === undefined && visibility === undefined) return undefined;
  if (uri !== undefined && (typeof uri !== "string" || !/^ui:\/\/[^\s\u0000-\u001f]{1,2048}$/u.test(uri))) {
    throw new Error("Plugin UI resource URI is invalid.");
  }
  if (visibility !== undefined && (!Array.isArray(visibility) || visibility.length > 2 ||
      visibility.some((entry) => entry !== "app" && entry !== "model") || new Set(visibility).size !== visibility.length)) {
    throw new Error("Plugin UI visibility is invalid.");
  }
  return { ...(uri ? { resourceUri: uri as string } : {}),
    ...(visibility ? { visibility: visibility as ("app" | "model")[] } : {}) };
}

export const appVisibility = (metadata: PluginAppMetadata | undefined, audience: "app" | "model"): boolean =>
  metadata?.visibility === undefined || metadata.visibility.includes(audience);

export function pluginAppDescriptor(metadata: PluginAppMetadata | undefined, toolName: string, identity: unknown): PluginAppDescriptor | undefined {
  return metadata?.resourceUri ? {
    resourceUri: metadata.resourceUri,
    toolName,
    signature: createHash("sha256").update(JSON.stringify([toolName, metadata, identity])).digest("hex"),
  } : undefined;
}

export function appResourceDocument(result: unknown, uri: string): { html: string; csp?: McpUiResourceCsp } {
  if (!record(result) || !Array.isArray(result.contents) || result.contents.length !== 1) throw new Error("Plugin UI resource is invalid.");
  const resource = result.contents[0];
  if (!record(resource) || resource.uri !== uri || resource.mimeType !== MCP_APP_MIME_TYPE) throw new Error("Plugin UI resource type is unsupported.");
  const html = typeof resource.text === "string" ? resource.text : typeof resource.blob === "string"
    ? Buffer.from(resource.blob, "base64").toString("utf8") : undefined;
  if (!html || Buffer.byteLength(html, "utf8") > MAX_MCP_APP_BYTES) throw new Error("Plugin UI resource is empty or too large.");
  const meta = record(resource._meta) && record(resource._meta.ui) ? resource._meta.ui : undefined;
  const csp = meta?.csp;
  if (csp !== undefined && !record(csp)) throw new Error("Plugin UI resource CSP is invalid.");
  if (meta?.permissions !== undefined && record(meta.permissions) && Object.keys(meta.permissions).length) {
    throw new Error("This Plugin UI requires browser permissions that Live Smith does not support.");
  }
  return { html, ...(csp ? { csp: csp as McpUiResourceCsp } : {}) };
}
