import assert from "node:assert/strict";
import test from "node:test";

import type { ChatDialogState } from "../ui/chat-state.js";
import {
  ChatBridgePromptPersistenceUnknownError,
  createChatBridge,
  type PromptPersistence,
} from "./chat-bridge.js";

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function endpoint(bridgeUrl: string, path: string): string {
  const chatUrl = new URL(bridgeUrl);
  return `${chatUrl.origin}${path}?token=${chatUrl.searchParams.get("token")}`;
}

async function postStop(
  bridgeUrl: string,
  sendId: string,
  body = "{}",
): Promise<Response> {
  return await fetch(endpoint(bridgeUrl, "/stop"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Live-Smith-Send-Id": sendId,
    },
    body,
  });
}

test("terminal Stop polling returns and consumes the correlated prompt persistence", async (t) => {
  for (const expected of [
    "persisted",
    "not_persisted",
    "unknown",
  ] as const) {
    await t.test(expected, async () => {
      const started = deferred();
      const finishCleanup = deferred();
      const state = {} as ChatDialogState;
      const sendId = `stop-terminal-${expected}`;
      const bridge = await createChatBridge({
        buildState: async () => state,
        renderHtml: () => "<html></html>",
        handleCommand: async () => state,
        handleSend: async (_input, stream, signal) => {
          if (expected === "persisted") {
            await stream.sessionEvent({
              id: "user-event",
              createdAt: "2026-08-20T00:00:00.000Z",
              kind: "user",
              content: "stored prompt",
            });
          }
          started.resolve();
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
          await finishCleanup.promise;
          if (expected === "unknown") {
            throw new ChatBridgePromptPersistenceUnknownError(
              "Prompt storage commit could not be confirmed.",
            );
          }
          throw signal.reason;
        },
      });
      const send = fetch(endpoint(bridge.url, "/send"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Live-Smith-Send-Id": sendId,
        },
        body: JSON.stringify({ prompt: "test", sessionId: "session-1" }),
      });

      try {
        await started.promise;
        const firstStop = await postStop(bridge.url, sendId);
        assert.deepEqual(await firstStop.json(), {
          ok: true,
          terminal: false,
          sendId,
        });

        finishCleanup.resolve();
        const sendResponse = await send;
        assert.equal(sendResponse.status, 500);
        assert.equal(
          (await sendResponse.json() as { promptPersistence: PromptPersistence })
            .promptPersistence,
          expected,
        );

        const terminalStop = await postStop(bridge.url, sendId);
        assert.deepEqual(await terminalStop.json(), {
          ok: true,
          terminal: true,
          sendId,
          promptPersistence: expected,
        });

        const consumedStop = await postStop(bridge.url, sendId);
        assert.deepEqual(await consumedStop.json(), {
          ok: true,
          terminal: true,
          sendId,
          promptPersistence: "unknown",
        });
      } finally {
        finishCleanup.resolve();
        await bridge.close();
        await send.catch(() => undefined);
      }
    });
  }
});

test("Stop outcomes remain exact to their send ID and are invalidated by ID reuse", async () => {
  const state = {} as ChatDialogState;
  const starts = new Map<string, Deferred>();
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async () => state,
    handleSend: async (input, stream, signal, _steering, context) => {
      if (input.prompt === "persist") {
        await stream.sessionEvent({
          id: `user-${context.sendId}`,
          createdAt: "2026-08-20T00:00:00.000Z",
          kind: "user",
          content: "stored prompt",
        });
      }
      starts.get(context.sendId)?.resolve();
      if (input.prompt === "complete") return;
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    },
  });

  const stopAndCache = async (
    sendId: string,
    prompt: string,
    verifyStrictBody = false,
  ) => {
    const started = deferred();
    starts.set(sendId, started);
    const send = fetch(endpoint(bridge.url, "/send"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Live-Smith-Send-Id": sendId,
      },
      body: JSON.stringify({ prompt, sessionId: "session-1" }),
    });
    await started.promise;
    if (verifyStrictBody) {
      const rejected = await postStop(
        bridge.url,
        sendId,
        JSON.stringify({ prompt: "must not enter Stop state" }),
      );
      assert.equal(rejected.status, 400);
    }
    assert.deepEqual(await (await postStop(bridge.url, sendId)).json(), {
      ok: true,
      terminal: false,
      sendId,
    });
    assert.equal((await send).status, 500);
  };

  try {
    await stopAndCache("stopped-persisted", "persist", true);
    await stopAndCache("stopped-not-persisted", "discard");

    assert.deepEqual(await (await postStop(bridge.url, "older-send")).json(), {
      ok: true,
      terminal: true,
      sendId: "older-send",
      promptPersistence: "unknown",
    });
    assert.deepEqual(
      await (await postStop(bridge.url, "stopped-persisted")).json(),
      {
        ok: true,
        terminal: true,
        sendId: "stopped-persisted",
        promptPersistence: "persisted",
      },
    );
    assert.deepEqual(
      await (await postStop(bridge.url, "stopped-not-persisted")).json(),
      {
        ok: true,
        terminal: true,
        sendId: "stopped-not-persisted",
        promptPersistence: "not_persisted",
      },
    );

    await stopAndCache("reused-send", "persist");
    const reusedStarted = deferred();
    starts.set("reused-send", reusedStarted);
    const reused = fetch(endpoint(bridge.url, "/send"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Live-Smith-Send-Id": "reused-send",
      },
      body: JSON.stringify({ prompt: "complete", sessionId: "session-1" }),
    });
    await reusedStarted.promise;
    assert.equal((await reused).status, 200);
    assert.deepEqual(await (await postStop(bridge.url, "reused-send")).json(), {
      ok: true,
      terminal: true,
      sendId: "reused-send",
      promptPersistence: "unknown",
    });
  } finally {
    await bridge.close();
  }
});

test("Stop terminal retention is bounded and does not cross bridge close", async () => {
  const state = {} as ChatDialogState;
  let started = deferred();
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async () => state,
    handleSend: async (_input, _stream, signal) => {
      started.resolve();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    },
  });

  try {
    for (let index = 0; index < 65; index += 1) {
      const sendId = `bounded-stop-${index}`;
      started = deferred();
      const send = fetch(endpoint(bridge.url, "/send"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Live-Smith-Send-Id": sendId,
        },
        body: JSON.stringify({ prompt: "test", sessionId: "session-1" }),
      });
      await started.promise;
      await postStop(bridge.url, sendId);
      assert.equal((await send).status, 500);
    }

    assert.equal(
      (await (await postStop(bridge.url, "bounded-stop-0")).json() as {
        promptPersistence: PromptPersistence;
      }).promptPersistence,
      "unknown",
    );
    assert.equal(
      (await (await postStop(bridge.url, "bounded-stop-64")).json() as {
        promptPersistence: PromptPersistence;
      }).promptPersistence,
      "not_persisted",
    );
  } finally {
    await bridge.close();
  }

  const replacement = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async () => state,
    handleSend: async () => undefined,
  });
  try {
    assert.equal(
      (await (await postStop(replacement.url, "bounded-stop-63")).json() as {
        promptPersistence: PromptPersistence;
      }).promptPersistence,
      "unknown",
    );
  } finally {
    await replacement.close();
  }
});
