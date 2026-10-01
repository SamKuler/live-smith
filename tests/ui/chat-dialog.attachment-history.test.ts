import assert from "node:assert/strict";
import test from "node:test";
import { createDialogHarness, pendingDocument, stateFixture } from "./support/chat-dialog.test-harness.js";

const legacy = [
  ["doc", "application/msword"],
  ["xls", "application/vnd.ms-excel"],
  ["ppt", "application/vnd.ms-powerpoint"],
] as const;

test("historical Office references render without restoring ingestion formats", async () => {
  const state = stateFixture();
  state.events = [{ id: "old-reference", kind: "user", createdAt: "2026-09-30T00:00:00.000Z",
    content: "Reference material", attachments: legacy.map(([extension, mediaType]) =>
      pendingDocument(`historical-${extension}`, `old.${extension}`, mediaType)) }];
  const harness = await createDialogHarness(state);
  try {
    assert.equal(harness.document.querySelectorAll(".timeline-attachment-chip").length, 3);
    assert.doesNotMatch(harness.document.querySelector("#status")?.textContent ?? "", /invalid initial state/i);
    for (const [extension] of legacy) {
      assert.match(harness.document.querySelector("#timeline")?.textContent ?? "", new RegExp(`old\\.${extension}`));
    }
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("pending historical Office references remain removable after state updates", async () => {
  const state = stateFixture();
  state.pendingAttachments = legacy.map(([extension, mediaType]) =>
    pendingDocument(`pending-${extension}`, `old.${extension}`, mediaType));
  const harness = await createDialogHarness(state);
  try {
    assert.equal(harness.document.querySelectorAll("#pendingAttachments .attachment-remove").length, 3);
    for (const [extension] of legacy) {
      harness.click(`[data-attachment-id="pending-${extension}"] .attachment-remove`);
      await harness.settleAttachmentOperation();
      assert.equal(harness.document.querySelector(`[data-attachment-id="pending-${extension}"]`), null);
    }
    assert.equal(harness.document.querySelectorAll("#pendingAttachments .attachment-remove").length, 0);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});
