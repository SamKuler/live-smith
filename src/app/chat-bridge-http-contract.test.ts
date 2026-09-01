import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { connect } from "node:net";
import test from "node:test";

import type { ChatBridgeState, ChatDialogState } from "../ui/chat-state.js";
import { createChatBridge } from "./chat-bridge.js";

const jsonBody = JSON.stringify({ kind: "new_session" });
const capabilityReadInput = {
  kind: "load_session_model_capabilities",
  sessionId: "session-1",
  profileId: "profile-1",
} as const;
const capabilityReadBody = JSON.stringify(capabilityReadInput);
const skillBody = Buffer.from(
  "---\nname: mix-review\ndescription: Review a mix\n---\nKeep it clear.\n",
);

async function createContractBridge() {
  const state = {} as ChatDialogState;
  let commandCalls = 0;
  let sendCalls = 0;
  let skillInstallCalls = 0;
  let skillDeleteCalls = 0;
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async () => {
      commandCalls += 1;
      return state;
    },
    handleSend: async () => {
      sendCalls += 1;
      return state;
    },
    preflightAttachmentUpload: async () => {},
    handleAttachmentUpload: async () => state,
    handleAttachmentDelete: async () => state,
    handleSkillInstall: async () => {
      skillInstallCalls += 1;
      return {
        state,
        receipt: { id: "mix-review", sha256: "a".repeat(64) },
      };
    },
    handleSkillDelete: async () => {
      skillDeleteCalls += 1;
      return state;
    },
  });
  return {
    bridge,
    calls: () => ({
      commandCalls,
      sendCalls,
      skillDeleteCalls,
      skillInstallCalls,
    }),
  };
}

function bridgeAddress(url: string): { origin: string; token: string } {
  const chatUrl = new URL(url);
  const token = chatUrl.searchParams.get("token");
  assert.ok(token);
  return { origin: chatUrl.origin, token };
}

function request(
  origin: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`${origin}${path}`, init);
}

test("known bridge routes reject duplicate tokens and route-specific extra query fields", async () => {
  const { bridge } = await createContractBridge();
  const { origin, token } = bridgeAddress(bridge.url);
  const jsonHeaders = {
    "Content-Type": "application/json",
    "X-Live-Smith-Command-Id": "query-command",
    "X-Live-Smith-Send-Id": "query-send",
    "X-Live-Smith-Steer-Id": "query-steer",
  };
  const cases: Array<{
    path: string;
    init?: RequestInit;
  }> = [
    { path: `/state?token=${token}&token=${token}` },
    { path: `/chat?token=${token}&extra=1` },
    { path: `/state?token=${token}&extra=1` },
    { path: `/events?token=${token}&extra=1` },
    {
      path: `/send?token=${token}&extra=1`,
      init: {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ prompt: "test", sessionId: "session-1" }),
      },
    },
    {
      path: `/command?token=${token}&extra=1`,
      init: { method: "POST", headers: jsonHeaders, body: jsonBody },
    },
    {
      path: `/session-model-capabilities?token=${token}&extra=1`,
      init: { method: "POST", headers: jsonHeaders, body: capabilityReadBody },
    },
    {
      path: `/session-model-capabilities?token=${token}&token=${token}`,
      init: { method: "POST", headers: jsonHeaders, body: capabilityReadBody },
    },
    {
      path: `/steer?token=${token}&extra=1`,
      init: {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ prompt: "change", sessionId: "session-1" }),
      },
    },
    {
      path: `/confirm?token=${token}&extra=1`,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "confirmation-1", apply: false }),
      },
    },
    {
      path: `/stop?token=${token}&extra=1`,
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Live-Smith-Send-Id": "query-stop",
        },
        body: "{}",
      },
    },
    {
      path:
        `/attachments?token=${token}&sessionId=session-1&fileName=test.png&extra=1`,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: Buffer.from("x"),
      },
    },
    {
      path:
        `/attachments/attachment-1?token=${token}&sessionId=session-1&extra=1`,
      init: { method: "DELETE" },
    },
    {
      path: `/skills?token=${token}&replace=false&extra=1`,
      init: {
        method: "POST",
        headers: {
          "Content-Type": "text/markdown; charset=utf-8",
          "X-Live-Smith-Command-Id": "query-skill-install",
        },
        body: skillBody,
      },
    },
    {
      path: `/skills/mix-review?token=${token}&extra=1`,
      init: {
        method: "DELETE",
        headers: { "X-Live-Smith-Command-Id": "query-skill-delete" },
      },
    },
  ];

  try {
    for (const entry of cases) {
      const response = await request(origin, entry.path, entry.init);
      assert.equal(response.status, 400, entry.path);
      await response.body?.cancel();
    }
  } finally {
    await bridge.close();
  }
});

test("every JSON route requires one unambiguous application/json media type", async () => {
  const { bridge } = await createContractBridge();
  const { origin, token } = bridgeAddress(bridge.url);
  const cases: Array<{
    path: string;
    body: string;
    headers?: Record<string, string>;
  }> = [
    {
      path: "/send",
      body: JSON.stringify({ prompt: "test", sessionId: "session-1" }),
      headers: { "X-Live-Smith-Send-Id": "media-send" },
    },
    {
      path: "/command",
      body: jsonBody,
      headers: { "X-Live-Smith-Command-Id": "media-command" },
    },
    {
      path: "/session-model-capabilities",
      body: capabilityReadBody,
      headers: { "X-Live-Smith-Command-Id": "media-capabilities" },
    },
    {
      path: "/steer",
      body: JSON.stringify({ prompt: "change", sessionId: "session-1" }),
      headers: {
        "X-Live-Smith-Send-Id": "media-send",
        "X-Live-Smith-Steer-Id": "media-steer",
      },
    },
    {
      path: "/confirm",
      body: JSON.stringify({ id: "confirmation-1", apply: false }),
    },
    {
      path: "/stop",
      body: "{}",
      headers: { "X-Live-Smith-Send-Id": "media-stop" },
    },
  ];

  try {
    for (const entry of cases) {
      for (const contentType of [
        "text/plain",
        "application/json; charset=iso-8859-1",
        "application/json; profile=unsupported",
        undefined,
      ]) {
        const headers = {
          ...(entry.headers ?? {}),
          ...(contentType === undefined ? {} : { "Content-Type": contentType }),
        };
        const response = await request(
          origin,
          `${entry.path}?token=${token}`,
          {
            method: "POST",
            headers,
            body: contentType === undefined
              ? Buffer.from(entry.body)
              : entry.body,
          },
        );
        assert.equal(
          response.status,
          400,
          `${entry.path} with ${contentType ?? "no Content-Type"}`,
        );
      }
    }

    const accepted = await request(origin, `/command?token=${token}`, {
      method: "POST",
      headers: {
        "Content-Type": "Application/JSON; Charset=UTF-8",
        "X-Live-Smith-Command-Id": "media-command-accepted",
      },
      body: jsonBody,
    });
    assert.equal(accepted.status, 200);

    assert.equal(
      await rawHttpStatus(origin, [
        `POST /command?token=${token} HTTP/1.1`,
        `Host: ${new URL(origin).host}`,
        "Connection: close",
        "Content-Type: application/json",
        "Content-Type: application/json; charset=utf-8",
        "X-Live-Smith-Command-Id: duplicate-media-command",
        `Content-Length: ${Buffer.byteLength(jsonBody)}`,
        "",
        jsonBody,
      ]),
      400,
    );
  } finally {
    await bridge.close();
  }
});

test("send, command, capability reads, and Skill mutations require caller-owned correlation IDs", async () => {
  const { bridge, calls } = await createContractBridge();
  const { origin, token } = bridgeAddress(bridge.url);

  try {
    const responses = await Promise.all([
      request(origin, `/send?token=${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "test", sessionId: "session-1" }),
      }),
      request(origin, `/command?token=${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: jsonBody,
      }),
      request(origin, `/session-model-capabilities?token=${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: capabilityReadBody,
      }),
      request(origin, `/skills?token=${token}`, {
        method: "POST",
        headers: { "Content-Type": "text/markdown; charset=utf-8" },
        body: skillBody,
      }),
      request(origin, `/skills/mix-review?token=${token}`, {
        method: "DELETE",
      }),
    ]);
    assert.deepEqual(
      responses.map((response) => response.status),
      [400, 400, 400, 400, 400],
    );
    assert.deepEqual(calls(), {
      commandCalls: 0,
      sendCalls: 0,
      skillDeleteCalls: 0,
      skillInstallCalls: 0,
    });
  } finally {
    await bridge.close();
  }
});

test("held capability reads allow Session navigation, state hydration, and sending without publishing command state", {
  timeout: 2_000,
}, async () => {
  let releaseRead!: () => void;
  let markStarted!: () => void;
  const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let current = { activeSessionId: "session-1" } as ChatDialogState;
  const commands: unknown[] = [];
  const sends: unknown[] = [];
  const bridge = await createChatBridge({
    buildState: async () => current,
    renderHtml: () => "<html></html>",
    handleCommand: async (input, _signal, context) => {
      commands.push({
        input,
        context: {
          commandId: context.commandId,
          progress: typeof context.progress,
        },
      });
      if (input.kind === "load_session_model_capabilities") {
        const captured = current;
        markStarted();
        await readGate;
        return captured;
      }
      assert.equal(input.kind, "select_session");
      current = { ...current, activeSessionId: "session-2" };
      return current;
    },
    handleSend: async (input) => { sends.push(input); },
  });
  const { origin, token } = bridgeAddress(bridge.url);
  const baseline = await (await request(origin, `/state?token=${token}`))
    .json() as ChatBridgeState;
  const events = await request(origin, `/events?token=${token}`);
  let readSettled = false;
  const capabilityRead = request(origin, `/session-model-capabilities?token=${token}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Live-Smith-Command-Id": "capability-read",
    },
    body: capabilityReadBody,
  }).then((response) => { readSettled = true; return response; });

  try {
    assert.equal(await Promise.race([
      started.then(() => "started"),
      capabilityRead.then((response) => response.status),
    ]), "started");
    const selected = await request(origin, `/command?token=${token}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Live-Smith-Command-Id": "parallel-navigation",
      },
      body: JSON.stringify({ kind: "select_session", sessionId: "session-2" }),
    });
    assert.equal(selected.status, 200);
    const selectedState = await selected.json() as ChatBridgeState;
    assert.equal(selectedState.activeSessionId, "session-2");
    const send = await request(origin, `/send?token=${token}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Live-Smith-Send-Id": "parallel-send",
      },
      body: JSON.stringify({ prompt: "Keep typing", sessionId: "session-2" }),
    });
    assert.equal(send.status, 200);
    const refreshed = await request(origin, `/state?token=${token}`);
    assert.equal(refreshed.status, 200);
    assert.equal((await refreshed.json() as ChatBridgeState).activeSessionId, "session-2");
    assert.equal(readSettled, false);

    releaseRead();
    const response = await capabilityRead;
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("X-Live-Smith-Command-Id"), "capability-read");
    const state = await response.json() as ChatBridgeState;
    assert.equal(state.activeSessionId, "session-1");
    assert.equal(state.bridgeStateCoveredThroughRevision, baseline.bridgeStateRevision);
    assert.ok(BigInt(state.bridgeStateRevision) > BigInt(selectedState.bridgeStateRevision));
    assert.deepEqual(commands, [
      {
        input: capabilityReadInput,
        context: { commandId: "capability-read", progress: "function" },
      },
      {
        input: { kind: "select_session", sessionId: "session-2" },
        context: { commandId: "parallel-navigation", progress: "function" },
      },
    ]);
    assert.deepEqual(sends, [{ prompt: "Keep typing", sessionId: "session-2" }]);
    await bridge.close();
    const publications = (await events.text()).split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)) as { commandId?: string });
    assert.ok(publications.some((entry) => entry.commandId === "parallel-navigation"));
    assert.equal(publications.some((entry) => entry.commandId === "capability-read"), false);
  } finally {
    releaseRead();
    await capabilityRead;
    await bridge.close();
  }
});

test("capability reads reject mutations, extra fields, oversized bodies, and invalid authentication or correlation", async () => {
  const { bridge, calls } = await createContractBridge();
  const { origin, token } = bridgeAddress(bridge.url);
  const headers = {
    "Content-Type": "application/json",
    "X-Live-Smith-Command-Id": "strict-capability-read",
  };
  const path = `/session-model-capabilities?token=${token}`;
  const events = await request(origin, `/events?token=${token}`);

  try {
    for (const body of [
      jsonBody,
      JSON.stringify({
        kind: "logout_oauth",
        profileId: "profile-oauth",
        provider: "openai",
      }),
      JSON.stringify({ kind: "select_session", sessionId: "session-2" }),
      JSON.stringify({ ...capabilityReadInput, settings: {} }),
      JSON.stringify({ ...capabilityReadInput, sessionId: 1 }),
      JSON.stringify({ ...capabilityReadInput, profileId: undefined }),
      "{",
      `${capabilityReadBody}${" ".repeat(1024 * 1024)}`,
    ]) {
      const response = await request(origin, path, { method: "POST", headers, body });
      assert.equal(response.status, 400);
      assert.equal(response.headers.get("X-Live-Smith-Command-Id"), "strict-capability-read");
    }
    for (const authPath of ["/session-model-capabilities", "/session-model-capabilities?token=incorrect"]) {
      const response = await request(origin, authPath, {
        method: "POST", headers, body: capabilityReadBody,
      });
      assert.equal(response.status, 403);
    }
    const invalidCorrelation = await request(origin, path, {
      method: "POST",
      headers: { ...headers, "X-Live-Smith-Command-Id": "invalid correlation" },
      body: capabilityReadBody,
    });
    assert.equal(invalidCorrelation.status, 400);
    assert.equal(await rawHttpStatus(origin, [
      `POST ${path} HTTP/1.1`,
      `Host: ${new URL(origin).host}`,
      "Connection: close",
      "Content-Type: application/json",
      "X-Live-Smith-Command-Id: first-capability-read",
      "X-Live-Smith-Command-Id: second-capability-read",
      `Content-Length: ${Buffer.byteLength(capabilityReadBody)}`,
      "",
      capabilityReadBody,
    ]), 400);
    assert.equal(calls().commandCalls, 0);
    await bridge.close();
    assert.equal(await events.text(), "\n", "Read failures must not become foreground command events.");
  } finally {
    await bridge.close();
  }
});

test("capability read disconnect cancels its handler while the bridge stays available", {
  timeout: 2_000,
}, async () => {
  let markStarted!: () => void;
  let markAborted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const aborted = new Promise<void>((resolve) => { markAborted = resolve; });
  const state = {} as ChatDialogState;
  let readSignal: AbortSignal | undefined;
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async (input, signal) => {
      if (input.kind !== "load_session_model_capabilities") return state;
      readSignal = signal;
      markStarted();
      await new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          markAborted();
          reject(signal.reason);
        }, { once: true });
      });
      return state;
    },
    handleSend: async () => {},
  });
  const { origin, token } = bridgeAddress(bridge.url);
  const controller = new AbortController();
  const capabilityRead = request(origin, `/session-model-capabilities?token=${token}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Live-Smith-Command-Id": "disconnected-capability-read",
    },
    body: capabilityReadBody,
    signal: controller.signal,
  }).then((response) => ({ response }), (error: unknown) => ({ error }));

  try {
    assert.equal(await Promise.race([
      started.then(() => "started"),
      capabilityRead.then(() => "settled"),
    ]), "started");
    controller.abort();
    await aborted;
    assert.equal(readSignal?.aborted, true);
    assert.ok("error" in await capabilityRead);
    const command = await request(origin, `/command?token=${token}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Live-Smith-Command-Id": "after-read-disconnect",
      },
      body: jsonBody,
    });
    assert.equal(command.status, 200);
  } finally {
    controller.abort();
    await capabilityRead;
    await bridge.close();
  }
});

test("closing aborts and awaits capability read cleanup and destroys its response", {
  timeout: 2_000,
}, async () => {
  let markStarted!: () => void;
  let markAborted!: () => void;
  let releaseCleanup!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const aborted = new Promise<void>((resolve) => { markAborted = resolve; });
  const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve; });
  const state = {} as ChatDialogState;
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async (_input, signal) => {
      markStarted();
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      markAborted();
      await cleanupGate;
      throw signal.reason;
    },
    handleSend: async () => {},
  });
  const { origin, token } = bridgeAddress(bridge.url);
  const capabilityRead = request(origin, `/session-model-capabilities?token=${token}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Live-Smith-Command-Id": "closing-capability-read",
    },
    body: capabilityReadBody,
  }).then((response) => ({ response }), (error: unknown) => ({ error }));
  let closing: Promise<void> | undefined;

  try {
    assert.equal(await Promise.race([
      started.then(() => "started"),
      capabilityRead.then(() => "settled"),
    ]), "started");
    let closeSettled = false;
    closing = bridge.close().then(() => { closeSettled = true; });
    await aborted;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(closeSettled, false);
    assert.ok("error" in await capabilityRead);
    releaseCleanup();
    await closing;
  } finally {
    releaseCleanup();
    await capabilityRead;
    await (closing ?? bridge.close());
  }
});

function rawHttpStatus(origin: string, lines: string[]): Promise<number> {
  const url = new URL(origin);
  return new Promise<number>((resolve, reject) => {
    const socket = connect(Number(url.port), url.hostname);
    let response = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(lines.join("\r\n")));
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.on("error", reject);
    socket.on("end", () => {
      const match = /^HTTP\/1\.1 (\d{3})/m.exec(response);
      if (!match) {
        reject(new Error(`Missing HTTP status in response: ${response}`));
        return;
      }
      resolve(Number(match[1]));
    });
  });
}
