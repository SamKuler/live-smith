import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { handleAgentRequest } from "../../../src/app/agent-request.js";
import { runtimeProfileForSavedProfile } from "../../../src/app/model/model-request.js";
import { proposeCreativeBrief } from "../../../src/app/context/creative-brief.js";
import { MAX_CREATIVE_BRIEF_CODE_POINTS } from "../../../src/agent/creative-brief.js";
import { createSession, listSessions } from "../../../src/storage/sessions.js";
import { loadSessionEvents } from "../../../src/storage/events.js";
import { liveContextPresentationFixture } from "../context/support/live-context.test-harness.js";

test("a model proposal persists only as tool activity; all later turns retain the human-saved brief", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-brief-agent-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const scope = { kind: "track" as const, identity: "bass", label: "Bass" };
  const session = await createSession(directory, { title: "Brief", projectKey: "set", scope, creativeBrief: "Keep original bass" });
  const runtime = runtimeProfileForSavedProfile({ id: "test-profile", name: "Test",
    connection: { kind: "direct-api", apiFamily: "openai", apiMode: "responses", baseUrl: "https://example.test/v1", apiKey: "test" },
    defaultModel: "gpt-5.4", models: [{ model: "gpt-5.4", parameters: { maxOutputTokens: 4096, reasoning: { mode: "default" } }, advanced: {} }],
  });
  let calls = 0;
  await handleAgentRequest({ environment: { storageDirectory: directory } } as never, directory,
    { presentation: liveContextPresentationFixture("Bass"), summary: "Bass: tempo 123, meter 7/8", target: {}, scope },
    "Suggest a brief for an extended bridge", runtime, "set", session.id,
    { signal: new AbortController().signal, onDelta: () => {}, onProgress: () => {}, onSessionEvent: () => {}, confirmActions: async () => { throw new Error("No Live writes expected"); } },
    async (input) => {
      calls++;
      assert.equal(input.creativeBrief, "Keep original bass");
      assert.ok(input.tools.some((tool) => tool.type === "function" && tool.function.name === "propose_creative_brief"));
      return calls === 1 ? { content: "Proposed direction", toolCalls: [{ id: "brief-call", name: "propose_creative_brief", arguments: JSON.stringify({ creativeBrief: "Keep original bass; bridge with half-time drums" }) }] }
        : { content: "Review the suggestion in Creative brief.", toolCalls: [] };
    });
  assert.equal(calls, 2);
  assert.equal((await listSessions(directory))[0]?.creativeBrief, "Keep original bass");
  const event = (await loadSessionEvents(directory, session.id)).find((entry) => entry.kind === "tool_result" && entry.name === "propose_creative_brief");
  assert.ok(event);
  assert.deepEqual(JSON.parse(event.content), { creativeBrief: "Keep original bass; bridge with half-time drums", expectedCreativeBrief: "Keep original bass", saved: false });
});

test("proposal parser rejects malformed arguments and over-limit text without a save callback", () => {
  for (const input of ["not json", "[]", "null", JSON.stringify({ creativeBrief: 1 }),
    JSON.stringify({ creativeBrief: "x".repeat(MAX_CREATIVE_BRIEF_CODE_POINTS + 1) }),
    JSON.stringify({ creativeBrief: "valid", expectedCreativeBrief: "forged base" })]) {
    assert.equal(proposeCreativeBrief(input, "Saved").failed, true);
  }
});
