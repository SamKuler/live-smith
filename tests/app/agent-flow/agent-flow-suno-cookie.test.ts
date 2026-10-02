import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import test from "node:test";
import { URL } from "node:url";
import type { LiveInteractionContext } from "../../../src/live/context.js";
import { chatDialogStateForWire, type ChatDialogState } from "../../../src/ui/chat-state.js";
import { runAgentFlow } from "../../../src/app/agent-flow.js";
import { SunoSessionManager } from "../../../src/app/audio/suno/suno-session-manager.js";
import { SunoSessionExpiredError } from "../../../src/audio-services/suno/suno-session.js";
import { liveContextPresentationFixture } from "../context/support/live-context.test-harness.js";
import { loadSessionEvents } from "../../../src/storage/events.js";
import { SunoSessions } from "../../../src/storage/suno-sessions.js";
import { subscribeGlobalStateInvalidations } from "../../../src/app/session/session-state-events.js";
import {
  integrationConnectionFixture,
  integrationConnectionUpsert,
  saveIntegrationConnection,
} from "../plugins/support/integration-connection-test-helpers.js";

const sessionValue = "eyJhbGciOiJSUzI1NiJ9.eyJjbGllbnQiOiJmaXh0dXJlIn0.c2lnbmF0dXJl";
const connection = { id: "suno-one", name: "My Suno", provider: "suno" as const, enabled: false, apiKey: "" };

test("Suno wire projection exports identity only, never Cookie data or identity in a failed state", () => {
  for (const status of ["signed_in", "saved", "expired", "unavailable"] as const) {
    const view = chatDialogStateForWire({
      sunoAccounts: [{ serviceId: connection.id, status, accountId: "user_fixture", accountName: "Fixture musician",
        clientToken: sessionValue, sessionValue, cookie: sessionValue }],
    } as unknown as ChatDialogState);
    assert.deepEqual(view.sunoAccounts, [{ serviceId: connection.id, status,
      ...(["signed_in", "saved"].includes(status) ? { accountId: "user_fixture", accountName: "Fixture musician" } : {}) }]);
    assert.doesNotMatch(JSON.stringify(view), /eyJhbGci|clientToken|sessionValue|cookie/);
  }
});

for (const retire of ["logout", "remove", "replace", "close"] as const) {
  test(`Suno Cookie connection handles ${retire} without owning a browser or exposing credentials`, async (t) => {
    const storage = await fs.mkdtemp("/private/tmp/live-smith-suno-cookie-flow-");
    t.after(() => fs.rm(storage, { recursive: true, force: true }));
    await saveIntegrationConnection(storage, "0", connection);
    let opens = 0;
    let verifications = 0;
    const interaction: LiveInteractionContext = { presentation: liveContextPresentationFixture("Audio"),
      summary: "Track: Audio", target: {}, scope: { kind: "track", identity: "track-1", label: "Audio" } };
    interaction.selectionContext = { refresh: () => interaction };
    await runAgentFlow({
      application: { song: { handle: { id: 1n } } }, environment: { storageDirectory: storage },
      ui: { showModalDialog: async (url: string) => {
        const endpoint = new URL(url);
        endpoint.pathname = "/command";
        let sequence = 0;
        const command = async (body: unknown) => {
          const response = await fetch(endpoint, { method: "POST", headers: {
            "Content-Type": "application/json", "X-Live-Smith-Command-Id": `suno-command-${++sequence}`,
          }, body: JSON.stringify(body) });
          const text = await response.text();
          assert.equal(response.status, 200, text);
          assert.doesNotMatch(text, /eyJhbGci|clientToken|sessionValue/);
          return JSON.parse(text) as ChatDialogState;
        };
        const opened = await command({ kind: "open_suno_website" });
        assert.deepEqual(opened.sunoAccounts, [{ serviceId: connection.id, status: "signed_out" }]);
        assert.equal(verifications, 0, "navigation does not read or verify browser credentials");
        const connected = await command({ kind: "import_suno_session", serviceId: connection.id, sessionValue });
        assert.deepEqual(connected.sunoAccounts, [{ serviceId: connection.id, status: "signed_in", accountId: "user_fixture", accountName: "Fixture musician" }]);
        assert.equal(connected.integrationConnections!.connections[0]!.enabled, false);
        assert.deepEqual(connected.integrationConnections!.connections[0]!.configuredSecrets, []);
        const refreshed = await command({ kind: "refresh_suno_login", serviceId: connection.id });
        assert.equal(refreshed.sunoAccounts![0]!.status, "signed_in");
        if (retire === "close") return;
        const retired = retire === "logout" ? await command({ kind: "logout_suno", serviceId: connection.id })
          : await command({ kind: "save_global_settings", integrationConnections: retire === "remove"
            ? { action: "remove", expectedRevision: "1", connectionId: connection.id }
            : integrationConnectionUpsert("1", { ...connection, provider: "elevenlabs" }) });
        assert.deepEqual(retired.sunoAccounts, retire === "logout" ? [{ serviceId: connection.id, status: "signed_out" }] : []);
      } },
    } as never, interaction, { renderHtml: () => "<html></html>", openSunoWebsite: async () => { opens++; },
      verifySunoSession: async (received) => {
        assert.equal(received, `__client=${sessionValue}`); verifications++;
        return { accountId: "user_fixture", accountName: "Fixture musician" };
      } });
    assert.equal(opens, 1);
    assert.equal(verifications, 2);
    const reopened = new SunoSessionManager(storage, async () => { throw new Error("Views must not make requests"); });
    const accounts = await reopened.views([integrationConnectionFixture(connection)]);
    assert.equal(accounts[0]!.status, retire === "close" ? "signed_in" : "signed_out",
      "dialog closure retains process-wide verification evidence without owning a browser");
  });
}

test("partial Cookie cleanup returns authoritative disconnected state and invalidates peer dialogs", async (t) => {
  const storage = await fs.mkdtemp("/private/tmp/live-smith-suno-cookie-partial-");
  t.after(() => fs.rm(storage, { recursive: true, force: true }));
  await saveIntegrationConnection(storage, "0", connection);
  await new SunoSessions(storage).save(connection.id, { clientToken: sessionValue, accountId: "user_fixture" });
  let invalidations = 0;
  t.after(subscribeGlobalStateInvalidations(storage, () => { invalidations++; }));
  const interaction: LiveInteractionContext = { presentation: liveContextPresentationFixture("Audio"),
    summary: "Track: Audio", target: {}, scope: { kind: "track", identity: "track-partial", label: "Audio" } };
  interaction.selectionContext = { refresh: () => interaction };
  await runAgentFlow({
    application: { song: { handle: { id: 1n } } }, environment: { storageDirectory: storage },
    ui: { showModalDialog: async (url: string) => {
      const endpoint = new URL(url); endpoint.pathname = "/command";
      const handle = await fs.open(storage);
      const prototype = Object.getPrototypeOf(handle) as fs.FileHandle;
      await handle.close();
      const fault = t.mock.method(prototype, "writeFile", async () => { throw new Error("Injected settings failure"); });
      try {
        const response = await fetch(endpoint, { method: "POST", headers: {
          "Content-Type": "application/json", "X-Live-Smith-Command-Id": "suno-partial-remove",
        }, body: JSON.stringify({ kind: "save_global_settings", integrationConnections: {
          action: "remove", expectedRevision: "1", connectionId: connection.id,
        } }) });
        const body = await response.text();
        assert.equal(response.status, 500);
        assert.doesNotMatch(body, /eyJhbGci|Injected settings failure/);
        const failure = JSON.parse(body);
        assert.equal(failure.commandOutcome, "unknown");
        assert.deepEqual(failure.state.sunoAccounts, [{ serviceId: connection.id, status: "signed_out" }]);
        assert.equal(failure.state.integrationConnections.connections[0].id, connection.id);
        assert.equal(invalidations, 1);
      } finally { fault.mock.restore(); }
    } },
  } as never, interaction, { renderHtml: () => "<html></html>" });
});

for (const status of ["signed_in", "expired", "unavailable"] as const) {
  test(`an older state snapshot preserves a peer's new Suno ${status} evidence`, { timeout: 5_000 }, async (t) => {
    const storage = await fs.mkdtemp("/private/tmp/live-smith-suno-state-evidence-");
    t.after(() => fs.rm(storage, { recursive: true, force: true }));
    const captured = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    t.after(() => release.resolve());
    let pause = false;
    let paused = false;
    const interaction: LiveInteractionContext = { presentation: liveContextPresentationFixture("Audio"),
      summary: "Track: Audio", target: {}, scope: { kind: "track", identity: "track-evidence", label: "Audio" } };
    interaction.selectionContext = { refresh: () => interaction };
    await runAgentFlow({
      application: { song: { handle: { id: 1n } } }, environment: { storageDirectory: storage },
      ui: { showModalDialog: async (url: string) => {
        const endpoint = new URL(url); endpoint.pathname = "/state";
        const state = async () => {
          const response = await fetch(endpoint);
          const result = await response.json() as ChatDialogState;
          assert.equal(response.status, 200);
          return result;
        };
        assert.deepEqual((await state()).sunoAccounts, []);
        pause = true;
        const olderState = state();
        await captured.promise;
        try {
          await saveIntegrationConnection(storage, "0", connection);
          let failure: Error | undefined;
          const peer = new SunoSessionManager(storage, async () => {
            if (failure) throw failure;
            return { accountId: "user_fixture" };
          });
          const signal = new AbortController().signal;
          await peer.importSession(connection.id, sessionValue, signal);
          if (status !== "signed_in") {
            failure = status === "expired" ? new SunoSessionExpiredError() : new Error("Synthetic network failure");
            await assert.rejects(peer.refresh(connection.id, signal));
          }
          assert.equal((await peer.views([integrationConnectionFixture(connection)]))[0]!.status, status);
          release.resolve();
          assert.deepEqual((await olderState).sunoAccounts, []);
          assert.deepEqual((await state()).sunoAccounts, [{ serviceId: connection.id, status,
            ...(status === "signed_in" ? { accountId: "user_fixture" } : {}) }]);
        } finally {
          release.resolve();
          await olderState;
        }
      } },
    } as never, interaction, { renderHtml: () => "<html></html>",
      loadSessionEvents: async (...args) => {
        if (pause && !paused) { paused = true; captured.resolve(); await release.promise; }
        return loadSessionEvents(...args);
      },
    });
  });
}
