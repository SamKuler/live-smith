import assert from "node:assert/strict";
import test from "node:test";
import { createDialogHarness, stateFixture } from "../support/chat-dialog.test-harness.js";

test("an unregistered audio provider matching an object prototype key is rejected without a client exception", async () => {
  const state = stateFixture();
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Inspect the selected track");
    harness.click("#sendButton");
    await harness.settle();
    harness.emitServerEvent({
      type: "done", sendId: harness.sendIds[0], sessionId: state.activeSessionId,
      state: { ...state, audioJobs: [{ id: "job", provider: "constructor", serviceId: "connection", stems: [] }] },
    });
    await harness.settle();
    assert.match(harness.document.querySelector("#sendButton")!.textContent!, /Stop/);
    assert.deepEqual(harness.readBootstrappedClientStateReference().audioJobs, state.audioJobs);
    assert.deepEqual(harness.errors, []);
    harness.releaseHeldSend();
    await harness.settle();
    assert.match(harness.document.querySelector("#sendButton")!.textContent!, /Send/);
  } finally {
    harness.close();
  }
});

test("invalid Connection string fields cannot enter state through scalar coercion", async () => {
  const state = stateFixture();
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Inspect the selected track");
    harness.click("#sendButton");
    await harness.settle();
    const connection = {
      id: "installed-search", name: "Search", enabled: false, pluginId: "search-tools",
      configuration: { serverId: "search", pluginDigest: "a".repeat(64) }, configuredSecrets: [],
    };
    for (const configuration of [
      { ...connection.configuration, serverId: 123 },
      { ...connection.configuration, serverId: ["search"] },
      { ...connection.configuration, pluginDigest: ["a".repeat(64)] },
    ]) {
      harness.emitServerEvent({
        type: "done", sendId: harness.sendIds[0], sessionId: state.activeSessionId,
        state: {
          ...state,
          integrationConnections: { revision: "1", connections: [{ ...connection, configuration }] },
        },
      });
      await harness.settle();
      assert.match(harness.document.querySelector("#sendButton")!.textContent!, /Stop/);
      assert.doesNotMatch(JSON.stringify(harness.readBootstrappedClientStateReference()), /installed-search/);
    }
    harness.releaseHeldSend();
    await harness.settle();
    assert.match(harness.document.querySelector("#sendButton")!.textContent!, /Send/);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});
