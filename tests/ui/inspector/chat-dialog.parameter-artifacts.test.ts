import assert from "node:assert/strict";
import test from "node:test";
import { URL } from "node:url";
import { uiMessage, formatUiMessage, type UiMessage } from "../../../src/i18n/ui-message.js";
import type { DeviceParameterApplication, DeviceParameterArtifact } from "../../../src/agent/device-parameter-contracts.js";
import type { SessionArtifact } from "../../../src/app/session/session-artifacts.js";
import { captureParameterDevice } from "../../../src/live/device-parameters.js";
import { deviceParameterFixture } from "../../live/support/device-parameter-fixture.js";
import { cloneState, commandCalls, createDialogHarness, stateFixture, waitForCondition } from "../support/chat-dialog.test-harness.js";

async function setup(options: { unknown?: boolean; language?: "en" | "zh-CN"; secondWork?: boolean; bindingError?: UiMessage; restoreError?: UiMessage } = {}) {
  const state = stateFixture(); state.openSettingsOnLoad = false; state.settings.uiLanguage = options.language ?? "en";
  const live = deviceParameterFixture(300); const snapshot = await captureParameterDevice(live.context, live.target);
  const base: DeviceParameterArtifact = { ...snapshot, id: "parameters_base", sessionId: state.activeSessionId!, label: "Original synth", createdAt: "2026-10-09T00:00:00Z", version: { groupId: "parameters_base", number: 1 }, source: { kind: "captured" } };
  const saved: DeviceParameterArtifact = { ...base, id: "parameters_new", label: "Soft synth", version: { groupId: base.id, number: 2, derivedFromId: base.id },
    source: { kind: "model", profileId: "profile", model: "model" }, parameters: base.parameters.map((parameter) => parameter.index === 1 ? { ...parameter, value: 0.75 } : parameter) };
  const other: DeviceParameterArtifact = { ...base, id: "parameters_other", label: "Other synth work", version: { groupId: "parameters_other", number: 1 } };
  const all = [base, saved, other];
  const current = { ...snapshot, parameters: snapshot.parameters.map((parameter) => ({ ...parameter })) };
  const projection = (artifact: DeviceParameterArtifact, detail = false): SessionArtifact => ({ ref: { kind: "device-parameters", id: artifact.id }, label: artifact.label, createdAt: artifact.createdAt,
    sourceLabel: artifact.source.kind === "captured" ? "Captured device parameters" : "AI-proposed device parameters", version: { ...artifact.version, groupLabel: artifact.version.groupId === base.id ? base.label : artifact.label },
    versions: all.filter((entry) => entry.version.groupId === artifact.version.groupId).map((entry) => ({ id: entry.id, label: entry.label, number: entry.version.number, createdAt: entry.createdAt,
      ...(entry.version.derivedFromId ? { derivedFromId: entry.version.derivedFromId } : {}) })),
    deviceParameters: { target: artifact.target, parameterCount: artifact.parameters.length, source: artifact.source.kind, ...(detail ? { parameters: artifact.parameters } : {}) } });
  let application: DeviceParameterApplication | undefined = options.unknown ? {
    id: "parameter_application", sessionId: base.sessionId, artifactId: saved.id, createdAt: base.createdAt, target: base.target, status: "partial",
    artifactLabel: saved.label, artifactVersion: saved.version.number,
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
      return { ok: true, json: async () => ({ sessionId: base.sessionId, devices: [snapshot.target],
        ...(body.artifactId ? { artifact: all.find((entry) => entry.id === body.artifactId), ...(options.bindingError ? { bindingError: options.bindingError } : { current }),
          ...(body.baseArtifactId || body.artifactId === saved.id ? { comparison: all.find((entry) => entry.id === (body.baseArtifactId ?? base.id)) } : {}) } : {}),
        ...(application ? { application } : {}), ...(options.restoreError ? { restoreError: options.restoreError } : {}) }) };
    }
    if (path === "/command") {
      if (body.kind === "apply_device_parameters") current.parameters[1]!.value = 0.75;
      if (body.kind === "apply_device_parameters") application = { id: "parameter_application", sessionId: base.sessionId, artifactId: body.artifactId, createdAt: base.createdAt,
        artifactLabel: saved.label, artifactVersion: saved.version.number,
        target: base.target, status: "applied", entries: [{ parameter: base.parameters[1]!, requested: 0.75, state: "applied", after: 0.75 }] };
      if (body.kind === "restore_device_parameters" && application) { application.status = "restored"; application.entries[0]!.state = "restored"; }
      if (body.kind === "keep_device_parameters" && application) application.status = "kept";
    }
    return original(input, init);
  } });
  const open = async () => {
    h.click("#artifactsTab"); await waitForCondition(() => Boolean(h.document.querySelector(".artifact-open")), "Expected the saved parameter work");
    h.click(".artifact-open"); await waitForCondition(() => h.document.querySelectorAll(".artifact-card .parameter-table-view:first-of-type tbody tr").length === 300 ||
      [...h.document.querySelectorAll(".artifact-card .parameter-table-view tbody")].some((body) => body.children.length === 300), "Expected every saved parameter in the preview");
  };
  const click = (text: string, root = "#artifactLibrary") => {
    const button = [...h.document.querySelectorAll<HTMLButtonElement>(`${root} button`)].find((button) => button.textContent === text);
    assert.ok(button, text); assert.equal(button.disabled, false, text); button.click();
  };
  return { h, state, base, saved, other, snapshot, open, click, reads,
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
    s.click("Apply to Live"); await waitForCondition(() => commandCalls(h).length === 1, "Expected the apply command"); await h.settle();
    assert.deepEqual(commandCalls(h)[0]!.body, { kind: "apply_device_parameters", sessionId: s.base.sessionId, artifactId: s.saved.id });
    await waitForCondition(() => [...h.document.querySelectorAll<HTMLButtonElement>(".parameter-application button")].some((button) => button.textContent === "Restore previous values" && !button.disabled), "Expected the saved application receipt");
    s.click("Restore previous values"); await waitForCondition(() => commandCalls(h).length === 2, "Expected the restore command"); await h.settle();
    assert.deepEqual(commandCalls(h)[1]!.body, { kind: "restore_device_parameters", sessionId: s.base.sessionId, applicationId: "parameter_application" });
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("unknown writes disable restore and remain inspectable after reloading the artifact", async () => {
  const s = await setup({ unknown: true }); const { h } = s;
  try {
    await s.open();
    const restore = [...h.document.querySelectorAll<HTMLButtonElement>(".parameter-application button")].find((button) => button.textContent === "Restore previous values")!;
    const details = h.document.querySelector<HTMLDetailsElement>(".parameter-application details")!;
    details.open = true; details.dispatchEvent(new h.window.Event("toggle"));
    assert.equal(restore.disabled, true); assert.match(h.document.querySelector(".parameter-application")!.textContent!, /Write not confirmed/);
    assert.deepEqual(commandCalls(h), []);
    s.click("Keep current values"); await waitForCondition(() => commandCalls(h).length === 1, "Expected explicit Keep"); await h.settle();
    assert.deepEqual(commandCalls(h)[0]!.body, { kind: "keep_device_parameters", sessionId: s.base.sessionId, applicationId: "parameter_application" });
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
    const keep = [...receipt.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Keep current values")!;
    assert.equal(table.hidden, false); assert.equal(receipt.hidden, false); assert.equal(keep.disabled, false);
    s.holdRead(); s.failRead();
    const comparison = view.querySelectorAll<HTMLSelectElement>(":scope > label select")[1]!;
    comparison.value = s.base.id; comparison.dispatchEvent(new h.window.Event("change", { bubbles: true }));
    await waitForCondition(() => s.reads.length === 2, "Expected the selected version comparison");
    assert.equal(table.hidden, true); assert.equal(keep.disabled, true);
    s.release(); await h.settle();
    assert.match(view.textContent!, /Comparison read failed/);
    assert.equal(table.hidden, true); assert.equal(receipt.hidden, true);
    assert.ok([...receipt.querySelectorAll<HTMLButtonElement>("button")].every((button) => button.disabled));
    s.click("Refresh device parameters"); await h.settle();
    assert.equal(table.hidden, false); assert.equal(receipt.hidden, false); assert.equal(keep.disabled, false);
    assert.deepEqual(commandCalls(h), []); assert.deepEqual(h.errors, []);
  } finally { s.release(); h.close(); }
});

test("capture uses the selected device identity and a label without sending raw values", async () => {
  const s = await setup(); const { h } = s;
  try {
    h.click("#artifactsTab"); await h.settle();
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
    assert.deepEqual(commandCalls(h), []); assert.deepEqual(h.errors, []);
  } finally { s.release(); h.close(); }
});

test("parameter capture and comparison controls use the current locale", async () => {
  const s = await setup({ language: "zh-CN" }); const { h } = s;
  try { await s.open(); assert.match(h.document.querySelector(".parameter-artifact-view")!.textContent!, /目标设备/); assert.match(h.document.querySelector(".parameter-artifact-view")!.textContent!, /应用到 Live/); assert.deepEqual(h.errors, []); }
  finally { h.close(); }
});

test("parameter commands refresh every open work and identify the exact applied version", async () => {
  const s = await setup({ secondWork: true }); const { h } = s;
  const first = `#artifact-group-device-parameters-${s.base.id}`;
  const second = `#artifact-group-device-parameters-${s.other.id}`;
  try {
    await s.open(); h.click(`[data-artifact-key="device-parameters:${s.other.id}"]`);
    await waitForCondition(() => s.reads.some((read) => read.body.artifactId === s.other.id), "Expected the second comparison"); await h.settle();
    s.click("Apply to Live", first); await h.settle();
    await waitForCondition(() => s.reads.filter((read) => read.body.artifactId === s.other.id).length > 1, "Expected receipt invalidation across cards");
    const receipt = h.document.querySelector<HTMLElement>(`${second} .parameter-application`)!;
    assert.equal(receipt.hidden, false); assert.match(receipt.textContent!, /Applied version: Soft synth · v2/);
    const firstReceipt = h.document.querySelector<HTMLElement>(`${first} .parameter-application`)!;
    const openButton = (parent: ParentNode) => [...parent.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Open applied version")!;
    assert.equal(openButton(firstReceipt).hidden, true); assert.equal(openButton(receipt).hidden, false);
    const otherApply = [...h.document.querySelectorAll<HTMLButtonElement>(`${second} button`)].find((button) => button.textContent === "Apply to Live")!;
    assert.equal(otherApply.disabled, true);
    s.click("Keep current values", first); await h.settle();
    await waitForCondition(() => !otherApply.disabled, "Expected other cards to allow Apply after Keep");
    s.click("Open applied version", second); await h.settle();
    assert.equal(h.document.querySelector<HTMLSelectElement>(`${first} .artifact-version-select`)!.value, s.saved.id);
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
    current.events.push({ id: "parameter-result", kind: "tool_result", name: "save_device_parameter_artifact", outcome: "success", createdAt: s.saved.createdAt,
      content: JSON.stringify({ artifacts: [{ kind: "device-parameters", artifactRef: s.saved.id, label: s.saved.label }] }), artifacts: [{ kind: "device-parameters", id: s.saved.id }] });
    h.setServerState(current); h.emitServerEvent({ type: "session_state_invalidated", sessionId: current.activeSessionId }); await h.settle();
    await waitForCondition(() => Boolean(h.document.querySelector("#timeline .parameter-table-view tbody tr")), "Expected the parameter result preview");
    assert.match(h.document.querySelector("#timeline")!.textContent!, /Saved device parameters/);
    assert.doesNotMatch(h.document.querySelector("#timeline")!.textContent!, /Saved MIDI/);
    h.emitServerEvent({ type: "global_settings_changed", defaultFollowUpBehavior: s.state.settings.defaultFollowUpBehavior,
      defaultFollowUpBehaviorRevision: s.state.settings.defaultFollowUpBehaviorRevision, showContextUsage: s.state.settings.showContextUsage,
      contextUsageVisibilityRevision: s.state.settings.contextUsageVisibilityRevision, uiLanguage: "zh-CN", uiLanguageRevision: "1", commandId: "external-language" });
    await h.settle();
    const table = h.document.querySelector("#timeline .parameter-table-view")!;
    assert.match(table.textContent!, /筛选参数/);
    assert.equal(table.querySelector<HTMLInputElement>('input[type="checkbox"]')!.closest("label")!.hidden, true);
    assert.equal(table.querySelectorAll<HTMLTableCellElement>("thead th")[1]!.hidden, true);
    assert.match(table.querySelector("thead")!.textContent!, /范围/); assert.deepEqual(h.errors, []);
    const controls = h.document.querySelector("#timeline .chat-midi-preview .artifact-actions")!;
    assert.deepEqual([...controls.querySelectorAll("button")].map((button) => button.textContent), ["打开作品"]);
    (controls.querySelector("button") as HTMLButtonElement).click(); await h.settle();
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
    s.click("Apply to Live"); await h.settle();
    const view = card.querySelector(".parameter-artifact-view")!;
    assert.match(view.querySelector(".parameter-application")!.textContent!, /Applied version: Soft synth · v2/);
    assert.equal(view.querySelector<HTMLElement>(':scope > [role="status"]')!.hidden, true);
    assert.equal(view.querySelector<HTMLElement>(".parameter-application > .field-hint:last-of-type")!.hidden, true);
    s.click("Keep current values"); await h.settle();
    assert.equal([...view.querySelectorAll<HTMLButtonElement>(".parameter-application button")].filter((button) => !button.hidden).length, 0);
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
    const apply = [...view.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "应用到 Live")!;
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
    const status = h.document.querySelector<HTMLElement>('.parameter-artifact-view > [role="status"]')!;
    assert.equal(status.hidden, false); assert.equal(status.textContent, "保存的设备参数数据无效。");
    s.click("刷新设备参数"); await h.settle(); assert.equal(status.hidden, true);
    assert.deepEqual(commandCalls(h), []); assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});
