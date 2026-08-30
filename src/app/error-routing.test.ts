import assert from "node:assert/strict";
import test from "node:test";

import { NetworkProxyError } from "../runtime/network-proxy-error.js";
import {
  sessionErrorMessage,
  shouldOpenSettingsForAgentError,
} from "./error-routing.js";

test("shouldOpenSettingsForAgentError identifies profile configuration errors", () => {
  assert.equal(
    shouldOpenSettingsForAgentError(new Error("No saved model profile is active.")),
    true,
  );
  assert.equal(
    shouldOpenSettingsForAgentError(
      new Error("Sign in with ChatGPT before sending with this Profile."),
    ),
    true,
  );
  assert.equal(
    shouldOpenSettingsForAgentError(
      new Error("OAuth token refresh failed."),
    ),
    true,
  );
  assert.equal(
    shouldOpenSettingsForAgentError(
      new NetworkProxyError("A safe network route diagnosis."),
    ),
    true,
  );
  assert.equal(
    shouldOpenSettingsForAgentError(
      new Error(
        "The Manual proxy could not be reached. Start the proxy app, check the proxy URL, or choose No proxy.",
      ),
    ),
    true,
  );
});

test("sessionErrorMessage removes provider credentials before persistence", () => {
  assert.equal(
    sessionErrorMessage(
      new Error("Bearer token-value failed with sk-test-secret and custom-key"),
      ["custom-key"],
    ),
    "Bearer [redacted] failed with [redacted] and [redacted]",
  );
});

test("shouldOpenSettingsForAgentError ignores Live action errors", () => {
  assert.equal(
    shouldOpenSettingsForAgentError(
      new Error('Could not find parameter "Oscillator B On" on device "Operator".'),
    ),
    false,
  );
});
