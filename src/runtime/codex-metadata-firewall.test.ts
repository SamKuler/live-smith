import assert from "node:assert/strict";
import test from "node:test";

import { createHostAbortController } from "./host.js";
import { startCodexMetadataFirewall } from "./codex-metadata-firewall.js";

test("startup abort closes the pending firewall listener before rejecting", {
  timeout: 1_000,
}, async () => {
  const controller = createHostAbortController();
  const reason = new Error("final managed owner closed");
  const startup = startCodexMetadataFirewall(controller.signal);

  controller.abort(reason);

  await assert.rejects(startup, (error: unknown) => error === reason);
  const replacement = await startCodexMetadataFirewall();
  await replacement.close();
});
