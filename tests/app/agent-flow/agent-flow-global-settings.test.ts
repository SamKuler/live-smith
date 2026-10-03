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

function endpoint(url: string, route: string): URL {
  const target = new URL(url);
  target.pathname = route;
  return target;
}

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
