import assert from "node:assert/strict";
import test from "node:test";
import { URL } from "node:url";
import { uiMessage, formatUiMessage, type UiMessage } from "../../../src/i18n/ui-message.js";
import type { DeviceParameterApplication, DeviceParameterArtifact } from "../../../src/agent/device-parameter-contracts.js";
import type { SessionArtifact } from "../../../src/app/session/session-artifacts.js";
import { captureParameterDevice } from "../../../src/live/device-parameters.js";
import { deviceParameterFixture } from "../../live/support/device-parameter-fixture.js";
import { cloneState, commandCalls, createDialogHarness, stateFixture, waitForCondition } from "../support/chat-dialog.test-harness.js";

async function setup(options: { unknown?: boolean; roundedWrites?: boolean; language?: "en" | "zh-CN"; secondWork?: boolean; bindingError?: UiMessage; restoreError?: UiMessage; switchError?: UiMessage } = {}) {
  const state = stateFixture(); state.openSettingsOnLoad = false; state.settings.uiLanguage = options.language ?? "en";
  const live = deviceParameterFixture(300); const snapshot = await captureParameterDevice(live.context, live.target);
  const base: DeviceParameterArtifact = { ...snapshot, id: "parameters_base", sessionId: state.activeSessionId!, label: "Original synth", createdAt: "2026-10-09T00:00:00Z", version: { groupId: "parameters_base", number: 1 }, source: { kind: "captured" } };
  const saved: DeviceParameterArtifact = { ...base, id: "parameters_new", label: "Soft synth", version: { groupId: base.id, number: 2, derivedFromId: base.id },
    source: { kind: "model", profileId: "profile", model: "model" }, parameters: base.parameters.map((parameter) => parameter.index === 1 ? { ...parameter, value: 0.75 } : parameter) };
  const other: DeviceParameterArtifact = { ...base, id: "parameters_other", label: "Other synth work", version: { groupId: "parameters_other", number: 1 } };
  const bright: DeviceParameterArtifact = { ...saved, id: "parameters_bright", label: "Bright synth", version: { ...saved.version, number: 3 },
    parameters: base.parameters.map((parameter) => parameter.index === 1 ? { ...parameter, value: 0.4 } : parameter) };
  const all = [base, saved, other, bright];
  const current = { ...snapshot, parameters: snapshot.parameters.map((parameter) => ({ ...parameter })) };
  const projection = (artifact: DeviceParameterArtifact, detail = false): SessionArtifact => ({ ref: { kind: "device-parameters", id: artifact.id }, label: artifact.label, createdAt: artifact.createdAt,
    sourceLabel: artifact.source.kind === "captured" ? "Captured device parameters" : "AI-proposed device parameters", version: { ...artifact.version, groupLabel: artifact.version.groupId === base.id ? base.label : artifact.label },
    versions: all.filter((entry) => entry.version.groupId === artifact.version.groupId).map((entry) => ({ id: entry.id, label: entry.label, number: entry.version.number, createdAt: entry.createdAt,
      ...(entry.version.derivedFromId ? { derivedFromId: entry.version.derivedFromId } : {}) })),
    deviceParameters: { target: artifact.target, parameterCount: artifact.parameters.length, source: artifact.source.kind, ...(detail ? { parameters: artifact.parameters } : {}) } });
  let application: DeviceParameterApplication | undefined = options.unknown ? {
    id: "parameter_application", sessionId: base.sessionId, artifactId: saved.id, createdAt: base.createdAt, target: base.target, status: "partial",
    artifactLabel: saved.label, artifactVersion: saved.version.number, baselineArtifactId: base.id,
    entries: [{ parameter: base.parameters[1]!, requested: 0.75, state: "applying" }],
  } : undefined;
  const h = await createDialogHarness(state);
  const original = h.window.fetch;
  const reads: { body: { artifactId?: string }; signal?: AbortSignal | null }[] = [];
  let held: Promise<void> | undefined; let release = () => {};
  let readFailure: { error: string; displayMessage?: UiMessage } | undefined;
  let heldVersion: Promise<void> | undefined; let releaseVersion = () => {};
  let versionSignal: AbortSignal | null | undefined;
  Object.defineProperty(h.window, "fetch", { configurable: true, value: async (input: string, init?: RequestInit) => {
    const path = new URL(String(input)).pathname; const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (path === "/session-artifacts") return { ok: true, json: async () => ({ sessionId: base.sessionId, artifacts: (options.secondWork ? [saved, other] : [saved]).map((entry) => projection(entry)), total: options.secondWork ? 2 : 1, offset: 0, unavailableCount: 0 }) };
    if (path === "/session-artifact") {
      const wait = heldVersion; heldVersion = undefined; versionSignal = init?.signal; if (wait) await wait;
      return { ok: true, json: async () => ({ sessionId: base.sessionId, artifact: projection(all.find((entry) => entry.id === body.artifact.id)!, true) }) };
    }
    if (path === "/device-parameters") {
      reads.push({ body, ...(init?.signal === undefined ? {} : { signal: init.signal }) });
      const pending = held; held = undefined; if (pending) await pending;
      if (readFailure) { const failure = readFailure; readFailure = undefined; return { ok: false, json: async () => failure }; }
      return { ok: true, json: async () => JSON.parse(JSON.stringify({ sessionId: base.sessionId, devices: [snapshot.target],
        ...(body.artifactId ? { artifact: all.find((entry) => entry.id === body.artifactId), ...(options.bindingError ? { bindingError: options.bindingError } : { current }),
          ...(body.baseArtifactId || body.artifactId === saved.id ? { comparison: all.find((entry) => entry.id === (body.baseArtifactId ?? base.id)) } : {}) } : {}),
        ...(application ? { application } : {}), ...(options.restoreError ? { restoreError: options.restoreError } : {}), ...(options.switchError ? { switchError: options.switchError } : {}) })) };
    }
    if (path === "/command") {
      if (body.kind === "apply_device_parameters") {
        const selected = all.find((entry) => entry.id === body.artifactId)!;
        current.parameters = selected.parameters.map((entry) => ({ ...entry, value: options.roundedWrites ? Math.fround(entry.value) : entry.value }));
        application = { id: "parameter_application", sessionId: base.sessionId, artifactId: selected.id, createdAt: base.createdAt,
          artifactLabel: selected.label, artifactVersion: selected.version.number, baselineArtifactId: base.id,
          target: base.target, status: "applied", entries: base.parameters.map((parameter, index) => ({ parameter,
            requested: selected.parameters[index]!.value, state: "applied", after: current.parameters[index]!.value })) };
      }
      if (body.kind === "restore_device_parameters" && application) { application.status = "restored"; application.entries[0]!.state = "restored"; current.parameters = base.parameters.map((entry) => ({ ...entry })); }
      if (body.kind === "keep_device_parameters" && application) application.status = "kept";
    }
    return original(input, init);
  } });
  const open = async () => {
    h.click("#artifactsShortcut"); h.click("#openArtifactsButton"); await waitForCondition(() => Boolean(h.document.querySelector(".artifact-open")), "Expected the saved parameter work");
    h.click(".artifact-open"); await waitForCondition(() => h.document.querySelectorAll(".artifact-card .parameter-table-view:first-of-type tbody tr").length === 300 ||
      [...h.document.querySelectorAll(".artifact-card .parameter-table-view tbody")].some((body) => body.children.length === 300), "Expected every saved parameter in the preview");
  };
  const click = (text: string, root = "#artifactLibrary") => {
    const button = [...h.document.querySelectorAll<HTMLButtonElement>(`${root} button`)].find((button) => button.textContent === text || button.getAttribute("aria-label") === text);
    assert.ok(button, text); assert.equal(button.disabled, false, text); button.click();
  };
  const showChat = async (entries = [saved, bright, other], presented = entries) => {
    const next = cloneState(h.readBootstrappedClientStateReference());
    next.events.push(...entries.map((entry) => ({ id: `result-${entry.id}`, kind: "tool_result" as const, name: "save_device_parameter_artifact", outcome: "success" as const,
      createdAt: entry.createdAt, content: JSON.stringify({ artifacts: [{ kind: "device-parameters", artifactRef: entry.id, label: entry.label }] }), artifacts: [{ kind: "device-parameters" as const, id: entry.id }] })));
    next.events.push({ id: "present-choices", kind: "tool_result", name: "present_device_parameter_candidates", outcome: "success",
      createdAt: saved.createdAt, content: JSON.stringify({ candidates: presented.map(entry => ({ kind: "device-parameters", artifactRef: entry.id, label: entry.label })) }),
      artifacts: presented.map(entry => ({ kind: "device-parameters", id: entry.id })) });
    h.setServerState(next); h.emitServerEvent({ type: "session_state_invalidated", sessionId: next.activeSessionId });
    await waitForCondition(() => Boolean(h.document.querySelector("#timeline .sound-comparison-card")), "Expected the saved candidates in chat"); await h.settle();
    return next;
  };
  return { h, state, base, saved, other, bright, snapshot, open, click, reads, showChat,
    setApplicationStatus(status: DeviceParameterApplication["status"]) { if (application) application.status = status; },
    setCurrentValue(index: number, value: number) { current.parameters[index]!.value = value; },
    holdRead() { held = new Promise<void>((resolve) => { release = resolve; }); }, release: () => release(),
    failRead(displayMessage?: UiMessage) { readFailure = displayMessage ? { error: formatUiMessage(displayMessage), displayMessage } : { error: "Comparison read failed." }; },
    holdVersion() { heldVersion = new Promise<void>((resolve) => { releaseVersion = resolve; }); }, releaseVersion: () => releaseVersion(),
    get versionSignal() { return versionSignal; } };
}

test("complete parameter previews are read-only and apply/restore send only exact references", async () => {
  const s = await setup(); const { h } = s;
  try {
    await s.open(); assert.deepEqual(commandCalls(h), []);
    assert.equal(h.document.querySelector(".artifact-card button[data-artifact-transfer]"), null);
    const tables = [...h.document.querySelectorAll(".artifact-card .parameter-table-view")];
    const table = tables.find((element) => element.querySelectorAll("tbody tr").length === 300)!;
    const filter = table.querySelector<HTMLInputElement>('input[type="search"]')!;
    filter.value = "Parameter 299"; filter.dispatchEvent(new h.window.Event("input", { bubbles: true }));
    assert.equal(table.querySelectorAll("tbody tr").length, 1); assert.match(table.textContent!, /Parameter 299/);
    s.click("Audition in Live"); await waitForCondition(() => commandCalls(h).length === 1, "Expected the apply command"); await h.settle();
    assert.deepEqual(commandCalls(h)[0]!.body, { kind: "apply_device_parameters", sessionId: s.base.sessionId, artifactId: s.saved.id });
    await waitForCondition(() => [...h.document.querySelectorAll<HTMLButtonElement>(".parameter-artifact-view button")].some((button) => button.getAttribute("aria-label") === "Restore before audition" && !button.disabled), "Expected the saved application receipt");
    s.click("Restore before audition"); await waitForCondition(() => commandCalls(h).length === 2, "Expected the restore command"); await h.settle();
    assert.deepEqual(commandCalls(h)[1]!.body, { kind: "restore_device_parameters", sessionId: s.base.sessionId, applicationId: "parameter_application" });
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

const chatCard = "#timeline .chat-parameter-candidates";
test("capturing and saving parameters retain tool history without presenting sound choices", async () => {
  const s = await setup(); const { h } = s;
  try {
    const next = cloneState(h.readBootstrappedClientStateReference());
    next.events.push(...[s.base, s.saved].map((entry, index) => ({ id: `stored-${index}`, kind: "tool_result" as const,
      name: index ? "save_device_parameter_artifact" : "capture_device_parameter_artifact", outcome: "success" as const,
      content: JSON.stringify({ artifacts: [{ kind: "device-parameters", artifactRef: entry.id, label: entry.label }] }),
      createdAt: entry.createdAt, artifacts: [{ kind: "device-parameters" as const, id: entry.id }] })));
    h.setServerState(next); h.emitServerEvent({ type: "session_state_invalidated", sessionId: next.activeSessionId }); await h.settle();
    assert.equal(h.document.querySelector(`${chatCard}, #timeline .parameter-candidate-choices`), null);
    for (const summary of h.document.querySelectorAll<HTMLElement>("#timeline details > summary")) summary.click();
    await h.settle();
    assert.equal(h.document.querySelector("#timeline .parameter-candidate-choices"), null);
    assert.match(h.document.querySelector("#timeline")!.textContent!, /Original synth/);
    assert.match(h.document.querySelector("#timeline")!.textContent!, /Soft synth/);
    assert.deepEqual(s.reads, []); assert.deepEqual(commandCalls(h), []);
  } finally { h.close(); }
});

test("explicit presentations retain their own choices and position even when they share a candidate", async () => {
  const s = await setup(); const { h } = s;
  try {
    const next = await s.showChat([s.saved, s.bright, s.other], [s.bright, s.saved]);
    next.events.push({ id: "explain-choice", kind: "assistant", content: "Compare the final two sounds.", createdAt: s.saved.createdAt },
      { id: "present-again", kind: "tool_result", name: "present_device_parameter_candidates", outcome: "success", createdAt: s.saved.createdAt,
        content: JSON.stringify({ candidates: [{ kind: "device-parameters", artifactRef: s.bright.id, label: s.bright.label }] }),
        artifacts: [{ kind: "device-parameters", id: s.bright.id }] });
    h.setServerState(next); h.emitServerEvent({ type: "session_state_invalidated", sessionId: next.activeSessionId }); await h.settle();
    const cards = [...h.document.querySelectorAll(chatCard)]; assert.equal(cards.length, 2);
    assert.deepEqual(cards.map(card => [...card.querySelectorAll<HTMLElement>("[data-parameter-candidate]")].map(button => button.dataset.parameterCandidate)), [[s.bright.id, s.saved.id], [s.bright.id]]);
    const reply = h.document.querySelector('[data-event-id="explain-choice"]')!;
    assert.ok(cards[0]!.compareDocumentPosition(reply) & h.window.Node.DOCUMENT_POSITION_FOLLOWING);
    assert.ok(reply.compareDocumentPosition(cards[1]!) & h.window.Node.DOCUMENT_POSITION_FOLLOWING);
    assert.deepEqual(commandCalls(h), []); assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

function choose(s: Awaited<ReturnType<typeof setup>>, id: string) {
  const button = s.h.document.querySelector<HTMLButtonElement>(`${chatCard} [data-parameter-candidate="${id}"]`)!;
  assert.ok(button); assert.equal(button.disabled, false); button.click();
}
function originalChoice(s: Awaited<ReturnType<typeof setup>>) {
  return s.h.document.querySelector<HTMLButtonElement>(`${chatCard} [data-parameter-original]`)!;
}

test("one comparison card switches Original/A/B/C directly and can return to Original repeatedly", async () => {
  const s = await setup(); const { h } = s;
  try {
    await s.showChat();
    assert.equal(h.document.querySelectorAll("#timeline .sound-comparison-card").length, 1);
    assert.equal(originalChoice(s).getAttribute("aria-pressed"), "true");
    for (const candidate of [s.saved, s.bright, s.other]) {
      const button = h.document.querySelector<HTMLButtonElement>(`[data-parameter-candidate="${candidate.id}"]`)!;
      assert.equal(button.textContent, candidate.label);
      for (let parent = button.parentElement; parent; parent = parent.parentElement) {
        assert.equal(parent.hidden, false); if (parent instanceof h.window.HTMLDetailsElement) assert.equal(parent.open, true);
      }
      choose(s, candidate.id); await h.settle();
      assert.equal((commandCalls(h).at(-1)!.body as { artifactId: string }).artifactId, candidate.id);
      assert.equal((commandCalls(h).at(-1)!.body as { presentationId: string }).presentationId, "present-choices");
      assert.equal(button.getAttribute("aria-pressed"), "true"); assert.equal(originalChoice(s).getAttribute("aria-pressed"), "false");
    }
    assert.equal(originalChoice(s).disabled, false); originalChoice(s).click(); await h.settle();
    assert.equal((commandCalls(h).at(-1)!.body as { kind: string }).kind, "restore_device_parameters");
    assert.equal((commandCalls(h).at(-1)!.body as { presentationId: string }).presentationId, "present-choices");
    assert.equal(originalChoice(s).getAttribute("aria-pressed"), "true");
    choose(s, s.saved.id); await h.settle(); originalChoice(s).click(); await h.settle();
    assert.equal(originalChoice(s).getAttribute("aria-pressed"), "true");
    const activeActions = [...h.document.querySelectorAll<HTMLButtonElement>(`${chatCard} button`)].filter((button) => !button.hidden && ["Use this sound", "Keep current values", "Restore before audition"].includes(button.textContent!));
    assert.deepEqual(activeActions, []);
    assert.equal(h.document.querySelector<HTMLElement>("#artifactsPage")!.hidden, true); assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

for (const count of [1, 2, 3]) test(`the presentation tool chooses ${count} candidates without adding other saved versions`, async () => {
  const s = await setup(); const { h } = s;
  try {
    s.saved.label = "Warm evolving sound with a long descriptive name that remains available when the compact choice is truncated";
    const candidates = [s.saved, s.bright, s.other].slice(0, count);
    await s.showChat([s.base, ...candidates], candidates);
    assert.deepEqual([...h.document.querySelectorAll<HTMLButtonElement>(`${chatCard} [data-parameter-candidate]`)].map(button => button.dataset.parameterCandidate), candidates.map(candidate => candidate.id));
    const choice = h.document.querySelector<HTMLButtonElement>(`${chatCard} [data-parameter-candidate="${s.saved.id}"]`)!;
    assert.equal(choice.title, s.saved.label); assert.equal(choice.textContent, s.saved.label);
    choice.click(); await h.settle();
    h.click(`${chatCard} .parameter-artifact-details > summary`);
    assert.equal([...h.document.querySelectorAll(`${chatCard} label`)].some(label => label.textContent?.includes("Compare with")), false);
    assert.match(h.document.querySelector(`${chatCard} .parameter-artifact-details`)!.textContent!, new RegExp(s.saved.label));
    assert.equal(originalChoice(s).disabled, false); assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("a connected tool candidate uses the same explicit presentation", async () => {
  const s = await setup();
  try {
    s.saved.source = { kind: "mcp", clientId: "test-client", clientName: "Sound author" };
    await s.showChat([s.base, s.saved], [s.saved]);
    assert.deepEqual([...s.h.document.querySelectorAll<HTMLButtonElement>(`${chatCard} [data-parameter-candidate]`)].map(button => button.dataset.parameterCandidate), [s.saved.id]);
    choose(s, s.saved.id); await s.h.settle();
    assert.equal(originalChoice(s).disabled, false); assert.deepEqual(s.h.errors, []);
  } finally { s.h.close(); }
});

test("one shared detail view retains the selection and input when other tool results arrive", async () => {
  const s = await setup(); const { h } = s;
  try {
    const chatState = await s.showChat(); choose(s, s.saved.id); await h.settle();
    const card = h.document.querySelector(chatCard)!;
    const details = card.querySelector<HTMLDetailsElement>(".parameter-artifact-details")!;
    assert.equal(details.open, false); (details.querySelector("summary") as HTMLElement).click();
    const filter = details.querySelector<HTMLInputElement>('input[type="search"]')!;
    filter.value = "Gain"; filter.dispatchEvent(new h.window.Event("input", { bubbles: true })); filter.focus();
    const next = cloneState(chatState);
    next.events.unshift({ id: "observation", kind: "tool_result", name: "inspect_device", outcome: "success", content: "Synth observed", createdAt: s.saved.createdAt });
    next.events.push({ id: "later-observation", kind: "tool_result", name: "inspect_track", outcome: "success", content: "Lead observed", createdAt: s.saved.createdAt });
    h.setServerState(next); h.emitServerEvent({ type: "session_state_invalidated", sessionId: next.activeSessionId }); await h.settle();
    assert.equal(h.document.querySelector(chatCard), card); assert.equal(details.open, true); assert.equal(filter.value, "Gain");
    assert.equal(card.querySelector(`[data-parameter-candidate="${s.saved.id}"]`)!.getAttribute("aria-pressed"), "true");
    choose(s, s.other.id); await h.settle();
    assert.equal((commandCalls(h).at(-1)!.body as { artifactId: string }).artifactId, s.other.id); assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("audition readback retains visible details and the last confirmed selection while locking writes", async () => {
  const s = await setup(); const { h } = s;
  try {
    await s.showChat(); choose(s, s.saved.id); await h.settle();
    const card = h.document.querySelector(chatCard)!;
    const view = card.querySelector<HTMLElement>(".parameter-artifact-view")!;
    const details = card.querySelector<HTMLDetailsElement>(".parameter-artifact-details")!;
    (details.querySelector("summary") as HTMLElement).click();
    const table = details.querySelector<HTMLElement>(".parameter-table-view")!;
    const receipt = details.querySelector<HTMLElement>(".parameter-application")!;
    const filter = table.querySelector<HTMLInputElement>('input[type="search"]')!;
    filter.value = "Gain"; filter.dispatchEvent(new h.window.Event("input", { bubbles: true })); filter.focus();
    const selected = card.querySelector<HTMLButtonElement>(`[data-parameter-candidate="${s.saved.id}"]`)!;
    const before = commandCalls(h).length;
    const readsBefore = s.reads.length;
    s.holdRead();
    h.emitServerEvent({ type: "session_state_invalidated", sessionId: s.base.sessionId });
    await waitForCondition(() => s.reads.length > readsBefore, "Expected the comparison readback");
    assert.equal(table.hidden, false); assert.equal(receipt.hidden, false);
    assert.equal(view.querySelector<HTMLElement>('[role="status"]')!.hidden, true);
    assert.equal(view.getAttribute("aria-busy"), "true");
    assert.equal(selected.getAttribute("aria-pressed"), "true");
    assert.equal(details.open, true); assert.equal(filter.value, "Gain"); assert.equal(h.document.activeElement, filter);
    const buttons = [...card.querySelectorAll<HTMLButtonElement>(".parameter-candidate-choices button")];
    assert.ok(buttons.every((button) => button.disabled)); buttons.forEach((button) => button.click());
    assert.equal(commandCalls(h).length, before);
    s.release(); await h.settle();
    assert.equal(h.document.querySelector(chatCard), card); assert.equal(view.getAttribute("aria-busy"), "false");
    assert.equal(selected.getAttribute("aria-pressed"), "true"); assert.equal(originalChoice(s).disabled, false);
    const nextRead = s.reads.length;
    s.holdRead(); choose(s, s.bright.id);
    await waitForCondition(() => s.reads.length > nextRead, "Expected post-apply readback");
    assert.equal(table.hidden, false); assert.equal(receipt.hidden, false);
    assert.equal(view.querySelector<HTMLElement>('[role="status"]')!.hidden, true);
    assert.equal(selected.getAttribute("aria-pressed"), "true");
    s.release(); await h.settle();
    assert.equal(selected.getAttribute("aria-pressed"), "false");
    assert.equal(card.querySelector(`[data-parameter-candidate="${s.bright.id}"]`)!.getAttribute("aria-pressed"), "true");
    originalChoice(s).click(); await h.settle(); assert.equal(originalChoice(s).getAttribute("aria-pressed"), "true");
    assert.deepEqual(h.errors, []);
  } finally { s.release(); await h.settle(); h.close(); }
});

test("a failed audition refresh clears retained values and selection until a successful retry", async () => {
  const s = await setup(); const { h } = s;
  try {
    await s.showChat(); choose(s, s.saved.id); await h.settle();
    h.click(`${chatCard} .parameter-artifact-details > summary`);
    s.failRead(); s.click("Refresh device parameters", chatCard); await h.settle();
    const card = h.document.querySelector(chatCard)!;
    assert.match(card.querySelector('.parameter-artifact-view [role="status"]')!.textContent!, /Comparison read failed/);
    assert.equal(card.querySelector<HTMLElement>('.parameter-artifact-view [role="status"]')!.hidden, false);
    assert.equal(card.querySelector<HTMLElement>(".parameter-table-view")!.hidden, true);
    const choices = [...card.querySelectorAll<HTMLButtonElement>(".parameter-candidate-choices button")];
    assert.ok(choices.every((button) => button.disabled && button.getAttribute("aria-pressed") === "false"));
    const before = commandCalls(h).length; choices.forEach((button) => button.click()); assert.equal(commandCalls(h).length, before);
    s.click("Refresh device parameters", chatCard); await h.settle();
    assert.equal(card.querySelector<HTMLElement>('.parameter-artifact-view [role="status"]')!.hidden, true);
    assert.equal(card.querySelector<HTMLElement>(".parameter-table-view")!.hidden, false);
    assert.equal(card.querySelector(`[data-parameter-candidate="${s.saved.id}"]`)!.getAttribute("aria-pressed"), "true");
    assert.equal(originalChoice(s).disabled, false); assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("the comparison and Artifacts share the current candidate and Original snapshot", async () => {
  const s = await setup(); const { h } = s;
  try {
    await s.showChat(); choose(s, s.saved.id); await h.settle();
    h.click(`${chatCard} .parameter-artifact-details > summary`); s.click("Open artifact", chatCard); await h.settle();
    await waitForCondition(() => h.document.querySelector("#artifactLibrary .parameter-application")?.textContent?.includes("Last application: Soft synth") === true, "Expected shared audition in Artifacts");
    s.click("Use this sound"); await h.settle(); h.click("#closeArtifactsButton"); await h.settle();
    assert.equal(originalChoice(s).disabled, false); originalChoice(s).click(); await h.settle();
    assert.equal(originalChoice(s).getAttribute("aria-pressed"), "true");
    s.click("Open original snapshot", chatCard); await h.settle();
    assert.equal(h.document.querySelector<HTMLSelectElement>(".artifact-version-select")!.value, s.base.id); assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("the comparison restores its selected option after reconnect without replaying a mutation", async () => {
  const s = await setup(); const { h } = s;
  try {
    await s.showChat(); choose(s, s.saved.id); await h.settle(); const before = commandCalls(h).length;
    h.emitServerEventError(); s.setApplicationStatus("kept"); h.emitServerEventOpen(); await h.settle();
    assert.equal(h.document.querySelector(`[data-parameter-candidate="${s.saved.id}"]`)!.getAttribute("aria-pressed"), "true");
    assert.equal(originalChoice(s).disabled, false); assert.equal(commandCalls(h).length, before);
    originalChoice(s).click(); await h.settle(); assert.equal(originalChoice(s).getAttribute("aria-pressed"), "true"); assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("Original selection follows observed original values after restore and refresh", async () => {
  const s = await setup(); const { h } = s;
  try {
    await s.showChat(); choose(s, s.saved.id); await h.settle(); originalChoice(s).click(); await h.settle();
    assert.equal(originalChoice(s).getAttribute("aria-pressed"), "true");
    const before = commandCalls(h).length;
    s.setCurrentValue(1, 0.4); h.emitServerEvent({ type: "session_state_invalidated", sessionId: s.base.sessionId }); await h.settle();
    assert.equal(originalChoice(s).getAttribute("aria-pressed"), "false");
    assert.equal(originalChoice(s).disabled, true);
    assert.ok([...h.document.querySelectorAll(`${chatCard} [data-parameter-candidate]`)].every((choice) => choice.getAttribute("aria-pressed") === "false"));
    assert.equal(commandCalls(h).length, before); assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("the selected candidate follows confirmed SDK values while later manual edits clear selection", async () => {
  const s = await setup({ roundedWrites: true }); const { h } = s;
  try {
    await s.showChat(); choose(s, s.bright.id); await h.settle();
    const choice = h.document.querySelector<HTMLButtonElement>(`${chatCard} [data-parameter-candidate="${s.bright.id}"]`)!;
    assert.equal(choice.getAttribute("aria-pressed"), "true"); assert.equal(choice.disabled, true);
    h.emitServerEventError(); h.emitServerEventOpen(); await h.settle();
    assert.equal(choice.getAttribute("aria-pressed"), "true");
    s.setApplicationStatus("kept"); h.emitServerEvent({ type: "session_state_invalidated", sessionId: s.base.sessionId }); await h.settle();
    assert.equal(choice.getAttribute("aria-pressed"), "true");
    s.setCurrentValue(1, Math.fround(0.4) + 1e-8); h.emitServerEvent({ type: "session_state_invalidated", sessionId: s.base.sessionId }); await h.settle();
    assert.equal(choice.getAttribute("aria-pressed"), "false"); assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("comparison choices lock during mutation and an unconfirmed result cannot claim a selected sound", async () => {
  const s = await setup({ restoreError: uiMessage("A parameter write has an unknown outcome. Inspect Live, then keep the current state before applying another version.") }); const { h } = s;
  let held = false;
  try {
    await s.showChat(); h.holdNextCommand(); held = true; choose(s, s.saved.id); await h.settle();
    const buttons = [...h.document.querySelectorAll<HTMLButtonElement>(`${chatCard} .parameter-candidate-choices button`)];
    assert.ok(buttons.every((button) => button.disabled)); buttons.forEach((button) => button.click()); assert.equal(commandCalls(h).length, 1);
    h.releaseHeldCommand(); held = false; await h.settle();
    s.setApplicationStatus("partial"); h.emitServerEvent({ type: "session_state_invalidated", sessionId: s.base.sessionId }); await h.settle();
    assert.ok(buttons.every((button) => button.disabled)); assert.ok(buttons.every((button) => button.getAttribute("aria-pressed") === "false")); assert.deepEqual(h.errors, []);
  } finally { if (held) h.releaseHeldCommand(); await h.settle(); h.close(); }
});

test("the comparison rejects late Live reads from a previous Session", async () => {
  const s = await setup(); const { h } = s;
  try {
    await s.showChat(); h.click(`${chatCard} .parameter-artifact-details > summary`);
    const previousCard = h.document.querySelector(chatCard)!;
    s.holdRead(); s.click("Refresh device parameters", chatCard); await h.settle(); const pending = s.reads.at(-1)!;
    h.click('.session-entry[data-session-id="session-2"] .session-row'); await h.settle();
    assert.equal(pending.signal?.aborted, true); s.release(); await h.settle();
    assert.equal(previousCard.isConnected, false); assert.equal(h.document.querySelector(`${chatCard} .parameter-artifact-view`), null); assert.deepEqual(h.errors, []);
  } finally { s.release(); await h.settle(); h.close(); }
});

test("unknown writes disable restore and remain inspectable after reloading the artifact", async () => {
  const s = await setup({ unknown: true }); const { h } = s;
  try {
    await s.open();
    const restore = [...h.document.querySelectorAll<HTMLButtonElement>(".parameter-artifact-view button")].find((button) => button.getAttribute("aria-label") === "Restore before audition")!;
    const details = h.document.querySelector<HTMLDetailsElement>(".parameter-application details")!;
    details.open = true; details.dispatchEvent(new h.window.Event("toggle"));
    assert.equal(restore.disabled, true); assert.match(h.document.querySelector(".parameter-application")!.textContent!, /Write not confirmed/);
    assert.deepEqual(commandCalls(h), []);
    s.click("Finish audition"); await waitForCondition(() => commandCalls(h).length === 1, "Expected explicit Keep"); await h.settle();
    assert.deepEqual(commandCalls(h)[0]!.body, { kind: "keep_device_parameters", sessionId: s.base.sessionId, applicationId: "parameter_application" });
    const result = h.document.querySelector(".parameter-application")!;
    assert.match(result.textContent!, /kept/);
    assert.doesNotMatch(result.textContent!, /Kept: Soft synth/);
    assert.match(result.textContent!, /unconfirmed/);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("keeping manual edits describes the current values and their difference from the saved candidate", async () => {
  const s = await setup(); const { h } = s;
  try {
    await s.open(); s.click("Audition in Live"); await h.settle();
    s.setCurrentValue(1, 0.4); s.click("Use this sound"); await h.settle();
    const receipt = h.document.querySelector(".parameter-application")!;
    assert.match(receipt.textContent!, /kept/);
    assert.match(receipt.textContent!, /Current device values differ from the saved candidate/);
    assert.equal(commandCalls(h).filter((call) => (call.body as { kind: string }).kind === "apply_device_parameters").length, 1);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("a failed comparison hides old values and disables receipt actions until a fresh read succeeds", async () => {
  const s = await setup({ unknown: true }); const { h } = s;
  try {
    await s.open();
    const view = h.document.querySelector<HTMLElement>(".parameter-artifact-view")!;
    const table = view.querySelector<HTMLElement>(":scope > .parameter-table-view")!;
    const receipt = view.querySelector<HTMLElement>(".parameter-application")!;
    const keep = [...view.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Finish audition")!;
    assert.equal(table.hidden, false); assert.equal(receipt.hidden, false); assert.equal(keep.disabled, false);
    s.holdRead(); s.failRead();
    const comparison = view.querySelector<HTMLSelectElement>(".parameter-preview-heading select")!;
    comparison.value = s.base.id; comparison.dispatchEvent(new h.window.Event("change", { bubbles: true }));
    await waitForCondition(() => s.reads.length === 2, "Expected the selected version comparison");
    assert.equal(table.hidden, false); assert.equal(keep.disabled, true);
    s.release(); await h.settle();
    assert.match(view.textContent!, /Comparison read failed/);
    assert.equal(table.hidden, true); assert.equal(receipt.hidden, true);
    assert.ok([...receipt.querySelectorAll<HTMLButtonElement>("button")].every((button) => button.disabled));
    s.click("Refresh device parameters"); await h.settle();
    assert.equal(table.hidden, false); assert.equal(receipt.hidden, false); assert.equal(keep.disabled, false);
    assert.equal(commandCalls(h).some((call) => (call.body as { kind: string }).kind === "apply_device_parameters"), false); assert.deepEqual(h.errors, []);
  } finally { s.release(); await h.settle(); h.close(); }
});

test("capture uses the selected device identity and a label without sending raw values", async () => {
  const s = await setup(); const { h } = s;
  try {
    h.click("#artifactsShortcut"); h.click("#openArtifactsButton"); await h.settle();
    const details = h.document.querySelector<HTMLDetailsElement>(".parameter-capture")!; details.open = true;
    details.dispatchEvent(new h.window.Event("toggle"));
    await waitForCondition(() => (details.querySelector<HTMLSelectElement>("select")?.options.length ?? 0) === 2, "Expected observed capture destinations");
    const select = details.querySelector<HTMLSelectElement>("select")!; select.value = `${s.snapshot.target.trackId}:${s.snapshot.target.deviceId}`;
    select.dispatchEvent(new h.window.Event("change", { bubbles: true }));
    s.click("Save parameter snapshot"); await waitForCondition(() => commandCalls(h).length === 1, "Expected the capture command"); await h.settle();
    const { runtimeId, songId, trackId, deviceId } = s.snapshot.target;
    assert.deepEqual(commandCalls(h)[0]!.body, { kind: "capture_device_parameters", sessionId: s.base.sessionId, target: { runtimeId, songId, trackId, deviceId }, label: "Synth" });
  } finally { h.close(); }
});

test("changing versions aborts old Live reads and never applies their result to the new version", async () => {
  const s = await setup(); const { h } = s;
  try {
    await s.open(); s.holdRead(); s.click("Refresh device parameters");
    await waitForCondition(() => s.reads.length === 2, "Expected the held Live comparison");
    const held = s.reads[1]!;
    const version = h.document.querySelector<HTMLSelectElement>(".artifact-version-select")!;
    version.value = s.base.id; version.dispatchEvent(new h.window.Event("change", { bubbles: true }));
    await waitForCondition(() => held.signal?.aborted === true, "Expected cancellation of the previous version read"); s.release(); await h.settle();
    await waitForCondition(() => s.reads.some((read) => read.body.artifactId === s.base.id), "Expected the exact newly selected version");
    assert.match(h.document.querySelector(".artifact-card")!.textContent!, /Captured device parameters/);
    assert.equal(commandCalls(h).some((call) => (call.body as { kind: string }).kind === "apply_device_parameters"), false); assert.deepEqual(h.errors, []);
  } finally { s.release(); await h.settle(); h.close(); }
});

test("parameter capture and comparison controls use the current locale", async () => {
  const s = await setup({ language: "zh-CN" }); const { h } = s;
  try { await s.open(); assert.match(h.document.querySelector(".parameter-artifact-view")!.textContent!, /目标设备/); assert.match(h.document.querySelector(".parameter-artifact-view")!.textContent!, /试听/); assert.deepEqual(h.errors, []); }
  finally { h.close(); }
});

test("switching parameter works refreshes the destination receipt and opens its exact applied version", async () => {
  const s = await setup({ secondWork: true }); const { h } = s;
  try {
    await s.open(); s.click("Audition in Live"); await h.settle();
    h.click(`[data-artifact-key="device-parameters:${s.other.id}"]`); await h.settle();
    const receipt = h.document.querySelector<HTMLElement>(".parameter-application")!;
    assert.equal(receipt.hidden, false); assert.match(receipt.textContent!, /Last application: Soft synth · v2/);
    assert.equal(h.document.querySelectorAll(".artifact-card").length, 1);
    s.click("Open applied version"); await h.settle();
    assert.equal(h.document.querySelector<HTMLSelectElement>(".artifact-version-select")!.value, s.saved.id);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("pagehide aborts a pending version read and prevents late Live reads until pageshow", async () => {
  const s = await setup(); const { h } = s;
  try {
    await s.open(); s.holdVersion();
    h.select(".artifact-version-select", s.base.id);
    await waitForCondition(() => Boolean(s.versionSignal), "Expected the pending version read");
    const before = s.reads.length;
    h.window.dispatchEvent(new h.window.PageTransitionEvent("pagehide", { persisted: true }));
    assert.equal(s.versionSignal!.aborted, true); s.releaseVersion(); await h.settle();
    assert.equal(s.reads.length, before);
    h.window.dispatchEvent(new h.window.PageTransitionEvent("pageshow", { persisted: true }));
    await waitForCondition(() => s.reads.length > before, "Expected a fresh comparison after browser resume");
    assert.deepEqual(commandCalls(h), []);
  } finally { s.releaseVersion(); h.close(); }
});

test("chat parameter results retain their kind and refresh independently owned table translations", async () => {
  const s = await setup(); const { h } = s;
  try {
    const current = cloneState(h.readBootstrappedClientStateReference());
    current.events.push({ id: "parameter-result", kind: "tool_result", name: "present_device_parameter_candidates", outcome: "success", createdAt: s.saved.createdAt,
      content: JSON.stringify({ candidates: [{ kind: "device-parameters", artifactRef: s.saved.id, label: s.saved.label }] }), artifacts: [{ kind: "device-parameters", id: s.saved.id }] });
    h.setServerState(current); h.emitServerEvent({ type: "session_state_invalidated", sessionId: current.activeSessionId }); await h.settle();
    await waitForCondition(() => Boolean(h.document.querySelector("#timeline .parameter-table-view tbody tr")), "Expected the parameter result preview");
    assert.match(h.document.querySelector("#timeline")!.textContent!, /Sound comparison/);
    assert.doesNotMatch(h.document.querySelector("#timeline")!.textContent!, /Saved MIDI/);
    h.emitServerEvent({ type: "global_settings_changed", defaultFollowUpBehavior: s.state.settings.defaultFollowUpBehavior,
      defaultFollowUpBehaviorRevision: s.state.settings.defaultFollowUpBehaviorRevision, showContextUsage: s.state.settings.showContextUsage,
      contextUsageVisibilityRevision: s.state.settings.contextUsageVisibilityRevision, uiLanguage: "zh-CN", uiLanguageRevision: "1", commandId: "external-language" });
    await h.settle();
    const table = h.document.querySelector("#timeline .parameter-artifact-details > .parameter-table-view")!;
    assert.match(table.textContent!, /筛选参数/);
    const filter = table.querySelector<HTMLInputElement>('input[type="search"]')!;
    filter.value = "Parameter 299"; filter.dispatchEvent(new h.window.Event("input", { bubbles: true }));
    assert.equal(table.querySelectorAll("tbody tr").length, 1);
    assert.match(table.querySelector("thead")!.textContent!, /范围/); assert.deepEqual(h.errors, []);
    h.click("#timeline .parameter-artifact-details > summary"); s.click("打开作品", "#timeline .chat-parameter-candidates"); await h.settle();
    assert.equal(h.document.querySelector<HTMLSelectElement>(".artifact-version-select")!.value, s.saved.id);
    assert.deepEqual(commandCalls(h), []);
  } finally { h.close(); }
});

test("parameter cards show source once and rely on the saved receipt for a successful operation", async () => {
  const s = await setup(); const { h } = s;
  try {
    await s.open();
    const card = h.document.querySelector(".artifact-card")!;
    assert.equal((card.textContent!.match(/AI-proposed device parameters/g) ?? []).length, 1);
    const generation = [...card.querySelectorAll("details")].find((details) => details.querySelector("summary")?.textContent === "Generation parameters")!;
    assert.equal(generation.hidden, true);
    s.click("Audition in Live"); await h.settle();
    const view = card.querySelector(".parameter-artifact-view")!;
    assert.match(view.querySelector(".parameter-application")!.textContent!, /Last application: Soft synth · v2/);
    assert.equal(view.querySelector<HTMLElement>('.parameter-live-section > [role="status"]')!.hidden, true);
    assert.equal(view.querySelector<HTMLElement>(".parameter-application > .field-hint:last-of-type")!.hidden, true);
    s.click("Use this sound"); await h.settle();
    assert.match(view.querySelector(".parameter-application")!.textContent!, /Last application: Soft synth · v2 · kept/);
    s.click("Open original snapshot"); await h.settle();
    assert.equal(h.document.querySelector<HTMLSelectElement>(".artifact-version-select")!.value, s.base.id);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("binding and restoration errors localize while parameter names remain literal", async () => {
  const name = 'applied <Gain> {name}';
  const s = await setup({ unknown: true, language: "zh-CN",
    bindingError: uiMessage("The saved device binding belongs to another Live runtime. Choose the destination device explicitly."),
    restoreError: uiMessage('Parameter "{name}" changed after application. Restore was stopped to preserve the current edits.', { name }),
  });
  const { h } = s;
  try {
    await s.open(); const view = h.document.querySelector(".parameter-artifact-view")!;
    assert.match(view.textContent!, /原设备绑定已失效/); assert.ok(view.textContent!.includes(`参数“${name}”在应用后被修改`));
    const apply = [...view.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.getAttribute("aria-label") === "在 Live 中试听")!;
    assert.equal(apply.disabled, true);
    h.emitServerEvent({ type: "global_settings_changed", defaultFollowUpBehavior: s.state.settings.defaultFollowUpBehavior,
      defaultFollowUpBehaviorRevision: s.state.settings.defaultFollowUpBehaviorRevision, showContextUsage: s.state.settings.showContextUsage,
      contextUsageVisibilityRevision: s.state.settings.contextUsageVisibilityRevision, uiLanguage: "en", uiLanguageRevision: "1", commandId: "external-language" });
    await h.settle(); assert.match(view.textContent!, /another Live runtime/);
    assert.ok(view.textContent!.includes(`Parameter "${name}" changed after application`));
    assert.equal(view.querySelector("gain"), null); assert.deepEqual(commandCalls(h), []); assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("a translated HTTP preview failure retains its recovery message until retry succeeds", async () => {
  const s = await setup({ language: "zh-CN" }); const { h } = s;
  try {
    await s.open(); s.failRead(uiMessage("Saved device parameter data is invalid."));
    s.click("刷新设备参数"); await h.settle();
    const status = h.document.querySelector<HTMLElement>('.parameter-artifact-view [role="status"]')!;
    assert.equal(status.hidden, false); assert.equal(status.textContent, "保存的设备参数数据无效。");
    s.click("刷新设备参数"); await h.settle(); assert.equal(status.hidden, true);
    assert.deepEqual(commandCalls(h), []); assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("artifact observations retain their last confirmation while loading and clear on failed readback", async () => {
  const s = await setup(); const { h } = s;
  try {
    await s.open(); s.click('Audition in Live'); await h.settle();
    const view = h.document.querySelector<HTMLElement>('.parameter-workspace-view')!;
    const observed = view.querySelector<HTMLElement>('.parameter-observed')!;
    assert.equal(observed.hidden, false); assert.match(observed.textContent!, /match v2/);
    s.holdRead(); s.failRead(); s.click('Refresh device parameters'); await h.settle();
    assert.equal(observed.hidden, false); assert.equal(view.getAttribute('aria-busy'), 'true');
    s.release(); await h.settle();
    assert.equal(observed.hidden, true); assert.equal(observed.textContent, '');
    assert.equal(view.querySelector<HTMLElement>('.parameter-table-view')!.hidden, true);
    assert.equal(view.dataset.auditionCurrent, 'false');
    s.click('Refresh device parameters'); await h.settle();
    assert.equal(observed.hidden, false); assert.match(observed.textContent!, /match v2/);
    assert.deepEqual(h.errors, []);
  } finally { s.release(); h.close(); }
});

test("normal artifact Keep and Restore retain descriptive accessibility and exact command references", async () => {
  const s = await setup({ language: 'zh-CN' }); const { h } = s;
  try {
    await s.open(); s.click('在 Live 中试听'); await h.settle();
    const keep = [...h.document.querySelectorAll<HTMLButtonElement>('.parameter-live-section button')].find(button => button.textContent === '保留')!;
    const restore = [...h.document.querySelectorAll<HTMLButtonElement>('.parameter-live-section button')].find(button => button.textContent === '恢复')!;
    assert.ok(keep); assert.ok(restore); assert.equal(keep.getAttribute('aria-label'), '采用此音色'); assert.equal(restore.title, '恢复试听前状态');
    keep.click(); await h.settle();
    assert.deepEqual(commandCalls(h).at(-1)!.body, { kind: 'keep_device_parameters', sessionId: s.base.sessionId, applicationId: 'parameter_application' });
    restore.click(); await h.settle();
    assert.deepEqual(commandCalls(h).at(-1)!.body, { kind: 'restore_device_parameters', sessionId: s.base.sessionId, applicationId: 'parameter_application' });
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});
