import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { connect } from "node:net";
import test from "node:test";

import type { ChatDialogState } from "../ui/chat-state.js";
import { createChatBridge } from "./chat-bridge.js";

const jsonBody = JSON.stringify({ kind: "new_session" });
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

test("send, command, and Skill mutations require caller-owned correlation IDs", async () => {
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
      [400, 400, 400, 400],
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
