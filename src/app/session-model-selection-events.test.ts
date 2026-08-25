import assert from "node:assert/strict";
import test from "node:test";

import {
  publishSessionModelSelectionChange,
  subscribeSessionModelSelectionChanges,
} from "./session-model-selection-events.js";

test("Session model selection notifications are storage-scoped and cloned", () => {
  const first: string[] = [];
  const second: string[] = [];
  const otherStorage: string[] = [];
  const unsubscribeFirst = subscribeSessionModelSelectionChanges(
    "/tmp/live-smith-model-selection-a",
    (change) => {
      first.push(JSON.stringify(change));
      change.modelSelection.model = "mutated-by-listener";
    },
  );
  const unsubscribeSecond = subscribeSessionModelSelectionChanges(
    "/tmp/live-smith-model-selection-a",
    (change) => second.push(JSON.stringify(change)),
  );
  const unsubscribeOther = subscribeSessionModelSelectionChanges(
    "/tmp/live-smith-model-selection-b",
    (change) => otherStorage.push(JSON.stringify(change)),
  );

  try {
    publishSessionModelSelectionChange(
      "/tmp/live-smith-model-selection-a",
      {
        sessionId: "session-a",
        updatedAt: "2026-08-25T00:00:00.000Z",
        modelSelection: {
          profileId: "profile-a",
          model: "model-a",
          reasoningEffort: "high",
        },
      },
    );
    const expected = JSON.stringify({
      sessionId: "session-a",
      updatedAt: "2026-08-25T00:00:00.000Z",
      modelSelection: {
        profileId: "profile-a",
        model: "model-a",
        reasoningEffort: "high",
      },
    });
    assert.deepEqual(first, [expected]);
    assert.deepEqual(second, [expected]);
    assert.deepEqual(otherStorage, []);

    unsubscribeFirst();
    unsubscribeSecond();
    publishSessionModelSelectionChange(
      "/tmp/live-smith-model-selection-a",
      {
        sessionId: "session-a",
        updatedAt: "2026-08-25T00:01:00.000Z",
        modelSelection: { profileId: "profile-a", model: "model-b" },
      },
    );
    assert.equal(first.length, 1);
    assert.equal(second.length, 1);
  } finally {
    unsubscribeFirst();
    unsubscribeSecond();
    unsubscribeOther();
  }
});
