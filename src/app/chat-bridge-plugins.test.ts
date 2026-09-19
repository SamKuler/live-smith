import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import { URL } from "node:url";

import type { ChatDialogState } from "../ui/chat-state.js";
import { createChatBridge } from "./chat-bridge.js";

function requestBody(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

test("Plugin inspect and install routes keep raw ZIP bytes out of JSON state", async () => {
  const state = { plugins: [] } as unknown as ChatDialogState;
  const archive = Buffer.from("fixture-plugin-zip");
  const inspections: Uint8Array[] = [];
  const installs: Array<{ replace: boolean; bytes: Uint8Array }> = [];
  const preview = {
    id: "fixture-plugin",
    version: "1.0.0",
    description: "Fixture",
    sourceFormat: "agent-plugins-1.0" as const,
    enabled: false,
    skillCount: 0,
    mcpServers: [],
    unsupportedComponents: [],
    issues: [],
    sha256: "a".repeat(64),
    byteLength: archive.byteLength,
  };
  const bridge = await createChatBridge({
    buildState: async () => state,
    renderHtml: () => "<html></html>",
    handleCommand: async () => state,
    handleSend: async () => undefined,
    handlePluginInspect: async ({ bytes }) => {
      inspections.push(Uint8Array.from(bytes));
      return { preview };
    },
    handlePluginInstall: async (input) => {
      installs.push({ replace: input.replace, bytes: Uint8Array.from(input.bytes) });
      return {
        state,
        receipt: { id: preview.id, sha256: preview.sha256 },
      };
    },
  });
  const chatUrl = new URL(bridge.url);
  const token = chatUrl.searchParams.get("token");
  try {
    const inspection = await fetch(
      `${chatUrl.origin}/plugins/inspect?token=${token}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/zip" },
        body: requestBody(archive),
      },
    );
    assert.equal(inspection.status, 200);
    assert.deepEqual(await inspection.json(), { preview });
    assert.deepEqual(inspections, [new Uint8Array(archive)]);
    assert.equal(installs.length, 0);

    const install = await fetch(
      `${chatUrl.origin}/plugins?token=${token}&replace=true`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Live-Smith-Command-Id": "plugin-install-1",
        },
        body: requestBody(archive),
      },
    );
    assert.equal(install.status, 201);
    assert.equal(install.headers.get("x-live-smith-command-id"), "plugin-install-1");
    const body = await install.json() as {
      state: ChatDialogState;
      receipt: { id: string; sha256: string };
    };
    assert.deepEqual(body.receipt, { id: preview.id, sha256: preview.sha256 });
    assert.deepEqual(body.state.plugins, []);
    assert.deepEqual(installs, [{ replace: true, bytes: new Uint8Array(archive) }]);

    const rejected = await fetch(
      `${chatUrl.origin}/plugins/inspect?token=${token}&extra=1`,
      {
        method: "POST",
        headers: { "Content-Type": "application/zip" },
        body: requestBody(archive),
      },
    );
    assert.equal(rejected.status, 400);
    assert.equal(inspections.length, 1);
  } finally {
    await bridge.close();
  }
});
