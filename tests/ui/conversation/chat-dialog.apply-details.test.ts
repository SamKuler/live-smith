import assert from "node:assert/strict";
import test from "node:test";
import type { ChatSessionEvent } from "../../../src/ui/chat-state.js";
import type { AgentPlan } from "../../../src/agent/actions.js";
import { actionDiffGroups } from "../../../src/ui/action-diff.js";
import { createDialogHarness, jsonCalls, stateFixture, waitForCondition } from "../support/chat-dialog.test-harness.js";

const actions = Array.from({ length: 33 }, (_, index) => `Set track ${index + 1} volume to 0.5.`);
const planText = `Balance tracks\n\nActions:\n${actions.map((action, index) => `${index + 1}. ${action}`).join("\n")}`;
const resultText = `Applied:\n${actions.map((action) => `- ${action}`).join("\n")}`;
function event(id: string, kind: ChatSessionEvent["kind"], content: string, status?: "proposed" | "approved" | "applied"): ChatSessionEvent {
  return { id, kind, content, createdAt: "2026-10-16T00:00:00Z",
    ...(status ? { applyOperation: { id: "batch-operation", status } } : {}) };
}

const orderedPlan: AgentPlan = { message: "Build the lead", targets: { bus: { trackName: "Bus" } }, actions: [
  { type: "create_midi_track", ref: "lead", name: "Lead" },
  { type: "set_tempo", tempo: 128 },
  { type: "insert_device", trackRef: "lead", deviceName: "Operator", index: 0 },
  { type: "create_midi_clip", trackRef: "lead", startBeat: 0, durationBeats: 8, name: "Melody",
    notes: Array.from({ length: 604 }, (_, index) => ({ pitch: 48 + index % 24, startTime: index / 604 * 7, duration: 0.1, velocity: 96 })) },
  { type: "set_device_parameters", trackRef: "bus", deviceName: "Auto Filter", deviceIndex: 0,
    values: Array.from({ length: 70 }, (_, index) => ({ parameterIndex: index, parameterName: `Parameter ${index}`, value: 0.7 })) },
] };

test("direct command approval uses the same ordered compact action disclosures and preserves its decision payload", async () => {
  const h = await createDialogHarness(stateFixture());
  const command = { id: "direct-apply", sessionId: "session-1", stopping: false };
  const request = { type: "command_confirm_request", commandId: command.id, sessionId: command.sessionId,
    id: "direct-confirm", kind: "apply", operationId: "direct-operation", message: orderedPlan.message,
    groups: actionDiffGroups(orderedPlan.actions, orderedPlan.targets), plan: orderedPlan };
  try {
    h.emitServerEvent({ type: "command_activity", command, bridgeStateRevision: "100" }); await h.settle();
    h.emitServerEvent({ ...request, plan: { ...orderedPlan, actions: [] } }); await h.settle();
    assert.equal(h.document.querySelector<HTMLElement>("#appConfirmation")!.hidden, true);
    h.emitServerEvent(request); await h.settle();
    assert.equal(h.document.querySelector<HTMLElement>("#appConfirmation")!.hidden, true);
    const review = h.document.querySelector<HTMLElement>('#timeline [data-operation-id="direct-operation"]')!;
    assert.ok(review); assert.equal(review.getAttribute("role"), "alertdialog");
    assert.equal(h.document.querySelector<HTMLElement>("#inspectorPane")!.hidden, true);
    const rows = [...review.querySelectorAll<HTMLDetailsElement>("details[data-action-index]")];
    assert.equal(rows.length, orderedPlan.actions.length);
    for (const [index, row] of rows.entries()) {
      assert.equal(row.open, false);
      row.querySelector<HTMLElement>("summary")!.click();
      assert.deepEqual(JSON.parse(row.querySelector("pre")!.textContent!), orderedPlan.actions[index]);
    }
    assert.match(rows[4]!.querySelector("summary")!.textContent!, /Set parameters.*Bus.*Auto Filter.*70/);
    assert.doesNotMatch(rows[4]!.querySelector("summary")!.textContent!, /Parameter 0|0\.7/);
    assert.match(rows[2]!.querySelector("summary")!.textContent!, /track "Lead" \(created in step 1\)/);
    assert.doesNotMatch(rows.map(row => row.querySelector("summary")!.textContent).join("\n"), /trackRef|\(ref /);
    assert.deepEqual(JSON.parse(rows[4]!.querySelectorAll("pre")[1]!.textContent!), { targets: orderedPlan.targets });
    const parameters = rows[4]!.querySelector<HTMLElement>('[role="region"]')!;
    parameters.focus(); parameters.scrollTop = 100;
    const settings = h.readBootstrappedClientStateReference().settings;
    h.emitServerEvent({ type: "global_settings_changed", commandId: "direct-locale",
      defaultFollowUpBehavior: settings.defaultFollowUpBehavior, defaultFollowUpBehaviorRevision: settings.defaultFollowUpBehaviorRevision,
      showContextUsage: settings.showContextUsage, contextUsageVisibilityRevision: settings.contextUsageVisibilityRevision,
      uiLanguage: "zh-CN", uiLanguageRevision: "1" }); await h.settle();
    assert.equal(h.document.activeElement, parameters);
    assert.equal(parameters.scrollTop, 100);
    assert.equal(rows[4]!.open, true);
    assert.match(rows[4]!.querySelector("summary")!.textContent!, /设置参数.*70 个参数/);
    review.querySelector<HTMLButtonElement>(".confirm-buttons .primary")!.click(); await h.settle();
    assert.deepEqual(jsonCalls(h, "/confirm").at(-1)?.body, { id: request.id, apply: true });
    assert.equal(review.querySelector<HTMLButtonElement>(".confirm-buttons .primary")!.disabled, true);
    review.querySelector<HTMLButtonElement>(".confirm-buttons .primary")!.click(); await h.settle();
    assert.equal(jsonCalls(h, "/confirm").length, 1);
    h.emitServerEvent({ type: "command_confirm_resolved", commandId: command.id, sessionId: command.sessionId, id: request.id }); await h.settle();
    assert.equal(h.document.querySelector("[data-pending-confirmation]"), null);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("approval summaries keep complete long target names and deletion positions", async () => {
  const trackName = "Layered atmospheric strings with evolving harmonics and a slowly rising upper-register melody";
  const clipName = "Final chorus variation with the original bass motif and extended transition into the closing section";
  const plan: AgentPlan = { message: "Remove the draft", actions: [{ type: "delete_clip", trackName, clipName, startBeat: 64 }] };
  const h = await createDialogHarness(stateFixture());
  const command = { id: "long-target", sessionId: "session-1", stopping: false };
  try {
    h.emitServerEvent({ type: "command_activity", command, bridgeStateRevision: "100" });
    h.emitServerEvent({ type: "command_confirm_request", commandId: command.id, sessionId: command.sessionId,
      id: "long-target-confirm", kind: "apply", operationId: "long-target-operation", message: plan.message,
      groups: actionDiffGroups(plan.actions, plan.targets), plan });
    await h.settle();
    const details = h.document.querySelector<HTMLDetailsElement>('[data-operation-id="long-target-operation"] details[data-action-index="0"]')!;
    const summary = details.querySelector<HTMLElement>("summary")!;
    assert.ok(summary.textContent!.includes(trackName));
    assert.ok(summary.textContent!.includes(clipName));
    assert.match(summary.textContent!, /64/);
    summary.click();
    assert.deepEqual(JSON.parse(details.querySelector("pre")!.textContent!), plan.actions[0]);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("a distinct confirmation starts at its warning instead of retaining the previous body scroll", async () => {
  const h = await createDialogHarness(stateFixture());
  const command = { id: "long-review", sessionId: "session-1", stopping: false };
  const request = { type: "command_confirm_request", commandId: command.id, sessionId: command.sessionId,
    id: "first-review", kind: "apply", message: "Review the proposed changes", groups: [{ title: "Changes", rows: Array.from({ length: 180 }, (_, i) => `Operation ${i}`) }] };
  try {
    h.emitServerEvent({ type: "command_activity", command, bridgeStateRevision: "100" });
    h.emitServerEvent(request); await h.settle();
    const body = h.document.querySelector<HTMLElement>("#appConfirmationBody")!;
    body.scrollTop = 500; body.scrollLeft = 100;
    await h.acceptAppConfirmation(); await h.settle();
    h.emitServerEvent({ ...request, id: "second-review", message: "Review a different set of changes" }); await h.settle();
    assert.equal(h.document.querySelector<HTMLElement>("#appConfirmation")!.hidden, false);
    assert.equal(body.scrollTop, 0); assert.equal(body.scrollLeft, 0);
    await h.cancelAppConfirmation();
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

for (const mode of ["manual", "automatic"] as const) test(`${mode} Apply exposes ordered independent action parameters through updates and reopened history`, async () => {
  const proposal = event("ordered-proposal", "apply_requested", "Build the lead", "proposed");
  proposal.applyOperation!.plan = orderedPlan;
  const completion = event("ordered-result", "apply_result", "Applied all five actions.", "applied");
  const approval = event("ordered-approved", "apply_auto_approved", "5 changes · Accept Everything", "approved");
  const state = stateFixture(); state.openSettingsOnLoad = false;
  state.events = mode === "manual" ? [] : [proposal, approval, completion];
  const h = await createDialogHarness(state);
  if (mode === "manual") h.holdNextSend();
  try {
    if (mode === "manual") {
      h.input("#prompt", "Build the lead"); h.click("#sendButton");
      await waitForCondition(() => h.sendIds.length === 1, "Expected send");
      h.emitServerEvent({ type: "session_event", sendId: h.sendIds[0], sessionId: "session-1", event: proposal });
      h.emitServerEvent({ type: "confirm_request", sendId: h.sendIds[0], sessionId: "session-1", modelTurnEpoch: 0,
        id: "ordered-confirmation", operationId: "batch-operation", confirmationGeneration: 1, kind: "apply", message: "Build the lead",
        groups: actionDiffGroups(orderedPlan.actions, orderedPlan.targets) });
      await h.settle();
    }
    const card = h.document.querySelector<HTMLElement>('[data-operation-id="batch-operation"]')!;
    const step = card.closest<HTMLDetailsElement>(".timeline-activity-step")!;
    if (!step.open) step.querySelector<HTMLElement>(":scope > summary")!.click();
    const plan = card.querySelector<HTMLDetailsElement>(":scope > details")!;
    assert.equal(plan.open, mode === "manual");
    if (!plan.open) plan.querySelector<HTMLElement>(":scope > summary")!.click();
    const details = [...plan.querySelectorAll<HTMLDetailsElement>("details[data-action-index]")];
    assert.equal(details.length, orderedPlan.actions.length);
    assert.deepEqual(details.map((item) => item.querySelector("summary")!.textContent!.match(/^\d+\./)?.[0]), ["1.", "2.", "3.", "4.", "5."]);
    assert.ok(details.every((item) => [...item.querySelector("summary")!.textContent!].length <= 160), "Action summaries stay concise while the parameter disclosure holds full values");
    const parameterSummary = details[4]!.querySelector("summary")!.textContent!;
    assert.match(parameterSummary, /Set parameters.*Bus.*Auto Filter.*70/);
    assert.doesNotMatch(parameterSummary, /Parameter 0|0\.7|…/);
    for (const [index, item] of details.entries()) {
      assert.equal(item.open, false);
      item.querySelector<HTMLElement>(":scope > summary")!.click();
      assert.equal(item.open, true);
      assert.deepEqual(JSON.parse(item.querySelector("pre")!.textContent!), orderedPlan.actions[index]);
    }
    details[0]!.querySelector<HTMLElement>(":scope > summary")!.click();
    assert.equal(details[0]!.open, false);
    assert.equal(details[3]!.open, true);
    assert.match(details[4]!.textContent!, /"bus"[\s\S]*"trackName": "Bus"/);
    const parameters = details[3]!.querySelector<HTMLElement>('[role="region"]')!;
    parameters.focus(); parameters.scrollTop = 120;
    const settings = h.readBootstrappedClientStateReference().settings;
    h.emitServerEvent({ type: "global_settings_changed", commandId: "ordered-locale",
      defaultFollowUpBehavior: settings.defaultFollowUpBehavior, defaultFollowUpBehaviorRevision: settings.defaultFollowUpBehaviorRevision,
      showContextUsage: settings.showContextUsage, contextUsageVisibilityRevision: settings.contextUsageVisibilityRevision,
      uiLanguage: "zh-CN", uiLanguageRevision: "1" });
    await h.settle();
    assert.equal(h.document.activeElement, parameters);
    assert.equal(parameters.scrollTop, 120);
    assert.equal(details[3]!.open, true);
    assert.match(details[1]!.querySelector("summary")!.textContent!, /速度/);
    assert.match(details[4]!.querySelector("summary")!.textContent!, /设置参数.*Bus.*Auto Filter.*70 个参数/);
    assert.doesNotMatch(details[4]!.querySelector("summary")!.textContent!, /Parameter 0|0\.7|…/);
    if (mode === "manual") {
      card.querySelector<HTMLButtonElement>(".confirm-buttons .primary")!.click(); await h.settle();
      assert.deepEqual(jsonCalls(h, "/confirm"), [{ path: "/confirm", body: { id: "ordered-confirmation", apply: true } }]);
      h.emitServerEvent({ type: "session_event", sendId: h.sendIds[0], sessionId: "session-1", event: completion });
      assert.equal(plan.open, false);
      plan.querySelector<HTMLElement>(":scope > summary")!.click();
      assert.equal(details[3]!.open, true);
      assert.deepEqual(JSON.parse(details[3]!.querySelector("pre")!.textContent!), orderedPlan.actions[3]);
    } else {
      assert.equal(card.querySelector<HTMLElement>(".confirm-buttons")!.hidden, true);
    }
    const reopenedState = stateFixture(); reopenedState.openSettingsOnLoad = false;
    reopenedState.events = [proposal, ...(mode === "automatic" ? [approval] : []), completion];
    const reopened = await createDialogHarness(reopenedState);
    try {
      const rows = [...reopened.document.querySelectorAll<HTMLDetailsElement>("details[data-action-index]")];
      assert.equal(rows.length, orderedPlan.actions.length);
      const step = rows[3]!.closest<HTMLDetailsElement>(".timeline-activity-step")!;
      step.querySelector<HTMLElement>(":scope > summary")!.click();
      const plan = rows[3]!.parentElement!.closest<HTMLDetailsElement>("details")!;
      plan.querySelector<HTMLElement>(":scope > summary")!.click();
      rows[3]!.querySelector<HTMLElement>(":scope > summary")!.click();
      assert.deepEqual(JSON.parse(rows[3]!.querySelector("pre")!.textContent!), orderedPlan.actions[3]);
      assert.deepEqual(reopened.errors, []);
    } finally { reopened.close(); }
    assert.deepEqual(h.errors, []);
  } finally { if (mode === "manual") { h.releaseHeldSend(); await h.settle(); } h.close(); }
});

test("completed batch Apply shows the full result before folded action details", async () => {
  const state = stateFixture(); state.openSettingsOnLoad = false;
  state.events = [event("proposal", "apply_requested", planText, "proposed"),
    event("approval", "apply_auto_approved", "33 changes · Accept Everything", "approved"),
    event("result", "apply_result", resultText, "applied")];
  const h = await createDialogHarness(state);
  try {
    const card = h.document.querySelector<HTMLElement>('[data-operation-id="batch-operation"]')!;
    const step = card.closest<HTMLDetailsElement>(".timeline-activity-step")!;
    assert.match(step.querySelector(":scope > summary")!.textContent!, /Applied 33 changes/);
    step.querySelector<HTMLElement>(":scope > summary")!.click();
    const result = card.querySelector<HTMLElement>('[role="status"]')!;
    const details = card.querySelector<HTMLDetailsElement>("details");
    assert.ok(details, "The original action plan must have its own disclosure");
    assert.equal(details.open, false);
    assert.equal(result.textContent, resultText);
    assert.ok(result.compareDocumentPosition(details) & h.window.Node.DOCUMENT_POSITION_FOLLOWING);
    result.focus(); assert.equal(h.document.activeElement, result);
    details.querySelector<HTMLElement>(":scope > summary")!.click();
    assert.equal(details.open, true);
    assert.match(details.textContent!, /33\. Set track 33 volume to 0\.5\./);
    const region = details.querySelector<HTMLElement>('[role="region"]')!;
    region.focus(); assert.equal(h.document.activeElement, region);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("manual batch review exposes all changes and folds its plan after the decision", async () => {
  const state = stateFixture(); state.openSettingsOnLoad = false; state.events = [];
  const h = await createDialogHarness(state); h.holdNextSend();
  try {
    h.input("#prompt", "Balance tracks"); h.click("#sendButton");
    await waitForCondition(() => h.sendIds.length === 1, "Expected send");
    h.emitServerEvent({ type: "session_event", sendId: h.sendIds[0], sessionId: "session-1", event: event("proposal", "apply_requested", planText, "proposed") });
    h.emitServerEvent({ type: "confirm_request", sendId: h.sendIds[0], sessionId: "session-1", modelTurnEpoch: 0,
      id: "batch-confirmation", operationId: "batch-operation", confirmationGeneration: 1, kind: "apply", message: "Balance tracks",
      groups: [{ title: "Mixer changes", rows: actions }] });
    await h.settle();
    const card = h.document.querySelector<HTMLElement>("[data-pending-confirmation]")!;
    const details = card.querySelector<HTMLDetailsElement>("details");
    assert.ok(details);
    assert.equal(details.open, true);
    assert.equal(card.querySelectorAll(".confirm-rows li").length, 33);
    assert.equal(card.querySelector(".confirm-rows li:last-child")!.textContent, actions.at(-1));
    const region = details.querySelector<HTMLElement>('[role="region"]')!;
    region.focus(); assert.equal(h.document.activeElement, region);
    const apply = card.querySelector<HTMLButtonElement>(".confirm-buttons .primary")!;
    apply.focus(); assert.equal(h.document.activeElement, apply);
    apply.click(); await h.settle();
    assert.deepEqual(jsonCalls(h, "/confirm"), [{ path: "/confirm", body: { id: "batch-confirmation", apply: true } }]);
    assert.equal(details.open, false);
    h.emitServerEvent({ type: "session_event", sendId: h.sendIds[0], sessionId: "session-1", event: event("result", "apply_result", resultText, "applied") });
    assert.equal(card.querySelector('[role="status"]')!.textContent, resultText);
    details.querySelector<HTMLElement>(":scope > summary")!.click();
    h.emitServerEvent({ type: "session_event", sendId: h.sendIds[0], sessionId: "session-1", event: event("result", "apply_result", resultText + "\nConfirmed.", "applied") });
    assert.equal(details.open, true, "Later updates must preserve the reader's disclosure choice");
    assert.deepEqual(h.errors, []);
  } finally { h.releaseHeldSend(); await h.settle(); h.close(); }
});

test("legacy Apply history folds its proposal and keeps the execution result directly readable", async () => {
  const state = stateFixture(); state.openSettingsOnLoad = false;
  state.events = [event("proposal", "apply_requested", planText), event("result", "apply_result", resultText)];
  const h = await createDialogHarness(state);
  try {
    h.click(".timeline-activity-step > summary");
    const proposal = h.document.querySelector<HTMLDetailsElement>('details[data-event-id="proposal"]');
    assert.ok(proposal);
    assert.equal(proposal.open, false);
    const result = h.document.querySelector<HTMLElement>('[data-event-id="result"] .timeline-activity-detail-content')!;
    assert.equal(result.textContent, resultText);
    assert.equal(result.closest<HTMLDetailsElement>("details")!.open, true);
    proposal.querySelector<HTMLElement>(":scope > summary")!.click();
    assert.match(proposal.textContent!, /33\. Set track 33/);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});
