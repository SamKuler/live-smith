import { readStoredText, storedEntry, writeStoredJson } from "./sqlite.js";
import { Buffer } from "node:buffer";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import * as path from "node:path";
import { isSafeStorageId } from "./id.js";
import { isMissingFileError } from "./errors.js";
import { withStorageTransaction } from "./persistence.js";

export interface McpServerClient {
  id: string;
  name: string;
  projectKey: string;
  sessionId: string;
  generation: string;
  createdAt: string;
}
interface StoredClient extends McpServerClient { digest: string }
const fileName = "live-smith-mcp-server-clients.json";
const maxClients = 64;
const invalid = () => new Error("MCP server client storage is invalid. Repair the private client record before changing access.");
const text = (value: unknown, maximum: number): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(value);
const digest = (token: string) => createHash("sha256").update(token).digest("hex");
const view = ({ digest: _digest, ...client }: StoredClient): McpServerClient => client;

async function readClients(directory: string): Promise<StoredClient[]> {
  const file = path.resolve(directory, fileName);
  try {
    if (((await storedEntry(directory, file))?.byteLength ?? 0) > 256 * 1024) throw invalid();
    const store: unknown = JSON.parse(await readStoredText(directory, file));
    if (!store || typeof store !== "object" || Array.isArray(store)) throw invalid();
    const record = store as Record<string, unknown>;
    if (record.version !== 1 || Object.keys(record).length !== 2 || !Array.isArray(record.clients) || record.clients.length > maxClients) throw invalid();
    const ids = new Set<string>();
    for (const raw of record.clients) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalid();
      const client = raw as Record<string, unknown>;
      if (Object.keys(client).length !== 7 || !isSafeStorageId(client.id) || !isSafeStorageId(client.sessionId) ||
        !text(client.name, 120) || !text(client.projectKey, 2048) || !isSafeStorageId(client.generation) ||
        typeof client.createdAt !== "string" || !Number.isFinite(Date.parse(client.createdAt)) ||
        typeof client.digest !== "string" || !/^[a-f0-9]{64}$/u.test(client.digest) || ids.has(client.id)) throw invalid();
      ids.add(client.id);
    }
    return record.clients as StoredClient[];
  } catch (error) {
    if (isMissingFileError(error)) return [];
    throw invalid();
  }
}

export async function listMcpServerClients(directory: string): Promise<McpServerClient[]> {
  return (await readClients(directory)).map(view);
}

export async function createMcpServerClient(directory: string, input: Pick<McpServerClient, "name" | "projectKey" | "sessionId">): Promise<{ client: McpServerClient; token: string }> {
  if (!text(input.name, 120) || !text(input.projectKey, 2048) || !isSafeStorageId(input.sessionId)) throw new Error("Choose a client name and an existing Session.");
  return withStorageTransaction(directory, async () => {
    const clients = await readClients(directory);
    if (clients.length >= maxClients) throw new Error("Remove an unused MCP client before creating another.");
    const id = randomUUID();
    const token = `${id}.${randomBytes(32).toString("base64url")}`;
    const client: StoredClient = { id, name: input.name.trim(), projectKey: input.projectKey, sessionId: input.sessionId,
      generation: randomUUID(), createdAt: new Date().toISOString(), digest: digest(token) };
    await writeStoredJson(directory, path.resolve(directory, fileName), { version: 1, clients: [...clients, client] });
    return { client: view(client), token };
  });
}

export async function authenticateMcpServerClient(directory: string, token: string): Promise<McpServerClient | undefined> {
  if (token.length > 256 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u.test(token)) return undefined;
  const id = token.split(".", 1)[0];
  const client = (await readClients(directory)).find((entry) => entry.id === id);
  if (!client || !timingSafeEqual(Buffer.from(client.digest, "hex"), Buffer.from(digest(token), "hex"))) return undefined;
  return view(client);
}

export async function assertMcpServerClientCurrent(directory: string, client: McpServerClient): Promise<void> {
  const current = (await readClients(directory)).find((entry) => entry.id === client.id);
  if (!current || current.generation !== client.generation) throw new Error("MCP client access changed. Reconnect using its current credentials.");
}

export async function rotateMcpServerClient(directory: string, id: string, generation: string): Promise<{ client: McpServerClient; token: string }> {
  return withStorageTransaction(directory, async () => {
    const clients = await readClients(directory);
    const client = clients.find((entry) => entry.id === id);
    if (!client || client.generation !== generation) throw new Error("This MCP client changed. Refresh its access settings.");
    const token = `${id}.${randomBytes(32).toString("base64url")}`;
    client.digest = digest(token);
    client.generation = randomUUID();
    await writeStoredJson(directory, path.resolve(directory, fileName), { version: 1, clients });
    return { client: view(client), token };
  });
}

export async function revokeMcpServerClient(directory: string, id: string, generation: string): Promise<void> {
  await withStorageTransaction(directory, async () => {
    const clients = await readClients(directory);
    const client = clients.find((entry) => entry.id === id);
    if (!client || client.generation !== generation) throw new Error("This MCP client changed. Refresh its access settings.");
    await writeStoredJson(directory, path.resolve(directory, fileName), { version: 1, clients: clients.filter((entry) => entry.id !== id) });
  });
}
