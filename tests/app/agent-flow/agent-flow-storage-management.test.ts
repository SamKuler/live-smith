import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { URL } from "node:url";
import test from "node:test";
import { runAgentFlow } from "../../../src/app/agent-flow.js";
import { createChatBridge } from "../../../src/app/chat/chat-bridge.js";
import { parseCommandInput } from "../../../src/app/chat/chat-bridge-http.js";
import { freshEmptyAgentSettings } from "../../../src/model/profile.js";
import { appendSessionEvent, loadSessionEvents } from "../../../src/storage/events.js";
import { loadAgentSettings } from "../../../src/storage/settings.js";
import type { StorageUsage } from "../../../src/storage/management.js";
import type { ChatDialogState } from "../../../src/ui/chat-state.js";
import { liveContextPresentationFixture } from "../context/support/live-context.test-harness.js";

const interaction = { presentation: liveContextPresentationFixture("Lead"), summary: "Track: Lead", target: {},
  scope: { kind: "track" as const, identity: "track-1", label: "Lead" } };

test("production storage endpoints authenticate, reject stale cleanup, preserve conversation and return localized outcomes", async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-storage-http-")));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const oldSettings = path.join(directory, "live-smith-settings.json");
  await fs.writeFile(oldSettings, JSON.stringify(freshEmptyAgentSettings()));
  const context = { application: { song: { handle: { id: 1n } } }, environment: { storageDirectory: directory },
    ui: { showModalDialog: async (target: string) => {
      const url = new URL(target); const route = (name: string) => `${url.origin}${name}?token=${url.searchParams.get("token")}`;
      let sequence = 0;
      const command = (input: unknown) => fetch(route("/command"), { method: "POST", headers: {
        "Content-Type": "application/json", "X-Live-Smith-Command-Id": `storage-${++sequence}`,
      }, body: JSON.stringify(input) });
      const initial = await fetch(route("/state")).then(response => response.json()) as ChatDialogState;
      await appendSessionEvent(directory, initial.activeSessionId, { kind: "user", content: "Keep this conversation" });
      const read = async () => {
        const response = await fetch(route("/storage-usage")); assert.equal(response.status, 200);
        const result = await response.json() as StorageUsage;
        if (!result.available) throw new Error("Expected disk storage"); return result;
      };
      const usage = await read(); assert.equal(usage.backupFileCount, 1); assert.equal(usage.sessionCount, 1);
      assert.equal((await fetch(`${url.origin}/storage-usage?token=wrong`)).status, 403);
      assert.equal((await fetch(route("/storage-usage") + "&path=/private")).status, 400);
      assert.equal((await command({ kind: "clear_storage_backups", revision: usage.backupRevision, path: directory })).status, 400);
      await fs.appendFile(oldSettings, "\n");
      const conflict = await command({ kind: "clear_storage_backups", revision: usage.backupRevision });
      assert.equal(conflict.status, 409);
      const failure = await conflict.json() as { displayMessage: { source: string } };
      assert.equal(failure.displayMessage.source, "Stored backup files changed. Refresh storage usage and try again.");
      const refreshed = await read();
      const cleared = await command({ kind: "clear_storage_backups", revision: refreshed.backupRevision });
      assert.equal(cleared.status, 200);
      const state = await cleared.json() as ChatDialogState;
      assert.deepEqual(state.status, { source: "Old backups cleared.", values: {} });
      assert.equal(state.activeSessionId, initial.activeSessionId);
      assert.equal((await read()).backupFileCount, 0);
      assert.equal((await loadSessionEvents(directory, initial.activeSessionId))[0]?.content, "Keep this conversation");
      assert.equal((await loadAgentSettings(directory)).showContextUsage, true);
      const compacted = await command({ kind: "compact_storage" }); assert.equal(compacted.status, 200);
      assert.deepEqual((await compacted.json() as ChatDialogState).status, { source: "Database space reclaimed.", values: {} });
    } } };
  await runAgentFlow(context as never, interaction, { renderHtml: () => "<html></html>" });
});

test("memory-only runtime explains unavailable storage and rejects persistent maintenance", async () => {
  const context = { application: { song: { handle: { id: 2n } } }, environment: {},
    ui: { showModalDialog: async (target: string) => {
      const url = new URL(target); const route = (name: string) => `${url.origin}${name}?token=${url.searchParams.get("token")}`;
      assert.deepEqual(await fetch(route("/storage-usage")).then(response => response.json()), { available: false });
      const response = await fetch(route("/command"), { method: "POST", headers: { "Content-Type": "application/json", "X-Live-Smith-Command-Id": "memory-storage" }, body: JSON.stringify({ kind: "compact_storage" }) });
      assert.equal(response.status, 400);
      assert.deepEqual((await response.json() as { displayMessage: unknown }).displayMessage, { source: "Storage management requires persistent storage.", values: {} });
    } } };
  await runAgentFlow(context as never, interaction, { renderHtml: () => "<html></html>" });
});

test("storage maintenance commands accept only their own parameters", () => {
  for (const kind of ["compact_storage", "open_storage_directory"]) {
    assert.deepEqual(parseCommandInput({ kind }), { kind });
    assert.throws(() => parseCommandInput({ kind, sessionId: "session" }));
  }
  for (const revision of [undefined, "../outside", "a".repeat(63), "A".repeat(64)]) assert.throws(() => parseCommandInput({ kind: "clear_storage_backups", revision }));
});

test("closing a storage usage HTTP request cancels its filesystem scan", { timeout: 5000 }, async t => {
  const started = Promise.withResolvers<void>(), stopped = Promise.withResolvers<void>();
  const state = {} as ChatDialogState;
  const bridge = await createChatBridge({ buildState: async () => state, renderHtml: () => "", handleCommand: async () => state, handleSend: async () => {},
    readStorageUsage: async signal => { started.resolve(); await new Promise<void>(resolve => signal.addEventListener("abort", () => { stopped.resolve(); resolve(); }, { once: true })); return { available: false }; } });
  t.after(() => bridge.close());
  const url = new URL(bridge.url); url.pathname = "/storage-usage";
  const controller = new AbortController(); const request = fetch(url, { signal: controller.signal }).catch(() => undefined);
  await started.promise; controller.abort(); await stopped.promise; await request;
});
