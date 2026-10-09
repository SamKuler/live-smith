import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { handleAgentRequest } from "../../../src/app/agent-request.js";
import { buildModelRequest, runtimeProfileForSavedProfile } from "../../../src/app/model/model-request.js";
import { createGoogleAntigravityProtocol } from "../../../src/model/oauth/google-protocol.js";
import type { ModelContextUsage } from "../../../src/model/contracts.js";
import type { SavedProfile } from "../../../src/model/profile.js";
import { createSession } from "../../../src/storage/sessions.js";
import { loadSessionEvents } from "../../../src/storage/events.js";
import { agentRequestContext } from "./support/agent-context.js";
import { liveContextPresentationFixture } from "../context/support/live-context.test-harness.js";

for (const { mixedCalls, initialUsage } of [
  { mixedCalls: true, initialUsage: 85_000 },
  { mixedCalls: false, initialUsage: 85_000 },
  { mixedCalls: false, initialUsage: 75_000 },
]) {
  const needsCompaction = initialUsage === 85_000;
  test(`Google ${mixedCalls ? "mixed" : "search-only"} continuation ${needsCompaction ? "compacts new search text" : "does not double-count sampled search text"}`, async t => {
    const directory = await mkdtemp(join(tmpdir(), "live-smith-search-compaction-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const profile: SavedProfile = {
      id: "google", name: "Google", connection: { kind: "oauth-subscription", provider: "google" },
      defaultModel: "conversation-model",
      models: [{ model: "conversation-model", parameters: { reasoning: { mode: "default" }, contextWindowTokens: 100_000, autoCompactTokenLimit: 90_000 }, advanced: { hostedTools: { webSearch: true } } }],
    };
    const credential = { provider: "google" as const, accessToken: "fake", refreshToken: "fake", expiresAt: Date.now() + 60_000, projectId: "fake", accountLabel: null };
    const sourceText = "R".repeat(32_768);
    const applyCall = { functionCall: { id: "invalid-apply", name: "apply_live_actions", args: {} } };
    const response = (parts: unknown[], usage: number, grounded = false) => new Response(
      `data: ${JSON.stringify({ response: { candidates: [{ content: { parts }, finishReason: "STOP", ...(grounded ? { groundingMetadata: { webSearchQueries: ["Live manual"] } } : {}) }], usageMetadata: { totalTokenCount: usage } } })}\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    );
    let modelCalls = 0;
    let checkpoints = 0;
    let searches = 0;
    let finalContainsSearch = false;
    const accepted: Array<ModelContextUsage | undefined> = [];
    const protocol = createGoogleAntigravityProtocol({ fetchImpl: async (input, init) => {
      const body = JSON.parse(String(init?.body));
      if (String(input).endsWith(":fetchAvailableModels")) return new Response(JSON.stringify({ models: {}, webSearchModelIds: ["search-model"] }));
      if (body.requestType === "web_search") {
        searches++;
        return response([{ text: sourceText }], 8_192, true);
      }
      const checkpoint = JSON.stringify(body.request.contents).includes("CONTEXT CHECKPOINT COMPACTION");
      if (checkpoint) {
        checkpoints++;
        assert(JSON.stringify(body.request.contents).includes(sourceText));
        return response([{ text: "Search completed. Continue after the invalid Apply request." }], 94_000);
      }
      modelCalls++;
      if (modelCalls === 1) return response([
        { functionCall: { name: "live_smith_web_search", args: { query: "Live manual" } } },
        ...(mixedCalls ? [applyCall] : []),
      ], initialUsage);
      if (!mixedCalls && modelCalls === 2) return response([applyCall], 88_000);
      finalContainsSearch = JSON.stringify(body.request.contents).includes(sourceText);
      return response([{ text: "Finished." }], 1_000);
    } });
    const scope = { kind: "track" as const, identity: "track-1", label: "Bass" };
    const session = await createSession(directory, { title: "Search", projectKey: "project-1", scope });
    const result = await handleAgentRequest(
      agentRequestContext({ environment: { storageDirectory: directory } } as never), directory,
      { presentation: liveContextPresentationFixture("Bass"), summary: "Track: Bass", target: {}, scope },
      "Look up the manual and inspect the track", runtimeProfileForSavedProfile(profile), "project-1", session.id,
      { signal: new AbortController().signal, onDelta() {}, onProgress() {}, onSessionEvent() {}, onModelTurnAccepted: usage => { accepted.push(usage); }, confirmActions: async () => true },
      input => protocol.createToolTurn(buildModelRequest(input), credential),
    );
    assert.equal(result, "Finished.");
    assert.equal(checkpoints, needsCompaction ? 1 : 0);
    assert.equal(finalContainsSearch, !needsCompaction);
    assert.equal(searches, 1);
    assert.deepEqual(accepted[0], { usedTokens: initialUsage, contextWindowTokens: 100_000 });
    const events = await loadSessionEvents(directory, session.id);
    assert.equal(events.filter(event => event.kind === "compaction").length, needsCompaction ? 1 : 0);
  });
}
