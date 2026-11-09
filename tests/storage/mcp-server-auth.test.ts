import { readStoredText, writeStoredBytes, STORAGE_DATABASE_NAME } from "../../src/storage/sqlite.js";
import { Buffer } from "node:buffer";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platform } from "node:process";
import test from "node:test";

test("MCP client credentials bind a Session, persist only a digest, rotate and revoke", async () => {
  const auth = await import("../../src/storage/mcp-server-auth.js").catch(() => undefined);
  assert.equal(typeof auth?.createMcpServerClient, "function");
  const directory = await mkdtemp(join(tmpdir(), "mcp-server-auth-"));
  try {
    const created = await auth!.createMcpServerClient(directory, { name: "Studio agent", projectKey: "set-a", sessionId: "session-a" });
    assert.equal(created.client.name, "Studio agent");
    assert.equal((await auth!.authenticateMcpServerClient(directory, created.token))?.sessionId, "session-a");
    const stored = await readStoredText(directory, join(directory, "live-smith-mcp-server-clients.json"));
    assert.equal(stored.includes(created.token), false);
    const listed = await auth!.listMcpServerClients(directory);
    assert.deepEqual(listed, [created.client]);
    assert.equal(JSON.stringify(listed).includes("digest"), false);
    if (platform !== "win32") assert.equal((await stat(join(directory, STORAGE_DATABASE_NAME))).mode & 0o777, 0o600);
    assert.equal(await auth!.authenticateMcpServerClient(directory, "invalid"), undefined);
    const rotated = await auth!.rotateMcpServerClient(directory, created.client.id, created.client.generation);
    assert.equal(await auth!.authenticateMcpServerClient(directory, created.token), undefined);
    assert.equal((await auth!.authenticateMcpServerClient(directory, rotated.token))?.id, created.client.id);
    await assert.rejects(auth!.rotateMcpServerClient(directory, created.client.id, created.client.generation), /changed/);
    await auth!.revokeMcpServerClient(directory, rotated.client.id, rotated.client.generation);
    assert.equal(await auth!.authenticateMcpServerClient(directory, rotated.token), undefined);
    assert.deepEqual(await auth!.listMcpServerClients(directory), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("MCP credentials reject malformed owners and preserve corrupt storage", async () => {
  const auth = await import("../../src/storage/mcp-server-auth.js").catch(() => undefined);
  assert.equal(typeof auth?.createMcpServerClient, "function");
  const directory = await mkdtemp(join(tmpdir(), "mcp-server-auth-invalid-"));
  try {
    await assert.rejects(auth!.createMcpServerClient(directory, { name: "", projectKey: "set", sessionId: "../other" }));
    const file = join(directory, "live-smith-mcp-server-clients.json");
    await writeStoredBytes(directory, file, Buffer.from("broken"));
    await assert.rejects(auth!.createMcpServerClient(directory, { name: "Agent", projectKey: "set", sessionId: "session-a" }), /storage/);
    assert.equal(await readStoredText(directory, file), "broken");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
