import { openBridgeEvents, readEventsThrough } from "../chat/support/bridge-events.js";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import test from "node:test";
import { runAgentFlow } from "../../../src/app/agent-flow.js";
import { subscribeGlobalSettingsChanges, type GlobalSettingsChange } from "../../../src/app/chat/global-settings-events.js";
import type { LiveInteractionContext } from "../../../src/live/context.js";
import { defaultSessionTabs } from "../../../src/model/session-tabs.js";
import { StorageCommitOutcomeUnknownError } from "../../../src/storage/persistence.js";
import { loadAgentSettings, saveGlobalSettings } from "../../../src/storage/settings.js";
import type { ChatDialogState } from "../../../src/ui/chat-state.js";
import { liveContextPresentationFixture } from "../context/support/live-context.test-harness.js";
import { invalidateGlobalState, invalidateSessionState, subscribeGlobalStateInvalidations, subscribeSessionStateInvalidations } from "../../../src/app/session/session-state-events.js";

function endpoint(url: string, route: string): URL {
  const target = new URL(url);
  target.pathname = route;
  return target;
}

test("command owners distinguish catalog changes and tools-only events leave dialog refresh to its owner", { timeout: 10000 }, async t => {
  const storageDirectory = await realpath(await mkdtemp(join(tmpdir(), "live-smith-catalog-targets-")));
  t.after(() => rm(storageDirectory, { recursive: true, force: true }));
  const globalTargets: string[] = [];
  const sessionTargets: Array<{ sessionId: string; target: string }> = [];
  t.after(subscribeGlobalStateInvalidations(storageDirectory, change => { globalTargets.push(change.target ?? "state"); }));
  t.after(subscribeSessionStateInvalidations(storageDirectory, change => { sessionTargets.push({ sessionId: change.sessionId, target: change.target ?? "state" }); }));
  const interaction: LiveInteractionContext = { presentation: liveContextPresentationFixture("Lead"), summary: "Lead", target: {},
    scope: { kind: "track", identity: "track-1", label: "Lead" } };
  interaction.selectionContext = { refresh: () => interaction };
  await runAgentFlow({ application: { song: { handle: { id: 1n } } }, environment: { storageDirectory },
    ui: { showModalDialog: async (url: string) => {
      let sequence = 0;
      const command = async (body: unknown) => {
        const response = await fetch(endpoint(url, "/command"), { method: "POST", headers: {
          "Content-Type": "application/json", "X-Live-Smith-Command-Id": `catalog-owner-${++sequence}` }, body: JSON.stringify(body) });
        const text = await response.text(); assert.equal(response.status, 200, text);
      };
      const state = await fetch(endpoint(url, "/state")).then(response => response.json()) as ChatDialogState;
      const sessionId = state.activeSessionId!;
      const stream = await openBridgeEvents(endpoint(url, "/events"));
      try {
        const source = Symbol("peer");
        invalidateSessionState(storageDirectory, { sessionId, source, target: "tools" });
        invalidateGlobalState(storageDirectory, { source, target: "tools" });
        invalidateSessionState(storageDirectory, { sessionId, source });
        const events = await readEventsThrough(stream, "session_state_invalidated");
        assert.deepEqual(events.map(event => event.type).filter(type => type.endsWith("_state_invalidated")), ["session_state_invalidated"]);
      } finally { await stream.close(); }
      globalTargets.length = 0; sessionTargets.length = 0;
      await command({ kind: "rename_session", sessionId, title: "Renamed" });
      await command({ kind: "set_session_edit_scopes", sessionId, editScopes: [] });
      await command({ kind: "set_session_approval_mode", sessionId, approvalMode: "everything" });
      await command({ kind: "save_global_settings", uiLanguage: "zh-CN" });
      assert(sessionTargets.every(change => change.target === "state"));
      assert(!globalTargets.includes("all"));
      globalTargets.length = 0;
      await command({ kind: "save_global_settings", integrationConnections: { action: "upsert", expectedRevision: "0", connection: {
        id: "catalog", name: "Catalog", enabled: true, mcp: { type: "streamable-http", url: "http://127.0.0.1:39999/mcp" },
        secrets: {}, artifactInputApproved: false, artifactOutputApproved: false,
      } } });
      assert.deepEqual(globalTargets.splice(0), ["all"]);
      await command({ kind: "save_global_settings", networkProxy: { mode: "none", url: "" } });
      assert.deepEqual(globalTargets.splice(0), ["all"]);
      for (const kind of ["archive_session", "unarchive_session", "delete_session"]) {
        sessionTargets.length = 0;
        await command({ kind, sessionId });
        assert(sessionTargets.some(change => change.sessionId === sessionId && change.target === "all"), kind);
      }
    } },
  } as never, interaction, { renderHtml: () => "<html></html>" });
});

for (const outcome of ["saved", "unknown", "failed"] as const) {
  test(`Session tab ${outcome} saves reconcile storage and peer dialogs`, async (t) => {
    const storageDirectory = await realpath(await mkdtemp(join(tmpdir(), "live-smith-tab-settings-flow-")));
    t.after(() => rm(storageDirectory, { recursive: true, force: true }));
    const changes: GlobalSettingsChange[] = [];
    t.after(subscribeGlobalSettingsChanges(storageDirectory, (change) => changes.push(change)));
    const interaction: LiveInteractionContext = {
      presentation: liveContextPresentationFixture("Lead"), summary: "Track: Lead", target: {},
      scope: { kind: "track", identity: "track-1", label: "Lead" },
    };
    interaction.selectionContext = { refresh: () => interaction };
    const open = (showModalDialog: (url: string) => Promise<void>) => runAgentFlow({
      application: { song: { handle: { id: 1n } } }, environment: { storageDirectory },
      ui: { showModalDialog },
    } as never, interaction, {
      renderHtml: () => "<html></html>",
      saveGlobalSettings: async (...args) => {
        if (outcome === "failed") throw new Error("Injected save failure");
        const saved = await saveGlobalSettings(...args);
        if (outcome === "unknown") throw new StorageCommitOutcomeUnknownError(new Error("Injected durability uncertainty"));
        return saved;
      },
    });
    await open(async (ownerUrl) => {
      await open(async (peerUrl) => {
        const initial = await fetch(endpoint(peerUrl, "/state")).then((response) => response.json()) as ChatDialogState;
        assert.deepEqual(initial.settings.sessionTabs, defaultSessionTabs);
        const response = await fetch(endpoint(ownerUrl, "/command"), {
          method: "POST", headers: { "Content-Type": "application/json", "X-Live-Smith-Command-Id": `tabs-${outcome}` },
          body: JSON.stringify({ kind: "save_global_settings", sessionTabs: [] }),
        });
        const body = await response.json() as ChatDialogState & { commandOutcome?: string; state?: ChatDialogState };
        assert.equal(response.status, outcome === "saved" ? 200 : 500);
        if (outcome === "unknown") assert.equal(body.commandOutcome, "unknown");
        if (outcome === "saved") {
          assert.deepEqual(body.settings.sessionTabs, []);
          assert.equal(body.settings.sessionTabsRevision, "1");
        }
        const peer = await fetch(endpoint(peerUrl, "/state")).then((response) => response.json()) as ChatDialogState;
        const expectedTabs = outcome === "failed" ? defaultSessionTabs : [];
        const expectedRevision = outcome === "failed" ? "0" : "1";
        assert.deepEqual(peer.settings.sessionTabs, expectedTabs);
        assert.equal(peer.settings.sessionTabsRevision, expectedRevision);
        assert.equal(peer.settings.uiLanguageRevision, "0");
        const stored = await loadAgentSettings(storageDirectory);
        assert.deepEqual(stored.sessionTabs, expectedTabs);
        assert.equal(stored.sessionTabsRevision, expectedRevision);
        assert.equal(changes.length, outcome === "failed" ? 0 : 1);
        if (outcome !== "failed") {
          assert.deepEqual(changes[0]!.sessionTabs, []);
          assert.equal(changes[0]!.sessionTabsRevision, "1");
          assert.equal(changes[0]!.commandId, `tabs-${outcome}`);
        }
      });
    });
  });
}
