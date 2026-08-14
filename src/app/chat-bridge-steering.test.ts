import assert from "node:assert/strict";
import test from "node:test";

import type { ChatDialogState } from "../ui/chat-state.js";
import { createChatBridge } from "./chat-bridge.js";
import {
  SteeringPersistenceOutcomeUnknownError,
  type SteeringChannel,
} from "./steering.js";

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((targetResolve) => {
    resolve = targetResolve;
  });
  return { promise, resolve };
}

function bridgeEndpoint(bridgeUrl: string, path: string): string {
  const chatUrl = new URL(bridgeUrl);
  return `${chatUrl.origin}${path}?token=${chatUrl.searchParams.get("token")}`;
}

function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function steer(
  bridgeUrl: string,
  sendId: string,
  steerId: string,
  prompt: string,
  sessionId = "session-1",
): Promise<Response> {
  return postJson(
    bridgeEndpoint(bridgeUrl, "/steer"),
    { prompt, sessionId },
    {
      "X-Live-Smith-Send-Id": sendId,
      "X-Live-Smith-Steer-Id": steerId,
    },
  );
}

async function remainsPending(promise: Promise<unknown>): Promise<boolean> {
  return await Promise.race([
    promise.then(() => false, () => false),
    new Promise<true>((resolve) => setTimeout(() => resolve(true), 20)),
  ]);
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Condition was not reached.");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

async function readSseTypes(
  response: Response,
  requiredTypes: readonly string[],
): Promise<Record<string, unknown>[]> {
  assert.ok(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events: Record<string, unknown>[] = [];
  let buffer = "";
  const deadline = Date.now() + 1_000;
  while (requiredTypes.some((type) => !events.some((event) => event.type === type))) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for SSE events.");
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    for (;;) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary < 0) break;
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = frame.split("\n").find((line) => line.startsWith("data: "));
      if (data) events.push(JSON.parse(data.slice(6)) as Record<string, unknown>);
    }
  }
  return events;
}

test("steering requires a strict bounded body and exact active send target", async () => {
  const finish = deferred();
  const started = deferred();
  const state = {} as ChatDialogState;
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async () => state,
    handleSend: async () => {
      started.resolve();
      await finish.promise;
    },
  });
  const sendId = "send-target";
  const send = postJson(
    bridgeEndpoint(bridge.url, "/send"),
    { prompt: "start", sessionId: "session-1" },
    { "X-Live-Smith-Send-Id": sendId },
  );

  try {
    await started.promise;
    const missingHeaders = await postJson(
      bridgeEndpoint(bridge.url, "/steer"),
      { prompt: "change", sessionId: "session-1" },
    );
    const unknownField = await postJson(
      bridgeEndpoint(bridge.url, "/steer"),
      { prompt: "change", sessionId: "session-1", profile: {} },
      {
        "X-Live-Smith-Send-Id": sendId,
        "X-Live-Smith-Steer-Id": "steer-extra",
      },
    );
    const emptyPrompt = await steer(bridge.url, sendId, "steer-empty", "   ");
    const oversizedPrompt = await steer(
      bridge.url,
      sendId,
      "steer-large",
      "é".repeat(32_769),
    );
    const wrongSend = await steer(
      bridge.url,
      "another-send",
      "steer-wrong-send",
      "change",
    );
    const wrongSession = await steer(
      bridge.url,
      sendId,
      "steer-wrong-session",
      "change",
      "session-2",
    );

    assert.equal(missingHeaders.status, 400);
    assert.equal(unknownField.status, 400);
    assert.equal(emptyPrompt.status, 400);
    assert.equal(oversizedPrompt.status, 400);
    assert.equal(wrongSend.status, 409);
    assert.equal(wrongSession.status, 409);
  } finally {
    finish.resolve();
    await send;
    await bridge.close();
  }
});

test("steering waits for owner persistence and emits prompt-free acceptance SSE", async () => {
  const started = deferred();
  const consume = deferred();
  const finish = deferred();
  let laterConfirmation: Promise<boolean> | undefined;
  const state = {} as ChatDialogState;
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async () => state,
    handleSend: async (_input, stream, _signal, steering) => {
      started.resolve();
      await consume.promise;
      const [entry] = steering.takePending();
      assert.ok(entry);
      assert.equal(entry.id, "steer-1");
      assert.equal(entry.prompt, "focus on drums");
      await stream.assistantReset();
      entry.accept();
      laterConfirmation = stream.requestConfirmation({
        message: "Apply the steered plan?",
        groups: [{ title: "Track", rows: ["Rename Lead"] }],
      });
      await laterConfirmation;
      await finish.promise;
    },
  });
  const eventsResponse = await fetch(bridgeEndpoint(bridge.url, "/events"));
  const sendId = "send-1";
  const send = postJson(
    bridgeEndpoint(bridge.url, "/send"),
    { prompt: "start", sessionId: "session-1" },
    { "X-Live-Smith-Send-Id": sendId },
  );

  try {
    await started.promise;
    const steeringResponse = steer(
      bridge.url,
      sendId,
      "steer-1",
      "focus on drums",
    );
    assert.equal(await remainsPending(steeringResponse), true);
    consume.resolve();
    const response = await steeringResponse;
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });

    const idempotent = await steer(
      bridge.url,
      sendId,
      "steer-1",
      "focus on drums",
    );
    assert.ok(laterConfirmation);
    assert.equal(await remainsPending(laterConfirmation), true);
    const conflict = await steer(
      bridge.url,
      sendId,
      "steer-1",
      "focus on bass",
    );
    assert.equal(idempotent.status, 200);
    assert.equal(conflict.status, 409);

    const events = await readSseTypes(eventsResponse, [
      "assistant_reset",
      "steer_accepted",
    ]);
    const accepted = events.find((event) => event.type === "steer_accepted");
    assert.deepEqual(accepted, {
      type: "steer_accepted",
      sendId,
      sessionId: "session-1",
      steerId: "steer-1",
    });
    assert.equal(JSON.stringify(accepted).includes("focus on drums"), false);
  } finally {
    finish.resolve();
    await bridge.close();
    await send.catch(() => undefined);
  }
});

test("steering supersedes an open confirmation before it is persisted", async () => {
  const confirmationStarted = deferred();
  const state = {} as ChatDialogState;
  let confirmationResult: boolean | undefined;
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async () => state,
    handleSend: async (_input, stream, _signal, steering) => {
      confirmationStarted.resolve();
      confirmationResult = await stream.requestConfirmation({
        message: "Apply the old plan?",
        groups: [{ title: "Track", rows: ["Delete track"] }],
      });
      const [entry] = steering.takePending();
      assert.ok(entry);
      entry.accept();
    },
  });
  const sendId = "send-confirm";
  const send = postJson(
    bridgeEndpoint(bridge.url, "/send"),
    { prompt: "start", sessionId: "session-1" },
    { "X-Live-Smith-Send-Id": sendId },
  );

  try {
    await confirmationStarted.promise;
    const response = await steer(
      bridge.url,
      sendId,
      "steer-confirm",
      "do not delete it",
    );
    assert.equal(response.status, 200);
    assert.equal((await send).status, 200);
    assert.equal(confirmationResult, false);
  } finally {
    await bridge.close();
  }
});

test("the send terminal boundary rejects queued and stale steering", async () => {
  const started = deferred();
  const finish = deferred();
  let steeringChannel: SteeringChannel | undefined;
  const state = {} as ChatDialogState;
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async () => state,
    handleSend: async (_input, _stream, _signal, steering) => {
      steeringChannel = steering;
      started.resolve();
      await finish.promise;
    },
  });
  const sendId = "send-terminal";
  const send = postJson(
    bridgeEndpoint(bridge.url, "/send"),
    { prompt: "start", sessionId: "session-1" },
    { "X-Live-Smith-Send-Id": sendId },
  );

  try {
    await started.promise;
    const queuedSteering = steer(
      bridge.url,
      sendId,
      "steer-terminal",
      "too late",
    );
    await waitUntil(() => steeringChannel?.hasPending() === true);
    finish.resolve();
    assert.equal((await queuedSteering).status, 409);
    assert.equal((await send).status, 200);
    const stale = await steer(
      bridge.url,
      sendId,
      "steer-stale",
      "later still",
    );
    assert.equal(stale.status, 409);
  } finally {
    finish.resolve();
    await send;
    await bridge.close();
  }
});

test("the HTTP bridge reports steering mailbox capacity as a conflict", async () => {
  const started = deferred();
  const finish = deferred();
  let steeringChannel: SteeringChannel | undefined;
  let confirmation: Promise<boolean> | undefined;
  const state = {} as ChatDialogState;
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async () => state,
    handleSend: async (_input, stream, _signal, steering) => {
      steeringChannel = steering;
      confirmation = stream.requestConfirmation({
        message: "Apply the pending plan?",
        groups: [{ title: "Track", rows: ["Rename track"] }],
      });
      started.resolve();
      await confirmation;
      await finish.promise;
    },
  });
  const sendId = "send-capacity";
  const send = postJson(
    bridgeEndpoint(bridge.url, "/send"),
    { prompt: "start", sessionId: "session-1" },
    { "X-Live-Smith-Send-Id": sendId },
  );

  try {
    await started.promise;
    assert.ok(steeringChannel);
    for (let index = 0; index < 8; index += 1) {
      void steeringChannel.submit(`prefill-${index}`, `prompt ${index}`).catch(() => {});
    }
    const response = await steer(
      bridge.url,
      sendId,
      "steer-over-capacity",
      "one too many",
    );
    assert.equal(response.status, 409);
    assert.match(
      (await response.json() as { error: string }).error,
      /8 unsettled submissions/,
    );
    assert.ok(confirmation);
    assert.equal(await remainsPending(confirmation), true);
  } finally {
    finish.resolve();
    await bridge.close();
    await send.catch(() => undefined);
  }
});

test("stop closes the steering channel before aborting its active send", async () => {
  const started = deferred();
  let steeringChannel: SteeringChannel | undefined;
  let observedAbort = false;
  const state = {} as ChatDialogState;
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async () => state,
    handleSend: async (_input, _stream, signal, steering) => {
      steeringChannel = steering;
      started.resolve();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          observedAbort = true;
          reject(signal.reason);
        }, { once: true });
      });
    },
  });
  const sendId = "send-stop";
  const send = postJson(
    bridgeEndpoint(bridge.url, "/send"),
    { prompt: "start", sessionId: "session-1" },
    { "X-Live-Smith-Send-Id": sendId },
  );

  try {
    await started.promise;
    const queuedSteering = steer(
      bridge.url,
      sendId,
      "steer-stop",
      "change course",
    );
    await waitUntil(() => steeringChannel?.hasPending() === true);
    const stop = await postJson(
      bridgeEndpoint(bridge.url, "/stop"),
      {},
      { "X-Live-Smith-Send-Id": sendId },
    );
    assert.equal(stop.status, 200);
    assert.equal((await queuedSteering).status, 409);
    assert.equal((await send).status, 500);
    assert.equal(observedAbort, true);
  } finally {
    await bridge.close();
  }
});

test("the steering route reports an explicit unknown persistence outcome", async () => {
  const started = deferred();
  const finish = deferred();
  const state = {} as ChatDialogState;
  const sendId = "send-unknown";
  let lookupCount = 0;
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async () => state,
    handleSend: async (_input, _stream, _signal, steering) => {
      started.resolve();
      while (!steering.hasPending()) {
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
      }
      const [entry] = steering.takePending();
      assert.ok(entry);
      entry.reject(new SteeringPersistenceOutcomeUnknownError(
        sendId,
        entry.id,
      ));
      await finish.promise;
    },
    lookupSteeringReceipt: async () => {
      lookupCount += 1;
      if (lookupCount === 1) {
        throw new Error("injected receipt read failure");
      }
      return "accepted";
    },
  });
  const send = postJson(
    bridgeEndpoint(bridge.url, "/send"),
    { prompt: "start", sessionId: "session-1" },
    { "X-Live-Smith-Send-Id": sendId },
  );

  try {
    await started.promise;
    const response = await steer(
      bridge.url,
      sendId,
      "steer-unknown",
      "focus on drums",
    );
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: "The steering persistence outcome could not be confirmed.",
      steeringOutcome: "unknown",
    });
    const retried = await steer(
      bridge.url,
      sendId,
      "steer-unknown",
      "focus on drums",
    );
    assert.equal(retried.status, 200);
    assert.deepEqual(await retried.json(), { ok: true });
  } finally {
    finish.resolve();
    await send;
    await bridge.close();
  }
});

test("terminal steering retries reconcile only an exact durable receipt", async () => {
  const state = {} as ChatDialogState;
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async () => state,
    handleSend: async () => state,
    lookupSteeringReceipt: async (input) => {
      if (input.sendId !== "send-terminal-receipt" || input.steerId !== "steer-1") {
        return "absent";
      }
      return input.prompt === "focus on drums" ? "accepted" : "conflict";
    },
  });

  try {
    const accepted = await steer(
      bridge.url,
      "send-terminal-receipt",
      "steer-1",
      "focus on drums",
    );
    const conflict = await steer(
      bridge.url,
      "send-terminal-receipt",
      "steer-1",
      "focus on bass",
    );
    const absent = await steer(
      bridge.url,
      "send-terminal-receipt",
      "steer-2",
      "focus on drums",
    );

    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { ok: true });
    assert.equal(conflict.status, 409);
    assert.equal(absent.status, 409);
  } finally {
    await bridge.close();
  }
});
