import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { connect } from "node:net";
import test from "node:test";

import type { ChatDialogState } from "../ui/chat-state.js";
import { createChatBridge } from "./chat-bridge.js";

interface Deferred {
  readonly promise: Promise<void>;
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

function postCommand(
  bridgeUrl: string,
  commandId: string,
  body: unknown = { kind: "new_session" },
): Promise<Response> {
  return fetch(endpoint(bridgeUrl, "/command"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Live-Smith-Command-Id": commandId,
    },
    body: JSON.stringify(body),
  });
}

function stopCommand(bridgeUrl: string, commandId: string): Promise<Response> {
  return fetch(endpoint(bridgeUrl, "/stop"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Live-Smith-Command-Id": commandId,
    },
    body: "{}",
  });
}

async function readSsePayload(response: Response): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  assert.ok(reader);
  const decoder = new TextDecoder();
  let pending = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      assert.equal(done, false, "SSE ended before publishing a command event.");
      pending += decoder.decode(value, { stream: true });
      const frames = pending.split("\n\n");
      pending = frames.pop() ?? "";
      for (const frame of frames) {
        const data = frame.split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice("data: ".length);
        if (data) return JSON.parse(data) as Record<string, unknown>;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function remainsPending(promise: Promise<unknown>): Promise<boolean> {
  return await Promise.race([
    promise.then(() => false, () => false),
    new Promise<true>((resolve) => setTimeout(() => resolve(true), 25)),
  ]);
}

async function resolvesWithin<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs = 1_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out waiting for ${label}.`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

test("an active command publishes correlated progress while its HTTP response remains pending", async () => {
  const finishCommand = deferred();
  const state = { status: "Command complete." } as ChatDialogState;
  const commandId = "command-progress-1";
  const message = "Compacting Session context…";
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async (_input, _signal, context) => {
      await (context as typeof context & {
        progress(message: string): void | Promise<void>;
      }).progress(message);
      await finishCommand.promise;
      return state;
    },
    handleSend: async () => {},
  });
  const events = await fetch(endpoint(bridge.url, "/events"));
  const command = postCommand(bridge.url, commandId);

  try {
    assert.deepEqual(await readSsePayload(events), {
      type: "command_progress",
      commandId,
      message,
    });
    assert.equal(await remainsPending(command), true);

    finishCommand.resolve();
    assert.equal((await command).status, 200);
  } finally {
    finishCommand.resolve();
    await events.body?.cancel().catch(() => undefined);
    await Promise.allSettled([command, bridge.close()]);
  }
});

test("Stop aborts only the active command with the matching command ID", async () => {
  const started = deferred();
  const aborted = deferred();
  const finishCleanup = deferred();
  const state = {} as ChatDialogState;
  const commandId = "command-stop-match";
  let commandSignal: AbortSignal | undefined;
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async (_input, signal) => {
      commandSignal = signal;
      started.resolve();
      if (!signal.aborted) {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
      aborted.resolve();
      await finishCleanup.promise;
      throw signal.reason;
    },
    handleSend: async () => {},
  });
  const command = postCommand(bridge.url, commandId);

  try {
    await started.promise;
    const stop = await stopCommand(bridge.url, commandId);
    assert.equal(stop.status, 200);
    assert.deepEqual(await stop.json(), {
      ok: true,
      terminal: false,
      commandId,
    });
    await aborted.promise;
    assert.equal(commandSignal?.aborted, true);

    finishCleanup.resolve();
    const commandResponse = await command;
    assert.equal(commandResponse.status, 409);
    const body = await commandResponse.json() as Record<string, unknown>;
    assert.equal(body.commandId, commandId);
    assert.equal(body.commandOutcome, "stopped");
  } finally {
    finishCleanup.resolve();
    await Promise.allSettled([command, bridge.close()]);
  }
});

test("Stop with a different command ID is terminal and does not abort the active command", async () => {
  const started = deferred();
  const finishCommand = deferred();
  const state = {} as ChatDialogState;
  const activeCommandId = "command-stop-active";
  const otherCommandId = "command-stop-other";
  let commandSignal: AbortSignal | undefined;
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async (_input, signal) => {
      commandSignal = signal;
      started.resolve();
      await finishCommand.promise;
      return state;
    },
    handleSend: async () => {},
  });
  const command = postCommand(bridge.url, activeCommandId);

  try {
    await started.promise;
    const stop = await stopCommand(bridge.url, otherCommandId);
    assert.equal(stop.status, 200);
    assert.deepEqual(await stop.json(), {
      ok: true,
      terminal: true,
      commandId: otherCommandId,
    });
    assert.equal(commandSignal?.aborted, false);

    finishCommand.resolve();
    assert.equal((await command).status, 200);
  } finally {
    finishCommand.resolve();
    await Promise.allSettled([command, bridge.close()]);
  }
});

test("a rejected request reusing the active command ID cannot steal its Stop ownership", async () => {
  const started = deferred();
  const finishCleanup = deferred();
  const state = {} as ChatDialogState;
  const commandId = "command-stop-reused-active";
  let commandSignal: AbortSignal | undefined;
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async (_input, signal) => {
      commandSignal = signal;
      started.resolve();
      if (!signal.aborted) {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
      await finishCleanup.promise;
      throw signal.reason;
    },
    handleSend: async () => {},
  });
  const active = postCommand(bridge.url, commandId);

  try {
    await started.promise;
    const rejected = await postCommand(bridge.url, commandId);
    assert.equal(rejected.status, 409);

    const stop = await stopCommand(bridge.url, commandId);
    assert.deepEqual(await stop.json(), {
      ok: true,
      terminal: false,
      commandId,
    });
    assert.equal(commandSignal?.aborted, true);
  } finally {
    finishCleanup.resolve();
    await Promise.allSettled([active, bridge.close()]);
  }
});

test("Stop wins over malformed JSON that finishes during command admission", async () => {
  const state = {} as ChatDialogState;
  let commandCalls = 0;
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async () => {
      commandCalls += 1;
      return state;
    },
    handleSend: async () => {},
  });
  const chatUrl = new URL(bridge.url);
  const token = chatUrl.searchParams.get("token");
  const commandId = "command-stop-during-body";
  const body = '{"kind":"new_session"]';
  const splitAt = Math.floor(body.length / 2);
  const events = await fetch(endpoint(bridge.url, "/events"));
  const socket = connect(Number(chatUrl.port), chatUrl.hostname);

  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.on("error", () => {});
    socket.write([
      `POST /command?token=${token} HTTP/1.1`,
      `Host: ${chatUrl.host}`,
      "Content-Type: application/json",
      `X-Live-Smith-Command-Id: ${commandId}`,
      `Content-Length: ${Buffer.byteLength(body)}`,
      "Connection: close",
      "",
      body.slice(0, splitAt),
    ].join("\r\n"));
    await new Promise<void>((resolve) => setTimeout(resolve, 30));

    const stop = await stopCommand(bridge.url, commandId);
    assert.equal(stop.status, 200);
    assert.deepEqual(await stop.json(), {
      ok: true,
      terminal: false,
      commandId,
    });

    const terminal = readSsePayload(events);
    socket.end(body.slice(splitAt));
    assert.deepEqual(await terminal, {
      type: "error",
      commandId,
      message: "Command stopped by user.",
      commandOutcome: "stopped",
    });
    assert.equal(commandCalls, 0);
  } finally {
    socket.destroy();
    await events.body?.cancel().catch(() => undefined);
    await bridge.close();
  }
});

test("Stop releases the command fence while its request body remains unfinished", {
  timeout: 2_000,
}, async () => {
  const state = {} as ChatDialogState;
  let commandCalls = 0;
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async () => {
      commandCalls += 1;
      return state;
    },
    handleSend: async () => {},
  });
  const chatUrl = new URL(bridge.url);
  const token = chatUrl.searchParams.get("token");
  const commandId = "command-stop-unfinished-body";
  const body = JSON.stringify({ kind: "new_session" });
  const splitAt = Math.floor(body.length / 2);
  const events = await fetch(endpoint(bridge.url, "/events"));
  const socket = connect(Number(chatUrl.port), chatUrl.hostname);

  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.on("error", () => {});
    socket.write([
      `POST /command?token=${token} HTTP/1.1`,
      `Host: ${chatUrl.host}`,
      "Content-Type: application/json",
      `X-Live-Smith-Command-Id: ${commandId}`,
      `Content-Length: ${Buffer.byteLength(body)}`,
      "Connection: close",
      "",
      body.slice(0, splitAt),
    ].join("\r\n"));
    await new Promise<void>((resolve) => setTimeout(resolve, 30));

    const terminal = readSsePayload(events);
    const stop = await resolvesWithin(
      stopCommand(bridge.url, commandId),
      "command Stop acknowledgement",
    );
    assert.deepEqual(await stop.json(), {
      ok: true,
      terminal: false,
      commandId,
    });
    assert.deepEqual(await resolvesWithin(terminal, "stopped command SSE"), {
      type: "error",
      commandId,
      message: "Command stopped by user.",
      commandOutcome: "stopped",
    });

    const next = await resolvesWithin(
      postCommand(bridge.url, "command-after-unfinished-body"),
      "command after stopped admission",
    );
    assert.equal(next.status, 200, await next.text());
    assert.equal(commandCalls, 1);
  } finally {
    socket.destroy();
    await resolvesWithin(
      Promise.allSettled([
        events.body?.cancel(),
        bridge.close(),
      ]),
      "stopped admission cleanup",
    );
  }
});

test("Stop requires exactly one valid Send or Command correlation ID", async () => {
  const state = {} as ChatDialogState;
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async () => state,
    handleSend: async () => {},
  });

  try {
    for (const headers of [
      { "Content-Type": "application/json" },
      {
        "Content-Type": "application/json",
        "X-Live-Smith-Send-Id": "send-stop-id",
        "X-Live-Smith-Command-Id": "command-stop-id",
      },
      {
        "Content-Type": "application/json",
        "X-Live-Smith-Command-Id": "invalid command id",
      },
    ]) {
      const response = await fetch(endpoint(bridge.url, "/stop"), {
        method: "POST",
        headers,
        body: "{}",
      });
      assert.equal(response.status, 400);
    }
  } finally {
    await bridge.close();
  }
});

test("Stop before command admission fences later reuse of that command ID", async () => {
  const state = {} as ChatDialogState;
  const commandId = "command-stop-before-admission";
  let commandCalls = 0;
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async () => {
      commandCalls += 1;
      return state;
    },
    handleSend: async () => {},
  });

  try {
    assert.deepEqual(await (await stopCommand(bridge.url, commandId)).json(), {
      ok: true,
      terminal: true,
      commandId,
    });
    const command = await postCommand(bridge.url, commandId);
    assert.equal(command.status, 409);
    const body = await command.json() as Record<string, unknown>;
    assert.equal(body.commandId, commandId);
    assert.equal(body.commandOutcome, "stopped");
    assert.equal(commandCalls, 0);
  } finally {
    await bridge.close();
  }
});

test("a completed command ID cannot be reused for a later command generation", async () => {
  const state = {} as ChatDialogState;
  const commandId = "command-completed-no-reuse";
  let commandCalls = 0;
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async () => {
      commandCalls += 1;
      return state;
    },
    handleSend: async () => {},
  });

  try {
    assert.equal((await postCommand(bridge.url, commandId)).status, 200);
    const reused = await postCommand(bridge.url, commandId);
    assert.equal(reused.status, 409);
    const body = await reused.json() as Record<string, unknown>;
    assert.equal(body.commandId, commandId);
    assert.match(String(body.error), /already used.*cannot be reused/i);
    assert.equal(body.commandOutcome, undefined);
    assert.equal(commandCalls, 1);
  } finally {
    await bridge.close();
  }
});
