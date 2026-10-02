import assert from "node:assert/strict";

import type { ModelConversationMessage } from "../../../src/model/contracts.js";

export function modelMessageText(message: ModelConversationMessage | undefined): string {
  assert.ok(message && typeof message.content === "string", "Expected a text model message.");
  return message.content;
}
