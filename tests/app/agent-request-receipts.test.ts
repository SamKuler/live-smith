import assert from "node:assert/strict";
import test from "node:test";

import { waitForCondition } from "../ui/support/chat-dialog.test-harness.js";
import { requestReceiptHarness } from "./support/agent-request-receipt-test-helpers.js";

const prompt = "Preserve this exact request once.";

for (const scenario of ["audio-stop", "commit-stop", "corrupt-audio"] as const) {
  test(`${scenario} retains the durable user receipt through bridge and dialog recovery`, { timeout: 15_000 }, async (t) => {
    const h = await requestReceiptHarness(t, scenario);
    h.ui.input("#prompt", prompt);
    h.ui.click("#sendButton");
    if (scenario !== "corrupt-audio") {
      await h.boundary.promise;
      assert.equal((await h.events()).filter((event) => event.kind === "user").length, 1);
      if (scenario === "commit-stop") assert.equal(h.published.length, 0, "the append has not returned a receipt yet");
      h.ui.click("#sendButton");
      await waitForCondition(() => h.responses.some((response) => response.path === "/stop"), "Stop must reach the actual bridge");
      assert.equal(h.responses.find((response) => response.path === "/stop")!.body.terminal, false);
      h.release.resolve();
    }
    await h.sendFinished.promise;
    await waitForCondition(() => h.ui.document.querySelector("#sendButton")?.textContent === "Send", "the dialog must finish receipt reconciliation");
    await h.ui.settle();
    const response = h.responses.find((entry) => entry.path === "/send")!;
    assert.equal(response.status, 500);
    assert.equal(response.body.promptPersistence, "persisted");
    assert.equal(response.body.state!.events.filter((event) => event.kind === "user").length, 1);
    const users = (await h.events()).filter((event) => event.kind === "user");
    assert.equal(users.length, 1);
    assert.equal(users[0]!.content, prompt);
    assert.deepEqual(h.published.filter((event) => event.kind === "user").map((event) => event.id), [users[0]!.id]);
    if (scenario !== "corrupt-audio") {
      const terminal = await h.terminalStop();
      assert.equal(terminal.terminal, true);
      assert.equal(terminal.promptPersistence, "persisted");
    }
    assert.equal(h.ui.document.querySelector<HTMLTextAreaElement>("#prompt")!.value, "", "do not restore an already-saved prompt for retry");
    assert.equal(h.ui.document.querySelectorAll(".timeline-item.user").length, 1);
    assert.equal(h.ui.document.querySelector(".local-user-message"), null);
    assert.equal(h.requests.filter((request) => request.path === "/send").length, 1, "reconciliation must not resend the prompt");
    assert.equal(h.calls.appends, 1);
    assert.equal(h.calls.model, 0);
    assert.deepEqual(h.ui.errors, []);
  });
}

for (const scenario of ["reject-commit", "unknown-visible", "unknown-absent"] as const) {
  test(`${scenario} never publishes a successful user receipt`, { timeout: 15_000 }, async (t) => {
    const h = await requestReceiptHarness(t, scenario);
    h.ui.input("#prompt", prompt);
    h.ui.click("#sendButton");
    await h.sendFinished.promise;
    await waitForCondition(() => h.ui.document.querySelector("#sendButton")?.textContent === "Send", "the dialog must finish failed-commit reconciliation");
    await h.ui.settle();
    const response = h.responses.find((entry) => entry.path === "/send")!;
    const knownFailure = scenario === "reject-commit";
    assert.equal(response.body.promptPersistence, knownFailure ? "not_persisted" : "unknown");
    assert.equal(h.published.length, 0);
    assert.equal((await h.events()).filter((event) => event.kind === "user").length, scenario === "unknown-visible" ? 1 : 0);
    assert.equal(h.calls.invalidations, knownFailure ? 0 : 1);
    assert.equal(h.calls.appends, 1);
    assert.equal(h.calls.model, 0);
    assert.equal(h.ui.document.querySelector<HTMLTextAreaElement>("#prompt")!.value, knownFailure ? prompt : "");
    assert.equal(h.requests.filter((request) => request.path === "/send").length, 1);
    assert.deepEqual(h.ui.errors, []);
  });
}

test("successful initialization publishes the committed user event exactly once", { timeout: 15_000 }, async (t) => {
  const h = await requestReceiptHarness(t, "success");
  h.ui.input("#prompt", prompt);
  h.ui.click("#sendButton");
  await h.sendFinished.promise;
  await h.ui.settle();
  assert.equal(h.responses.find((entry) => entry.path === "/send")!.status, 200);
  const users = (await h.events()).filter((event) => event.kind === "user");
  assert.equal(users.length, 1);
  assert.deepEqual(h.published.filter((event) => event.kind === "user").map((event) => event.id), [users[0]!.id]);
  assert.equal(h.calls.appends, 1);
  assert.equal(h.calls.model, 1);
  assert.deepEqual(h.ui.errors, []);
});
