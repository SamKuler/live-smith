import assert from "node:assert/strict";
import test from "node:test";
import { parseCommandInput, parseSendInput } from "../../../../src/app/chat/chat-bridge-http.js";
import { MAX_CREATIVE_BRIEF_CODE_POINTS } from "../../../../src/agent/creative-brief.js";

test("creative brief commands require bounded new and expected texts, without extending Send", () => {
  const command = { kind: "set_session_creative_brief", sessionId: "session-brief", creativeBrief: "Keep bass", expectedCreativeBrief: "" };
  assert.deepEqual(parseCommandInput(command), command);
  for (const update of [ { expectedCreativeBrief: undefined }, { creativeBrief: 1 },
    { creativeBrief: "x".repeat(MAX_CREATIVE_BRIEF_CODE_POINTS + 1) },
    { expectedCreativeBrief: "x".repeat(MAX_CREATIVE_BRIEF_CODE_POINTS + 1) },
    { profile: {} }, { apiKey: "never" } ]) {
    assert.throws(() => parseCommandInput({ ...command, ...update }));
  }
  assert.throws(() => parseSendInput({ prompt: "hello", sessionId: "session-brief", creativeBrief: "No implicit writes" }));
});
