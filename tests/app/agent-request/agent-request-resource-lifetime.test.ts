import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execPath, kill } from "node:process";
import { URL } from "node:url";
import test from "node:test";
import { handleAgentRequest } from "../../../src/app/agent-request.js";
import { runtimeProfileForSavedProfile } from "../../../src/app/model/model-request.js";
import { closeActiveMcpConnection } from "../../../src/app/plugins/request-plugin-tools.js";
import { createSession } from "../../../src/storage/sessions.js";
import { saveGlobalSettings } from "../../../src/storage/settings.js";
import { agentRequestContext } from "./support/agent-context.js";
import { liveContextPresentationFixture } from "../context/support/live-context.test-harness.js";

test("request initialization closes an admitted MCP process when the Session title cannot be saved", async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "request-init-lifetime-"));
  const rename = fs.rename;
  try {
    const server = join(directory, "server.mjs");
    const pidFile = join(directory, "server.pid");
    const fixture = await fs.readFile(new URL("../../../test-fixtures/plugins/portable-skill-mcp/server.mjs", import.meta.url), "utf8");
    await fs.writeFile(server, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n${fixture}`);
    const scope = { kind: "track" as const, identity: "bass", label: "Bass" };
    const session = await createSession(directory, { title: "", projectKey: "set", scope });
    await saveGlobalSettings(directory, { integrationConnections: {
      action: "upsert", expectedRevision: "0", connection: { id: "fixture-mcp", name: "Fixture", enabled: true,
        mcp: { type: "stdio", command: execPath, args: [server] }, secrets: {},
        artifactInputApproved: false, artifactOutputApproved: false },
    } });
    const runtime = runtimeProfileForSavedProfile({ id: "fixture", name: "Fixture",
      connection: { kind: "direct-api", apiFamily: "openai", apiMode: "responses", baseUrl: "https://example.test/v1", apiKey: "test" },
      defaultModel: "gpt-5.4", models: [{ model: "gpt-5.4", parameters: { maxOutputTokens: 4096, reasoning: { mode: "default" } }, advanced: {} }],
    });
    fs.rename = async (source, target) => {
      if (String(target) === join(directory, "live-smith-sessions.json")) {
        throw Object.assign(new Error("Session title write unavailable"), { code: "EIO" });
      }
      return rename(source, target);
    };
    syncBuiltinESMExports();
    let modelCalls = 0;
    await assert.rejects(handleAgentRequest(
      agentRequestContext({ environment: { storageDirectory: directory } } as never), directory,
      { presentation: liveContextPresentationFixture("Bass"), summary: "Bass", target: {}, scope },
      "Inspect", runtime, "set", session.id,
      { signal: new AbortController().signal, onDelta: () => {}, onProgress: () => {}, onSessionEvent: () => {}, confirmActions: async () => false },
      async () => { modelCalls++; return { content: "Done", toolCalls: [] }; },
    ), /Session title write unavailable/);
    assert.equal(modelCalls, 0);
    const pid = Number(await fs.readFile(pidFile, "utf8"));
    assert.throws(() => kill(pid, 0), { code: "ESRCH" }, "The real child process must be gone before failure returns");
  } finally {
    fs.rename = rename;
    syncBuiltinESMExports();
    await closeActiveMcpConnection(directory, "fixture-mcp");
    await fs.rm(directory, { recursive: true, force: true });
  }
});
