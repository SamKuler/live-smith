import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { cwd, execPath } from "node:process";
import { promisify } from "node:util";
import test from "node:test";
import { freshEmptyAgentSettings } from "../../src/model/profile.js";
import { loadAgentSettings, saveGlobalSettings } from "../../src/storage/settings.js";
import { appendSessionEvent, deleteSessionEvents, listSessionEventLogIds, loadSessionEvents } from "../../src/storage/events.js";
import { SunoSessions } from "../../src/storage/suno-sessions.js";

async function directory(t: test.TestContext): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-structured-migration-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("settings import once and subsequent saves preserve the original source", async (t) => {
  const root = await directory(t);
  const file = path.join(root, "live-smith-settings.json");
  const original = JSON.stringify(freshEmptyAgentSettings());
  await fs.writeFile(file, original);
  assert.equal((await loadAgentSettings(root)).showContextUsage, true);
  await saveGlobalSettings(root, { showContextUsage: false });
  assert.equal(await fs.readFile(file, "utf8"), original);
  await fs.writeFile(file, "{invalid old source");
  assert.equal((await loadAgentSettings(root)).showContextUsage, false);
});

test("relative storage directories resolve to the same active settings and events", async (t) => {
  const root = await directory(t);
  const relative = path.relative(cwd(), root);
  await saveGlobalSettings(relative, { showContextUsage: false });
  assert.equal((await loadAgentSettings(root)).showContextUsage, false);
  await appendSessionEvent(relative, "session-relative", { kind: "user", content: "Saved" });
  assert.equal((await loadSessionEvents(root, "session-relative"))[0]?.content, "Saved");
  assert.deepEqual(await listSessionEventLogIds(relative), ["session-relative"]);
});

test("committed records survive a fresh process without rereading changed legacy sources", async (t) => {
  const root = await directory(t);
  const settingsFile = path.join(root, "live-smith-settings.json");
  await fs.writeFile(settingsFile, JSON.stringify(freshEmptyAgentSettings()));
  await saveGlobalSettings(root, { showContextUsage: false });
  await appendSessionEvent(root, "session-reopened", { kind: "user", content: "Committed" });
  await fs.writeFile(settingsFile, "{invalid old source");
  const settingsModule = new URL("../../src/storage/settings.ts", import.meta.url).href;
  const eventsModule = new URL("../../src/storage/events.ts", import.meta.url).href;
  const script = `import { loadAgentSettings } from ${JSON.stringify(settingsModule)};
    import { loadSessionEvents } from ${JSON.stringify(eventsModule)};
    import { argv, stdout } from "node:process";
    stdout.write(JSON.stringify({ showContextUsage: (await loadAgentSettings(argv[1])).showContextUsage,
      content: (await loadSessionEvents(argv[1], "session-reopened"))[0].content }));`;
  const result = await promisify(execFile)(execPath, ["--import", "tsx", "--input-type=module", "-e", script, root]);
  assert.deepEqual(JSON.parse(result.stdout), { showContextUsage: false, content: "Committed" });
  assert.equal(await fs.readFile(settingsFile, "utf8"), "{invalid old source");
});

test("event append, enumeration and deletion use imported records without touching source logs", async (t) => {
  const root = await directory(t);
  const eventRoot = path.join(root, "live-smith-events");
  await fs.mkdir(eventRoot);
  const file = path.join(eventRoot, "session-one.json");
  const original = JSON.stringify([{ id: "event-original", createdAt: new Date().toISOString(), kind: "user", content: "Original" }]);
  await fs.writeFile(file, original);
  assert.equal((await loadSessionEvents(root, "session-one")).length, 1);
  await appendSessionEvent(root, "session-one", { kind: "assistant", content: "Saved" });
  assert.equal(await fs.readFile(file, "utf8"), original);
  await fs.writeFile(path.join(eventRoot, "session-late.json"), "[]");
  assert.deepEqual(await listSessionEventLogIds(root), ["session-one"]);
  await deleteSessionEvents(root, "session-one");
  assert.deepEqual(await loadSessionEvents(root, "session-one"), []);
  assert.deepEqual(await listSessionEventLogIds(root), []);
  assert.equal(await fs.readFile(file, "utf8"), original);
});

test("Suno imported credentials are cleared only from active storage", async (t) => {
  const root = await directory(t);
  const file = path.join(root, "suno-session-one.json");
  const value = { clientToken: "__client=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzeW50aGV0aWMifQ.c3ludGhldGlj", accountId: "user_fixture" };
  const original = JSON.stringify({ schemaVersion: 1, serviceId: "one", ...value });
  await fs.writeFile(file, original);
  const store = new SunoSessions(root);
  assert.deepEqual(await store.load("one"), value);
  assert.equal(await store.clear("one"), true);
  assert.equal(await store.load("one"), undefined);
  assert.equal(await fs.readFile(file, "utf8"), original);
});

test("Session metadata imports with stable IDs and keeps later edits and deletion in SQLite", async (t) => {
  const root = await directory(t);
  const file = path.join(root, "live-smith-sessions.json");
  const original = JSON.stringify([{ id: "session-original", title: "Original", projectKey: "set-a",
    scope: { kind: "track", identity: "track-a", label: "Lead" }, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z" }]);
  await fs.writeFile(file, original);
  const { listSessions, updateSession, deleteSession } = await import("../../src/storage/sessions.js");
  assert.equal((await listSessions(root))[0]?.id, "session-original");
  await updateSession(root, "session-original", { title: "Updated" });
  assert.equal((await listSessions(root))[0]?.title, "Updated");
  assert.equal(await fs.readFile(file, "utf8"), original);
  await deleteSession(root, "session-original");
  assert.deepEqual(await listSessions(root), []);
  assert.equal(await fs.readFile(file, "utf8"), original);
});

test("legacy model catalogs import once and current slots remain authoritative", async (t) => {
  const root = await directory(t);
  const { connectionFingerprint, loadModelCache, saveModelCache } = await import("../../src/storage/model-cache.js");
  const profile = { id: "profile-one", name: "Fixture", connection: {
    kind: "direct-api" as const, apiFamily: "openai" as const, apiMode: "responses" as const,
    baseUrl: "https://example.test/v1", apiKey: "fixture-key",
  }, defaultModel: "model-one", models: [{ model: "model-one", parameters: { reasoning: { mode: "default" as const } }, advanced: {} }] };
  const file = path.join(root, `live-smith-models-v2-${connectionFingerprint(profile)}.json`);
  const original = JSON.stringify({ schemaVersion: 1, fingerprint: connectionFingerprint(profile),
    models: [{ id: "model-one", displayName: "One", capabilities: {} }] });
  await fs.writeFile(file, original);
  assert.equal((await loadModelCache(root, profile))[0]?.id, "model-one");
  await saveModelCache(root, profile, [{ id: "model-two", displayName: "Two", capabilities: {} }]);
  assert.equal(await fs.readFile(file, "utf8"), original);
  await fs.writeFile(file, "{invalid old cache");
  assert.equal((await loadModelCache(root, profile))[0]?.id, "model-two");
});

for (const schemaVersion of [1, 2]) {
  test(`OAuth v${schemaVersion} import migrates, claims and deletes only the database credential`, async (t) => {
    const root = await directory(t);
    const { loadOAuthCredential, prepareOAuthCredentialStoreInTransaction, deleteOAuthCredential } =
      await import("../../src/storage/oauth-credentials.js");
    const { withStorageTransaction } = await import("../../src/storage/persistence.js");
    const { readStoredText, storedEntry } = await import("../../src/storage/sqlite.js");
    const profile = { id: "profile-one", name: "Subscription", connection: {
      kind: "oauth-subscription" as const, provider: "openai" as const,
    }, defaultModel: "model-one", models: [{ model: "model-one", parameters: { reasoning: { mode: "default" as const } }, advanced: {} }] };
    const credential = { provider: "openai", accessToken: "fixture-access", refreshToken: "fixture-refresh",
      accountId: "account-one", expiresAt: 2_000_000_000_000 };
    const file = path.join(root, "oauth", "credentials.json");
    await fs.mkdir(path.dirname(file));
    const original = JSON.stringify(schemaVersion === 1
      ? { schemaVersion, credentials: { openai: credential } }
      : { schemaVersion, credentials: { [profile.id]: { openai: credential } }, legacyCredentials: {} });
    await fs.writeFile(file, original);
    await withStorageTransaction(root, (transaction) => prepareOAuthCredentialStoreInTransaction(transaction, root, [profile], profile.id));
    assert.deepEqual(await loadOAuthCredential(root, profile.id, "openai"), credential);
    assert.equal(JSON.parse(await readStoredText(root, file)).schemaVersion, 3);
    assert.equal(await fs.readFile(file, "utf8"), original);
    await deleteOAuthCredential(root, profile.id, "openai");
    assert.equal(await storedEntry(root, file), undefined);
    assert.equal(await loadOAuthCredential(root, profile.id, "openai"), undefined);
    assert.equal(await fs.readFile(file, "utf8"), original);
  });
}

test("MCP connection OAuth imports before generation-checked updates and preserves its source", async (t) => {
  const root = await directory(t);
  const { randomUUID } = await import("node:crypto");
  const { withStorageTransaction } = await import("../../src/storage/persistence.js");
  const { readMcpOAuthCredentialInTransaction, saveMcpOAuthCredentialInTransaction, deleteMcpOAuthCredentialsInTransaction } =
    await import("../../src/storage/mcp-oauth.js");
  const file = path.join(root, "live-smith-mcp-oauth.json");
  const credential = { connectionId: "connection-one", owner: "a".repeat(64), generation: randomUUID(),
    redirectUri: "http://127.0.0.1:17853/mcp/oauth/callback" };
  const original = JSON.stringify({ version: 1, credentials: [credential] });
  await fs.writeFile(file, original);
  await withStorageTransaction(root, async (transaction) => {
    assert.deepEqual(await readMcpOAuthCredentialInTransaction(transaction, root, credential.connectionId), credential);
    const updated = { ...credential, generation: randomUUID() };
    await saveMcpOAuthCredentialInTransaction(transaction, root, updated, credential.generation);
    await assert.rejects(saveMcpOAuthCredentialInTransaction(transaction, root, credential, credential.generation), /changed/);
    assert.deepEqual(await readMcpOAuthCredentialInTransaction(transaction, root, credential.connectionId), updated);
    assert.equal(await deleteMcpOAuthCredentialsInTransaction(transaction, root, { connectionId: credential.connectionId }), true);
  });
  assert.equal(await fs.readFile(file, "utf8"), original);
  await withStorageTransaction(root, async (transaction) => {
    assert.equal(await readMcpOAuthCredentialInTransaction(transaction, root, credential.connectionId), undefined);
  });
});

test("MCP server access imports hashed credentials and rotates and revokes without changing its source", async (t) => {
  const root = await directory(t);
  const { createHash } = await import("node:crypto");
  const { authenticateMcpServerClient, rotateMcpServerClient, revokeMcpServerClient } =
    await import("../../src/storage/mcp-server-auth.js");
  const token = `client-one.${"a".repeat(43)}`;
  const client = { id: "client-one", name: "Fixture", projectKey: "set-one", sessionId: "session-one",
    generation: "generation-one", createdAt: "2026-11-01T00:00:00Z" };
  const file = path.join(root, "live-smith-mcp-server-clients.json");
  const original = JSON.stringify({ version: 1, clients: [{ ...client, digest: createHash("sha256").update(token).digest("hex") }] });
  await fs.writeFile(file, original);
  assert.deepEqual(await authenticateMcpServerClient(root, token), client);
  const rotated = await rotateMcpServerClient(root, client.id, client.generation);
  assert.equal(await authenticateMcpServerClient(root, token), undefined);
  assert.deepEqual(await authenticateMcpServerClient(root, rotated.token), rotated.client);
  await revokeMcpServerClient(root, rotated.client.id, rotated.client.generation);
  assert.equal(await authenticateMcpServerClient(root, rotated.token), undefined);
  assert.equal(await fs.readFile(file, "utf8"), original);
});
