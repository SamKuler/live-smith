import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { URL } from "node:url";
import test from "node:test";
import { runAgentFlow } from "../../../src/app/agent-flow.js";
import type { LiveInteractionContext } from "../../../src/live/context.js";
import type { ChatDialogState } from "../../../src/ui/chat-state.js";
import { saveGlobalSettings } from "../../../src/storage/settings.js";
import { createRequestPluginTools } from "../../../src/app/plugins/request-plugin-tools.js";
import { liveContextPresentationFixture } from "../context/support/live-context.test-harness.js";
import { oauthServer } from "../plugins/support/mcp-oauth-server.js";

test("the chat bridge owns explicit MCP sign-in/out, isolates credentials, and closes admitted clients", async (t) => {
  const storageDirectory = await fs.mkdtemp("/private/tmp/live-smith-mcp-oauth-flow-");
  t.after(() => fs.rm(storageDirectory, { recursive: true, force: true }));
  const server = await oauthServer(t);
  await saveGlobalSettings(storageDirectory, { integrationConnections: { action: "upsert", expectedRevision: "0", connection: {
    id: "account", name: "Workspace", enabled: true, mcp: { type: "streamable-http", url: `${server.origin}/mcp` }, oauth: {}, secrets: {}, artifactInputApproved: false, artifactOutputApproved: false,
  } } });
  const interaction: LiveInteractionContext = {
    presentation: liveContextPresentationFixture("Lead"), summary: "Track: Lead", target: {},
    scope: { kind: "track", identity: "track-1", label: "Lead" },
  };
  interaction.selectionContext = { refresh: () => interaction };
  let opened = 0;
  await runAgentFlow({ application: { song: { handle: { id: 1n } } }, environment: { storageDirectory },
    ui: { showModalDialog: async (url: string) => {
      let sequence = 0;
      const endpoint = new URL(url);
      const command = async (body: unknown, expected = 200) => {
        endpoint.pathname = "/command";
        const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json",
          "X-Live-Smith-Command-Id": `mcp-oauth-${++sequence}` }, body: JSON.stringify(body) });
        const text = await response.text();
        assert.equal(response.status, expected, text);
        assert.doesNotMatch(text, /private-access|private-refresh|client-1|code_verifier/u);
        return JSON.parse(text) as ChatDialogState;
      };
      endpoint.pathname = "/state";
      const initial = await fetch(endpoint).then((response) => response.json()) as ChatDialogState;
      assert.equal(initial.mcpOAuthStates?.[0]?.status, "signed-out");
      assert.equal(server.requests.length, 0);
      await command({ kind: "start_mcp_oauth", connectionId: "account", url: "https://untrusted.example" }, 400);
      assert.equal(opened, 0);
      const signedIn = await command({ kind: "start_mcp_oauth", connectionId: "account" });
      assert.equal(opened, 1);
      assert.equal(signedIn.mcpOAuthStates?.[0]?.status, "signed-in");
      const active = await createRequestPluginTools({ storageDirectory, sessionId: signedIn.activeSessionId!, signal: new AbortController().signal, withAuthorization: async (_signal, operation) => operation() });
      assert.equal(active.issues.length, 0);
      assert.equal(active.catalogTools().length, 1);
      const signedOut = await command({ kind: "logout_mcp_oauth", connectionId: "account" });
      assert.equal(signedOut.mcpOAuthStates?.[0]?.status, "signed-out");
      const count = server.requests.length;
      const result = await active.callTool({ id: "after-logout", name: active.tools()[0]!.function.name, arguments: JSON.stringify({ text: "music" }) });
      assert.equal(result.failed, true);
      assert.equal(server.requests.length, count);
      await active.close();
    } },
  } as never, interaction, { renderHtml: () => "<html></html>", openMcpOAuthBrowser: async (url) => { opened += 1; await server.authorize(url); } });
});
