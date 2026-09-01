import assert from "node:assert/strict";
import test from "node:test";

import { parseCommandInput } from "./chat-bridge-http.js";

test("compact_session accepts one bounded optional instruction string", () => {
  assert.deepEqual(parseCommandInput({
    kind: "compact_session",
    sessionId: "session-compact",
  }), {
    kind: "compact_session",
    sessionId: "session-compact",
  });
  assert.deepEqual(parseCommandInput({
    kind: "compact_session",
    sessionId: "session-compact",
    instructions: "  preserve exact track names  ",
  }), {
    kind: "compact_session",
    sessionId: "session-compact",
    instructions: "preserve exact track names",
  });
  assert.deepEqual(parseCommandInput({
    kind: "compact_session",
    sessionId: "session-compact",
    instructions: "   ",
  }), {
    kind: "compact_session",
    sessionId: "session-compact",
  });
});

test("compact_session rejects malformed or oversized command bodies", () => {
  for (const input of [
    { kind: "compact_session" },
    { kind: "compact_session", sessionId: "session-compact", instructions: 1 },
    {
      kind: "compact_session",
      sessionId: "session-compact",
      instructions: "a".repeat(16 * 1024 + 1),
    },
    { kind: "compact_session", sessionId: "session-compact", extra: true },
  ]) {
    assert.throws(() => parseCommandInput(input));
  }
});
