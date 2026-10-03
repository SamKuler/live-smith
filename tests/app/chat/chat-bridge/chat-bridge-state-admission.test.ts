import assert from "node:assert/strict";
import test from "node:test";
import { URL } from "node:url";
import { setTimeout } from "node:timers";

import type { ChatBridgeState, ChatDialogState } from "../../../../src/ui/chat-state.js";
import { createChatBridge } from "../../../../src/app/chat/chat-bridge.js";

let sendSequence = 0;

function sendHeaders(state?: ChatBridgeState): Record<string, string> {
  sendSequence += 1;
  return {
    "Content-Type": "application/json",
    "X-Live-Smith-Send-Id": `state-admission-send-${sendSequence}`,
    ...(state === undefined
      ? {}
      : {
          "X-Live-Smith-Global-State-Covered-Through":
            state.bridgeStateCoveredThroughRevision,
          "X-Live-Smith-Session-State-Covered-Through":
            state.bridgeStateCoveredThroughRevision,
        }),
  };
}

test("send admission requires acknowledged global and target Session state", async () => {
  const state = {} as ChatDialogState;
  let handled = 0;
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async () => state,
    handleSend: async (_input, _stream, _signal, _steering, context) => {
      context.assertStateCoverageCurrent();
      handled += 1;
    },
  });
  const chatUrl = new URL(bridge.url);
  const token = chatUrl.searchParams.get("token");
  const endpoint = (path: string) => `${chatUrl.origin}${path}?token=${token}`;

  try {
    bridge.publishSessionStateInvalidation("s1");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const stale = await fetch(endpoint("/send"), {
        method: "POST",
        headers: sendHeaders(),
        body: JSON.stringify({ prompt: "stale", sessionId: "s1" }),
      });
      assert.equal(stale.status, 409);
      assert.deepEqual(await stale.json(), {
        error:
          "Live Smith state changed in another window. Review the refreshed state and send again.",
        promptPersistence: "not_persisted",
        sendFailureKind: "state_stale",
      });
    }
    assert.equal(handled, 0);

    const sessionState = await fetch(endpoint("/state")).then(
      (response) => response.json() as Promise<ChatBridgeState>,
    );
    const accepted = await fetch(endpoint("/send"), {
      method: "POST",
      headers: sendHeaders(sessionState),
      body: JSON.stringify({ prompt: "current", sessionId: "s1" }),
    });
    assert.equal(accepted.status, 200);
    assert.equal(handled, 1);

    bridge.publishGlobalStateInvalidation();
    const staleGlobal = await fetch(endpoint("/send"), {
      method: "POST",
      headers: sendHeaders(sessionState),
      body: JSON.stringify({ prompt: "old profile", sessionId: "s1" }),
    });
    assert.equal(staleGlobal.status, 409);
    assert.equal(handled, 1);

    const globalState = await fetch(endpoint("/state")).then(
      (response) => response.json() as Promise<ChatBridgeState>,
    );
    const acceptedGlobal = await fetch(endpoint("/send"), {
      method: "POST",
      headers: sendHeaders(globalState),
      body: JSON.stringify({ prompt: "new profile", sessionId: "s1" }),
    });
    assert.equal(acceptedGlobal.status, 200);
    assert.equal(handled, 2);
  } finally {
    await bridge.close();
  }
});

test("send admission rechecks state after configuration snapshot", async () => {
  const state = {} as ChatDialogState;
  const snapshotStarted = Promise.withResolvers<void>();
  const snapshotGate = Promise.withResolvers<void>();
  let handled = 0;
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async () => state,
    handleSend: async (_input, _stream, _signal, _steering, context) => {
      snapshotStarted.resolve();
      await snapshotGate.promise;
      context.assertStateCoverageCurrent();
      handled += 1;
    },
  });
  const chatUrl = new URL(bridge.url);
  const token = chatUrl.searchParams.get("token");
  const endpoint = (path: string) => `${chatUrl.origin}${path}?token=${token}`;
  const initialState = await fetch(endpoint("/state")).then(
    (response) => response.json() as Promise<ChatBridgeState>,
  );
  const send = fetch(endpoint("/send"), {
    method: "POST",
    headers: sendHeaders(initialState),
    body: JSON.stringify({ prompt: "race", sessionId: "s1" }),
  });

  try {
    await snapshotStarted.promise;
    bridge.publishGlobalStateInvalidation();
    snapshotGate.resolve();
    const response = await send;
    assert.equal(response.status, 409);
    assert.equal(
      (await response.json() as { promptPersistence?: string }).promptPersistence,
      "not_persisted",
    );
    assert.equal(handled, 0);
  } finally {
    snapshotGate.resolve();
    await bridge.close();
  }
});

for (const kind of ["command", "attachment selection"] as const) {
  test(`state coverage includes the ${kind} terminal it waits for and peer invalidations received during that wait`, async () => {
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const local = { sessions: [{ id: "s1", creativeBrief: "Local brief" }] } as ChatDialogState;
    const peer = { sessions: [{ id: "s1", creativeBrief: "Peer brief" }] } as ChatDialogState;
    let state = local;
    const mutate = async () => {
      started.resolve();
      await finish.promise;
      return local;
    };
    const bridge = await createChatBridge({
      buildState: async () => state,
      buildInvalidatedSessionState: async () => state,
      renderHtml: () => "<html></html>",
      handleCommand: mutate,
      handleSend: async () => {},
      preflightAttachmentUpload: async () => {},
      handleAttachmentSelection: mutate,
    });
    const endpoint = (pathname: string) => {
      const url = new URL(bridge.url); url.pathname = pathname; return url;
    };
    const url = endpoint(kind === "command" ? "/command" : "/attachments/source-a");
    if (kind !== "command") {
      url.searchParams.set("sessionId", "s1");
      url.searchParams.set("mode", "copy");
      url.searchParams.set("replace", "true");
    }
    const mutation = fetch(url, kind === "command" ? {
      method: "POST", headers: { "Content-Type": "application/json", "X-Live-Smith-Command-Id": "brief-save" },
      body: JSON.stringify({ kind: "set_session_creative_brief", sessionId: "s1", expectedCreativeBrief: "", creativeBrief: "Local brief" }),
    } : { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: new Uint8Array() });
    let read: Promise<Response> | undefined;
    try {
      await started.promise;
      const readUrl = endpoint("/state"); readUrl.searchParams.set("sessionId", "s1");
      read = fetch(readUrl);
      assert.equal(await Promise.race([
        read.then(() => "finished"), new Promise((resolve) => setTimeout(() => resolve("waiting"), 50)),
      ]), "waiting");
      state = peer;
      bridge.publishSessionStateInvalidation("s1");
      finish.resolve();
      const mutationResponse = await mutation;
      assert.equal(mutationResponse.status, kind === "command" ? 200 : 201);
      const committed = await mutationResponse.json() as ChatBridgeState;
      const refreshed = await (await read).json() as ChatBridgeState;
      assert.equal(committed.sessions[0]!.creativeBrief, "Local brief");
      assert.equal(refreshed.sessions[0]!.creativeBrief, "Peer brief");
      assert.equal(committed.bridgeStateCoveredThroughRevision, "0", "a mutation response keeps its original causal cut");
      assert.ok(BigInt(refreshed.bridgeStateCoveredThroughRevision) >= BigInt(committed.bridgeStateRevision),
        "the read starts its snapshot after the mutation publication and the peer invalidation");
      assert.ok(BigInt(refreshed.bridgeStateRevision) > BigInt(refreshed.bridgeStateCoveredThroughRevision));
    } finally {
      finish.resolve();
      await mutation.catch(() => undefined);
      await read?.catch(() => undefined);
      await bridge.close();
    }
  });
}
