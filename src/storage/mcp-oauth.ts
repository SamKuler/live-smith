import { Buffer } from "node:buffer";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { specTypeSchemas, type StoredOAuthClientInformation, type StoredOAuthTokens } from "@modelcontextprotocol/client";
import { cloneJsonValue } from "../model/json-clone.js";
import { McpOAuthError } from "../plugins/mcp/oauth-contract.js";
import { isSafeStorageId } from "./id.js";
import { isMissingFileError } from "./errors.js";
import { ensurePrivateFile, requireActiveStorageTransaction, writeJsonAtomically, type StorageTransactionContext } from "./persistence.js";

export interface McpOAuthCredential {
  connectionId: string;
  owner: string;
  generation: string;
  pluginId?: string;
  serverId?: string;
  redirectUri: string;
  client?: StoredOAuthClientInformation;
  tokens?: StoredOAuthTokens;
}
const maximumBytes = 1024 * 1024;
const fileName = "live-smith-mcp-oauth.json";
const invalid = () => new McpOAuthError("MCP sign-in storage is invalid. No credentials were changed.");

async function readStore(directory: string): Promise<McpOAuthCredential[]> {
  const file = path.join(directory, fileName);
  try {
    await ensurePrivateFile(file);
    if ((await fs.stat(file)).size > maximumBytes) throw invalid();
    const value: unknown = JSON.parse(await fs.readFile(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
    const record = value as Record<string, unknown>;
    if (record.version !== 1 || Object.keys(record).length !== 2 || !Array.isArray(record.credentials) || record.credentials.length > 20) throw invalid();
    for (const entry of record.credentials) await validate(entry);
    if (new Set(record.credentials.map((entry) => entry.connectionId)).size !== record.credentials.length) throw invalid();
    return record.credentials as McpOAuthCredential[];
  } catch (error) {
    if (isMissingFileError(error)) return [];
    throw invalid();
  }
}

async function validate(value: unknown): Promise<void> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const entry = value as Record<string, unknown>;
  if (Object.keys(entry).some((key) => !["connectionId", "owner", "generation", "pluginId", "serverId", "redirectUri", "client", "tokens"].includes(key)) ||
    !isSafeStorageId(entry.connectionId) || typeof entry.owner !== "string" || !/^[a-f0-9]{64}$/u.test(entry.owner) ||
    typeof entry.generation !== "string" || !/^[a-f0-9-]{36}$/u.test(entry.generation) ||
    typeof entry.redirectUri !== "string" || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/mcp\/oauth\/callback$/u.test(entry.redirectUri) ||
    entry.pluginId !== undefined && (typeof entry.pluginId !== "string" || entry.pluginId.length > 64) ||
    entry.serverId !== undefined && (typeof entry.serverId !== "string" || entry.serverId.length > 64)) throw invalid();
  for (const [key, schema] of [["tokens", specTypeSchemas.OAuthTokens], ["client", specTypeSchemas.OAuthClientInformation]] as const) {
    const credential = entry[key];
    if (credential === undefined) continue;
    if (!credential || typeof credential !== "object" || Array.isArray(credential) ||
      !("issuer" in credential) || typeof credential.issuer !== "string" || !credential.issuer || credential.issuer.length > 2048 ||
      JSON.stringify(credential).length > 32_768 || (await schema["~standard"].validate(credential)).issues) throw invalid();
  }
}

export async function readMcpOAuthCredentialInTransaction(
  transaction: StorageTransactionContext, directory: string, connectionId: string,
): Promise<McpOAuthCredential | undefined> {
  requireActiveStorageTransaction(transaction, directory);
  const credential = (await readStore(directory)).find((entry) => entry.connectionId === connectionId);
  return credential === undefined ? undefined : cloneJsonValue(credential);
}

export async function saveMcpOAuthCredentialInTransaction(
  transaction: StorageTransactionContext, directory: string, credential: McpOAuthCredential, expectedGeneration: string | null,
): Promise<void> {
  requireActiveStorageTransaction(transaction, directory);
  await validate(credential);
  const credentials = await readStore(directory);
  const current = credentials.find((entry) => entry.connectionId === credential.connectionId);
  if ((current?.generation ?? null) !== expectedGeneration) throw new McpOAuthError("This MCP sign-in changed. Sign in again from its current connection settings.");
  const updated = [...credentials.filter((entry) => entry.connectionId !== credential.connectionId), cloneJsonValue(credential)];
  if (updated.length > 20 || Buffer.byteLength(JSON.stringify({ version: 1, credentials: updated }), "utf8") > maximumBytes) throw invalid();
  await writeJsonAtomically(path.join(directory, fileName), { version: 1, credentials: updated });
}

export async function deleteMcpOAuthCredentialsInTransaction(
  transaction: StorageTransactionContext, directory: string | undefined,
  target: { connectionId: string } | { pluginId: string; serverId?: string },
): Promise<boolean> {
  requireActiveStorageTransaction(transaction, directory);
  if (!directory) return false;
  const credentials = await readStore(directory);
  const retained = credentials.filter((entry) => "connectionId" in target ? entry.connectionId !== target.connectionId
    : entry.pluginId !== target.pluginId || target.serverId !== undefined && entry.serverId !== target.serverId);
  if (retained.length === credentials.length) return false;
  await writeJsonAtomically(path.join(directory, fileName), { version: 1, credentials: retained });
  return true;
}
