import assert from "node:assert/strict";
import test from "node:test";
import type { AudioServiceConnectionView } from "../audio-services/contracts.js";
import type { ChatBridgeState } from "./chat-state.js";
import { createDialogHarness } from "./chat-dialog.test-harness.js";
import {
  audioState,
  broadcast,
  integrationConnectionView,
  musicService,
} from "./chat-dialog.audio-test-helpers.js";

const website: AudioServiceConnectionView = {
  id: "suno-personal", name: "Personal Suno", provider: "suno", enabled: false, apiKeyConfigured: false,
};
const account = { serviceId: website.id, status: "signed_in" as const, accountId: "user_personal", accountName: "Personal musician" };
const stateFixture = (): ChatBridgeState => ({ ...audioState([website, musicService]), sunoAccounts: [account] });

test("full-state decoder rejects unknown, credential-bearing, malformed and misowned Suno account fields", async () => {
  const state = stateFixture();
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Inspect the selected track");
    harness.click("#sendButton");
    await harness.settle();
    const invalidAccounts = [
      null, {}, [null], [account, account],
      [{ ...account, status: "ready" }],
      [{ ...account, status: "signed_out" }],
      [{ ...account, status: "browser_open" }],
      [{ ...account, status: "expired" }],
      [{ ...account, status: "unavailable" }],
      [{ ...account, serviceId: musicService.id }],
      [{ ...account, serviceId: "missing-connection" }],
      ...["", "_user", "-user", "x".repeat(129), "https://suno.com/account", "user@example.com", "user\nname",
        "<img src=x>", "a.b.c", "session=value", null, 5].map((accountId) => [{ ...account, accountId }]),
      ...["", " ", "x".repeat(161), "user\nname", "user\u0085name", "eyJ0ZXN0Ijox.e30.YQ", null, 5].map((accountName) => [{ ...account, accountName }]),
      ...["apiKey", "cookies", "sessionValue", "clientToken", "url", "profileDirectory", "authorization"].map((field) => [{ ...account, [field]: "fixture-forbidden" }]),
    ];
    for (const sunoAccounts of invalidAccounts) {
      harness.emitServerEvent({ type: "done", sendId: harness.sendIds[0], sessionId: state.activeSessionId,
        state: { ...state, sunoAccounts } });
      await harness.settle();
      assert.match(harness.document.querySelector("#sendButton")!.textContent!, /Stop/, JSON.stringify(sunoAccounts));
      assert.equal(harness.document.querySelector("#sunoAccountName")!.textContent, "Suno account: Personal musician");
      assert.doesNotMatch(JSON.stringify(harness.readBootstrappedClientStateReference()), /fixture-forbidden/);
    }
    harness.setServerState({ ...state, sunoAccounts: [{ serviceId: website.id, status: "signed_in" }] });
    harness.releaseHeldSend();
    await harness.settle();
    assert.match(harness.document.querySelector("#sendButton")!.textContent!, /Send/);
    assert.equal(harness.document.querySelector("#sunoLoginStatus")!.textContent, "Connected to Suno.com");
    assert.equal(harness.document.querySelector("#sunoAccountName")!.textContent, "", "identity is optional when signed in");
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("an older snapshot cut cannot replace newer Suno inspection evidence even if published later", async () => {
  const state = stateFixture();
  const harness = await createDialogHarness(state);
  try {
    harness.setServerState({ ...state, sunoAccounts: [{ serviceId: website.id, status: "signed_out" }] });
    harness.queueNextStatePublication("20", "19");
    harness.click("#refreshSunoLoginButton");
    await harness.settle();
    assert.equal(harness.document.querySelector("#sunoLoginStatus")!.textContent, "Not connected");
    harness.setServerState(state);
    harness.queueNextStatePublication("30", "10");
    harness.click("#openSunoWebsiteButton");
    await harness.settle();
    assert.equal(harness.document.querySelector("#sunoLoginStatus")!.textContent, "Not connected");
    assert.equal(harness.document.querySelector("#sunoAccountName")!.textContent, "");
    const row = harness.document.querySelector<HTMLElement>(`[data-audio-service-id="${website.id}"]`)!;
    assert.equal(row.querySelector(".audio-service-status")!.textContent, "Disabled");
    assert.match(row.title, /Not connected/);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("a delayed login reply cannot restore an account for a saved connection whose provider changed", async () => {
  const state = stateFixture();
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextCommand();
    harness.click("#refreshSunoLoginButton");
    const next = {
      revision: "2",
      connections: [
        integrationConnectionView({ ...website, provider: "lalal" as const }),
        integrationConnectionView(musicService),
      ],
    };
    harness.emitServerEvent(broadcast(state, next));
    await harness.settle();
    harness.releaseHeldCommand();
    await harness.settle();
    assert.equal(harness.document.querySelector<HTMLSelectElement>("#audioServiceProvider")!.value, "lalal");
    assert.equal(harness.document.querySelector<HTMLElement>("#sunoLoginControls")!.hidden, true);
    assert.equal(harness.document.querySelector("#sunoAccountName")!.textContent, "");
    assert.deepEqual(JSON.parse(JSON.stringify(harness.readBootstrappedClientStateReference().sunoAccounts)), []);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("bounded account names are rendered as text while opaque IDs are never displayed", async () => {
  const state = stateFixture();
  state.sunoAccounts = [{ ...account, accountId: "A" + "x".repeat(126) + "-", accountName: "<img src=x>" + "作".repeat(149) }];
  const harness = await createDialogHarness(state);
  try {
    harness.click("#refreshSunoLoginButton");
    await harness.settle();
    assert.equal(harness.document.querySelector("#sunoAccountName")!.textContent, "Suno account: " + state.sunoAccounts![0]!.accountName);
    assert.equal(harness.document.querySelector("#sunoAccountName")!.childElementCount, 0);
    assert.doesNotMatch(harness.document.body.textContent!, new RegExp(state.sunoAccounts![0]!.accountId!));
    harness.setServerState({ ...state, sunoAccounts: [{ ...state.sunoAccounts![0]!, status: "saved" }] });
    harness.click("#refreshSunoLoginButton");
    await harness.settle();
    assert.equal(harness.document.querySelector("#sunoLoginStatus")!.textContent, "Cookie saved; refresh to verify");
    assert.equal(harness.document.querySelector("#sunoAccountName")!.textContent, "Suno account: " + state.sunoAccounts![0]!.accountName);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});
