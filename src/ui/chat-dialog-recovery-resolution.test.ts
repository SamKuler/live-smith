import assert from "node:assert/strict";
import test from "node:test";

import { createDialogHarness } from "./chat-dialog.test-harness.js";

test("recovery resolution confirmation uses explicit non-Apply language", async (t) => {
  const harness = await createDialogHarness();
  t.after(() => harness.close());
  harness.holdNextSend();
  harness.input("#prompt", "Review unfinished work");
  harness.click("#sendButton");
  await Promise.resolve();
  const sendId = harness.sendIds[0];
  assert.ok(sendId);
  harness.emitServerEvent({
    type: "confirm_request",
    kind: "resolve_recovery",
    sendId,
    sessionId: "session-1",
    id: "confirm-recovery-resolution",
    message:
      "Keep the Live changes already completed and close this unfinished operation? Any unfinished steps will be abandoned. This does not undo anything and does not perform a Live mutation.",
    groups: [],
  });

  const card = harness.document.querySelector<HTMLElement>(".confirm-card");
  assert.equal(
    card?.querySelector(".confirm-title")?.textContent,
    "Close this unfinished operation?",
  );
  assert.match(card?.textContent ?? "", /unfinished steps will be abandoned/i);
  assert.match(card?.textContent ?? "", /does not undo anything/i);
  assert.equal(
    card?.querySelector<HTMLButtonElement>("[data-confirm-cancel]")?.textContent,
    "Keep unfinished",
  );
  assert.equal(
    card?.querySelector<HTMLButtonElement>(".primary")?.textContent,
    "Keep changes and close",
  );
  assert.equal(
    [...card?.querySelectorAll("button") ?? []].some(
      (button) => button.textContent === "Apply",
    ),
    false,
  );

  harness.emitRawServerEvent({
    type: "confirm_resolved",
    sendId,
    sessionId: "session-1",
    id: "confirm-recovery-resolution",
    confirmationGeneration: 1,
    activity: {
      status: "running",
      message: "Continuing after cancellation",
    },
    bridgeStateRevision: "999999",
  });
  assert.equal(
    harness.document.querySelector<HTMLElement>(".confirm-card")?.hidden,
    false,
  );

  harness.clickButton("Keep unfinished");
  await harness.settle();
  harness.releaseHeldSend();
  await harness.settle();
  assert.deepEqual(harness.errors, []);
});

test("confirmed recovery closure accepts only its recovery activity", async (t) => {
  const harness = await createDialogHarness();
  t.after(() => harness.close());
  harness.holdNextSend();
  harness.input("#prompt", "Close recovered work");
  harness.click("#sendButton");
  await Promise.resolve();
  const sendId = harness.sendIds[0];
  assert.ok(sendId);
  harness.emitServerEvent({
    type: "confirm_request",
    kind: "resolve_recovery",
    sendId,
    sessionId: "session-1",
    id: "confirm-recovery-close",
    message:
      "Keep the Live changes already completed and close this unfinished operation? Any unfinished steps will be abandoned. This does not undo anything and does not perform a Live mutation.",
    groups: [],
  });

  harness.clickButton("Keep changes and close");
  await harness.settle();
  assert.equal(
    harness.document.querySelector<HTMLElement>(".confirm-card")?.hidden ?? true,
    true,
  );
  assert.doesNotMatch(
    harness.document.querySelector("#status")?.textContent ?? "",
    /could not contain its authoritative activity|stopping/i,
  );
  harness.releaseHeldSend();
  await harness.settle();
  assert.deepEqual(harness.errors, []);
});
