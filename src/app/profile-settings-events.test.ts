import assert from "node:assert/strict";
import test from "node:test";

import {
  publishProfileSettingsChange,
  subscribeProfileSettingsChanges,
} from "./profile-settings-events.js";

test("Profile settings changes stay storage-scoped and isolate listener failures", () => {
  const received: string[] = [];
  const unsubscribeThrowing = subscribeProfileSettingsChanges(
    "/profile-events-a",
    () => {
      throw new Error("listener failed");
    },
  );
  const unsubscribeFirst = subscribeProfileSettingsChanges(
    "/profile-events-a",
    (change) => received.push(change.commandId),
  );
  const unsubscribeOther = subscribeProfileSettingsChanges(
    "/profile-events-b",
    (change) => received.push(`other:${change.commandId}`),
  );

  publishProfileSettingsChange("/profile-events-a", { commandId: "save-a" });
  assert.deepEqual(received, ["save-a"]);

  unsubscribeThrowing();
  unsubscribeFirst();
  publishProfileSettingsChange("/profile-events-a", { commandId: "ignored" });
  publishProfileSettingsChange("/profile-events-b", { commandId: "save-b" });
  assert.deepEqual(received, ["save-a", "other:save-b"]);
  unsubscribeOther();
});
