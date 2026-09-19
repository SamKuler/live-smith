import assert from "node:assert/strict";
import test from "node:test";
import { readSunoMusicService } from "../audio-services/suno-catalog.js";
import { saveGlobalSettings, loadAgentSettings } from "../storage/settings.js";
import { SunoSessions } from "../storage/suno-sessions.js";
import { chatDialogStateForWire, type ChatDialogState } from "../ui/chat-state.js";
import { parseCommandInput } from "./chat-bridge-http.js";
import { providerFetchForStorage } from "./provider-fetch.js";
import { invalidateGlobalState } from "./session-state-events.js";
import { createHostAbortController } from "../runtime/host.js";
import { SunoModelCatalog } from "./suno-model-catalog.js";
import { catalog, clientCookie, connection, files, flow, models, post, session, state, storageFixture, token } from "./suno-model-catalog-test-helpers.js";
import {
  integrationConnectionUpsert,
  saveIntegrationConnection,
} from "./integration-connection-test-helpers.js";

const load = { kind: "load_suno_models", serviceId: connection.id };

for (const peer of [false, true]) {
  for (const change of ["modelId", "name", "enabled", "unrelated connection"] as const) {
    test(`saving ${change} in ${peer ? "a peer" : "this"} dialog retains the account catalog at the new revision`, async (t) => {
      const storage = await storageFixture(t);
      let reads = 0;
      await flow(storage, async (url) => {
        const loaded = await post(url, load); assert.equal(loaded.status, 200); await loaded.text();
        const save = async (ownerUrl: string) => {
          const next = change === "unrelated connection" ? { ...connection, id: "suno-two", name: "Other Suno" }
            : { ...connection, ...({ modelId: { modelId: models[0]!.id }, name: { name: "Renamed Suno" },
              enabled: { enabled: true } }[change]) };
          const response = await post(ownerUrl, { kind: "save_global_settings", integrationConnections: {
            ...integrationConnectionUpsert("1", next),
          } }, "save-model-settings");
          assert.equal(response.status, 200);
          const saved = await response.json();
          if (!peer) assert.deepEqual(saved.sunoModelCatalog, { serviceId: connection.id, accountId: session.accountId,
            integrationConnectionsRevision: "2", models });
        };
        if (peer) await flow(storage, save);
        else await save(url);
        assert.deepEqual((await state(url)).sunoModelCatalog, { serviceId: connection.id, accountId: session.accountId,
          integrationConnectionsRevision: "2", models });
        assert.equal(reads, 1, "ordinary settings saves do not reload the account catalog");
      }, async () => { reads++; return catalog(); });
    });
  }
}

test("ordinary metadata changes during a catalog read publish the current revision without another provider read", async (t) => {
  const storage = await storageFixture(t);
  await flow(storage, async (url) => {
    const response = await post(url, load); assert.equal(response.status, 200);
    const saved = await response.json();
    assert.deepEqual(saved.sunoModelCatalog, { serviceId: connection.id, accountId: session.accountId,
      integrationConnectionsRevision: "2", models });
    assert.equal(saved.integrationConnections.revision, "2");
    assert.equal(saved.integrationConnections.connections[0].configuration.modelId, models[0]!.id);
  }, async () => {
    await saveIntegrationConnection(storage, "1", {
      ...connection, name: "Renamed Suno", enabled: true, modelId: models[0]!.id,
    });
    invalidateGlobalState(storage, { source: Symbol("peer settings save") });
    return catalog();
  });
});

test("a stale settings snapshot omits the catalog without evicting its still-valid account ownership", async (t) => {
  const storage = await storageFixture(t);
  const cache = new SunoModelCatalog(storage, providerFetchForStorage(storage), async () => catalog());
  await cache.load(connection.id, createHostAbortController().signal);
  await saveIntegrationConnection(storage, "1", { ...connection, modelId: models[0]!.id });
  assert.equal(await cache.view("1"), undefined);
  assert.deepEqual(await cache.view("2"), { serviceId: connection.id, accountId: session.accountId,
    integrationConnectionsRevision: "2", models });
});

for (const peer of [false, true]) {
  test(`authentication for an unrelated connection in ${peer ? "a peer" : "this"} dialog preserves the selected account catalog`, async (t) => {
    const storage = await storageFixture(t);
    await saveIntegrationConnection(storage, "1", {
      ...connection, id: "suno-two", name: "Other Suno",
    });
    await flow(storage, async (url) => {
      const loaded = await post(url, load); assert.equal(loaded.status, 200); await loaded.text();
      const disconnect = async (ownerUrl: string) => {
        const response = await post(ownerUrl, { kind: "logout_suno", serviceId: "suno-two" }, "disconnect-other");
        assert.equal(response.status, 200); await response.text();
      };
      if (peer) await flow(storage, disconnect);
      else await disconnect(url);
      assert.deepEqual((await state(url)).sunoModelCatalog, { serviceId: connection.id, accountId: session.accountId,
        integrationConnectionsRevision: "2", models });
    });
  });
}

for (const kind of ["refresh_suno_login", "logout_suno", "import_suno_session"] as const) {
  test(`peer ${kind} invalidates the original catalog, including a rejected import with unchanged credentials`, async (t) => {
    const storage = await storageFixture(t);
    await flow(storage, async (url) => {
      const loaded = await post(url, load); assert.equal(loaded.status, 200); await loaded.text();
      await flow(storage, async (peerUrl) => {
        const response = await post(peerUrl, { kind, serviceId: connection.id,
          ...(kind === "import_suno_session" ? { sessionValue: "invalid-synthetic-cookie" } : {}),
        }, "peer-auth");
        assert.equal(response.status, kind === "import_suno_session" ? 500 : 200); await response.text();
      });
      assert.equal((await state(url)).sunoModelCatalog, undefined);
      if (kind !== "logout_suno") assert.deepEqual(await new SunoSessions(storage).load(connection.id), session);
    });
  });
}

test("Suno catalog command accepts only a saved service identifier", () => {
  assert.deepEqual(parseCommandInput(load), load);
  for (const patch of [{ serviceId: "" }, { serviceId: "../other" }, { serviceId: undefined }, { serviceId: 3 },
    { serviceId: "x".repeat(129) }, { serviceId: "https://suno.com" }, { url: "https://suno.com" },
    { apiKey: "synthetic-secret" }, { clientToken: session.clientToken }, { sessionValue: session.clientToken },
    { settings: {} }, { connection }, { integrationConnections: {} }, { accountId: session.accountId }, { enabled: true },
    { modelId: models[0]!.id }, { query: "catalog" }, { sessionId: "session-one" }]) {
    assert.throws(() => parseCommandInput({ ...load, ...patch }));
  }
});

test("Suno catalog wire projection is bounded and whitelists every nested field", () => {
  const projected = chatDialogStateForWire({ sunoModelCatalog: {
    serviceId: connection.id, accountId: session.accountId, integrationConnectionsRevision: "4",
    clientToken: session.clientToken, accountName: "Private name", plan: "Private plan", url: "https://private.test",
    models: Array.from({ length: 101 }, () => ({ ...models[0], clientToken: session.clientToken,
      raw: { account: session }, maxLengths: { title: 80 }, url: "https://private.test" })),
  } } as unknown as ChatDialogState);
  assert.deepEqual(projected.sunoModelCatalog, { serviceId: connection.id, accountId: session.accountId,
    integrationConnectionsRevision: "4", models: Array.from({ length: 100 }, () => models[0]) });
  assert.doesNotMatch(JSON.stringify(projected), /eyJ|clientToken|Private|private\.test|maxLengths|raw/);
});

for (const enabled of [true, false]) {
  test(`catalog loads the exact saved private owner with enabled=${enabled}, without writes or shared cache`, async (t) => {
    const storage = await storageFixture(t, enabled);
    const other = { ...connection, id: "suno-two", name: "Other Suno" };
    await saveIntegrationConnection(storage, "1", other);
    await new SunoSessions(storage).save(other.id, { clientToken: clientCookie({ client: "other" }), accountId: "user_other" });
    let calls = 0;
    await flow(storage, async (url) => {
      assert.equal((await state(url)).sunoModelCatalog, undefined);
      const before = await files(storage);
      const response = await post(url, load);
      const body = await response.text(); assert.equal(response.status, 200, body);
      assert.doesNotMatch(body, /eyJ|clientToken|maxLengths|creditsLeft|Private plan|fingerprint/);
      assert.deepEqual(JSON.parse(body).sunoModelCatalog, { serviceId: connection.id, accountId: session.accountId,
        integrationConnectionsRevision: "2", models });
      assert.equal(JSON.parse(body).integrationConnections.connections[0].enabled, enabled);
      assert.deepEqual((await state(url)).sunoModelCatalog, JSON.parse(body).sunoModelCatalog);
      assert.equal(calls, 1, "readback never queries the provider");
      assert.deepEqual(await files(storage), before, "catalog loads never persist settings, credentials, jobs or catalogs");
      const second = await post(url, { ...load, serviceId: other.id }, "catalog-second");
      assert.equal(second.status, 200);
      assert.equal((await second.json()).sunoModelCatalog.accountId, "user_other");
      assert.equal((await state(url)).sunoModelCatalog!.serviceId, other.id);
    }, async (owner, request, signal, fetchImpl) => {
      assert.deepEqual(owner, calls++ === 0 ? session : { clientToken: clientCookie({ client: "other" }), accountId: "user_other" });
      assert.deepEqual(request, { query: "catalog" });
      assert.equal(signal.aborted, false); assert.equal(fetchImpl, providerFetchForStorage(storage));
      return catalog();
    });
    await flow(storage, async (url) => assert.equal((await state(url)).sunoModelCatalog, undefined),
      async () => { throw new Error("Opening a new dialog must not load a catalog"); });
  });
}

for (const owner of ["missing service", "missing credential", "wrong provider"] as const) {
  test(`catalog rejects ${owner} before any provider read`, async (t) => {
    const storage = await storageFixture(t);
    if (owner === "missing credential") await new SunoSessions(storage).clear(connection.id);
    if (owner === "wrong provider") {
      await saveIntegrationConnection(storage, "1", { ...connection, provider: "elevenlabs" });
    }
    await flow(storage, async (url) => {
      const response = await post(url, { ...load, ...(owner === "missing service" ? { serviceId: "absent" } : {}) });
      assert.equal(response.status, 409); assert.doesNotMatch(await response.text(), /eyJ|clientToken/);
      assert.equal((await state(url)).sunoModelCatalog, undefined);
    }, async () => { throw new Error("Unexpected provider read"); });
  });
}

for (const when of ["during load", "after load"] as const) {
  for (const change of ["account", "remove", "provider", "disconnect", "reimport notification"] as const) {
    test(`catalog omits stale ownership after ${change} ${when}`, async (t) => {
      const storage = await storageFixture(t);
      const changeOwner = async () => {
        if (change === "account") await new SunoSessions(storage).save(connection.id, { ...session, accountId: "user_other" });
        else if (change === "disconnect") await new SunoSessions(storage).clear(connection.id);
        else if (change === "reimport notification") invalidateGlobalState(storage, {
          source: Symbol("peer import"), sunoAuthServiceId: connection.id,
        });
        else await saveGlobalSettings(storage, { integrationConnections: change === "remove"
          ? { action: "remove", expectedRevision: "1", connectionId: connection.id }
          : integrationConnectionUpsert("1", { ...connection, provider: "elevenlabs" }) });
      };
      await flow(storage, async (url) => {
        const response = await post(url, load);
        assert.equal(response.status, when === "during load" ? 409 : 200, await response.text());
        if (when === "after load") await changeOwner();
        assert.equal((await state(url)).sunoModelCatalog, undefined);
      }, async () => {
        if (when === "during load") await changeOwner();
        return catalog();
      });
    });
  }
}

for (const when of ["during load", "after load"] as const) {
  test(`catalog retains same-account automatic Cookie rotation ${when}`, async (t) => {
    const storage = await storageFixture(t);
    const rotate = () => new SunoSessions(storage).save(connection.id, {
      ...session, clientToken: clientCookie({ client: "rotated" }),
    });
    await flow(storage, async (url) => {
      const response = await post(url, load);
      assert.equal(response.status, 200, await response.text());
      if (when === "after load") await rotate();
      assert.equal((await state(url)).sunoModelCatalog?.accountId, session.accountId);
    }, async () => {
      if (when === "during load") await rotate();
      return catalog();
    });
  });
}

for (const peer of [false, true]) {
  test(`same account and identical Cookie reimport clears catalog in ${peer ? "peer" : "own"} dialog`, async (t) => {
    const storage = await storageFixture(t);
    await flow(storage, async (url) => {
      const loaded = await post(url, load); assert.equal(loaded.status, 200); await loaded.text();
      const reimport = async (ownerUrl: string) => {
        const response = await post(ownerUrl, { kind: "import_suno_session", serviceId: connection.id,
          sessionValue: session.clientToken }, "same-account-reimport");
        assert.equal(response.status, 200);
        assert.equal((await response.json()).sunoModelCatalog, undefined);
      };
      if (peer) await flow(storage, reimport);
      else await reimport(url);
      assert.equal((await state(url)).sunoModelCatalog, undefined);
      assert.deepEqual(await new SunoSessions(storage).load(connection.id), session);
    });
  });
}

test("catalog Stop releases the command fence and ignores an adapter's late result", { timeout: 10_000 }, async (t) => {
  const storage = await storageFixture(t);
  const started = Promise.withResolvers<void>();
  const pending = Promise.withResolvers<ReturnType<typeof catalog>>();
  let reads = 0;
  let readSignal: AbortSignal | undefined;
  await flow(storage, async (url) => {
    const running = post(url, load);
    await started.promise;
    const duplicate = await post(url, load, "duplicate");
    assert.equal(duplicate.status, 409); await duplicate.text();
    const stopped = await post(url, {}, "catalog-load", "/stop");
    assert.equal(stopped.status, 200); await stopped.text();
    const result = await running;
    assert.equal(result.status, 409);
    const body = await result.json();
    assert.equal(body.commandOutcome, "stopped"); assert.equal(body.state.sunoModelCatalog, undefined);
    assert.equal(readSignal!.aborted, true);
    const retry = await post(url, load, "retry");
    assert.equal(retry.status, 200); assert.deepEqual((await retry.json()).sunoModelCatalog.models, []);
    pending.resolve(catalog());
    assert.deepEqual((await state(url)).sunoModelCatalog!.models, []);
  }, async (_session, _request, signal) => {
    reads++;
    if (reads > 1) return { query: "catalog", models: [] };
    readSignal = signal; started.resolve(); return pending.promise;
  });
});

test("catalog protocol read projects only bounded model display fields through the real adapter", async (t) => {
  const storage = await storageFixture(t);
  const requests: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input); requests.push(url);
    if (url.startsWith("https://auth.suno.com/v1/client?")) {
      assert.equal(new Headers(init?.headers).get("Cookie"), session.clientToken);
      return Response.json({ response: { object: "client", last_active_session_id: "sess_fixture", sessions: [{
        object: "session", id: "sess_fixture", status: "active", expire_at: Date.now() + 60_000,
        user: { object: "user", id: session.accountId },
      }] } });
    }
    if (url.startsWith("https://auth.suno.com/v1/client/sessions/sess_fixture/tokens?")) {
      return Response.json({ jwt: token({ sub: session.accountId, sid: "sess_fixture", exp: Math.floor(Date.now() / 1000) + 600 }) });
    }
    assert.equal(url, "https://studio-api-prod.suno.com/api/billing/info/"); assert.equal(init?.method, "GET");
    return Response.json({ models: [{ external_key: "model-fixture", name: `Fixture ${session.clientToken} https://private.test`,
      can_use: true, is_default_model: true, max_lengths: { title: 80 }, cookie: session.clientToken }],
      plan: { name: "Private plan" }, total_credits_left: 123, account: { cookie: session.clientToken } });
  };
  await flow(storage, async (url) => {
    const response = await post(url, load); const body = await response.text(); assert.equal(response.status, 200, body);
    assert.deepEqual(JSON.parse(body).sunoModelCatalog.models, [{ id: "model-fixture", name: "Fixture [REDACTED] [URL]",
      canUse: true, isDefault: true }]);
    assert.doesNotMatch(body, /eyJ|clientToken|cookie|Private plan|creditsLeft|private\.test|maxLengths/);
    assert.equal(requests.length, 3, "only session lookup, token mint and billing read");
  }, (owner, request, signal) => readSunoMusicService(owner, request, signal, fetcher));
});

test("oversized or failed reload clears the previous catalog and does not change saved settings", async (t) => {
  const storage = await storageFixture(t);
  let reads = 0;
  await flow(storage, async (url) => {
    const settings = await loadAgentSettings(storage);
    const first = await post(url, load); assert.equal(first.status, 200); await first.text();
    const failed = await post(url, load, "oversized"); assert.equal(failed.status, 500); await failed.text();
    assert.equal((await state(url)).sunoModelCatalog, undefined);
    assert.deepEqual(await loadAgentSettings(storage), settings);
  }, async () => reads++ === 0 ? catalog() : { query: "catalog", models: Array.from({ length: 101 }, () => catalog().models[0]!) });
});
