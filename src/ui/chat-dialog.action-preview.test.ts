import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import type { MidiActionPreview, ParameterActionPreview } from "../agent/action-preview.js";
import {
  cloneState,
  commandCalls,
  createDialogHarness,
  jsonCalls,
  stateFixture,
  waitForCondition,
  type DialogHarness,
} from "./chat-dialog.test-harness.js";

function midiPreview(): MidiActionPreview {
  return {
    kind: "midi-notes",
    actionIndex: 0,
    status: "proposed",
    targetLabel: "Bass clip",
    range: { coordinate: "clip-beats", start: 0, end: 8 },
    before: {
      notes: [
        { pitch: 36, startTime: 0, duration: 1, velocity: 95, muted: false, probability: 0.75, velocityDeviation: 5, releaseVelocity: 64, selected: true },
        { pitch: 43, startTime: 2, duration: 0.5 },
      ],
      totalNoteCount: 2,
      omittedNoteCount: 0,
    },
    after: {
      notes: [
        { pitch: 38, startTime: 0, duration: 1, velocity: 95 },
        { pitch: 45, startTime: 2, duration: 0.5, muted: true },
        { pitch: 50, startTime: 4, duration: 2 },
      ],
      totalNoteCount: 3,
      omittedNoteCount: 0,
    },
  };
}

function midiPreviewWithNote(side: "before" | "after", startTime: number, duration: number): MidiActionPreview {
  const preview = midiPreview();
  preview[side].notes[0] = { ...preview[side].notes[0]!, startTime, duration };
  return preview;
}

function parameterPreview(): ParameterActionPreview {
  return {
    kind: "parameter-value",
    actionIndex: 0,
    status: "proposed",
    targetLabel: "Bass device",
    parameterName: "Gain",
    before: 0.234567891,
    after: 0.789123456,
    minimum: -2,
    maximum: 4,
  };
}

async function pendingSend(t: TestContext): Promise<DialogHarness> {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  harness.holdNextSend();
  t.after(async () => {
    harness.releaseHeldSend();
    await harness.settle();
    harness.close();
  });
  harness.input("#prompt", "Prepare a change for review");
  harness.click("#sendButton");
  await waitForCondition(() => harness.sendIds.length === 1, "Expected the confirmation's owning Send");
  return harness;
}

function confirmation(harness: DialogHarness, overrides: Record<string, unknown> = {}) {
  return {
    type: "confirm_request",
    sendId: harness.sendIds[0],
    sessionId: "session-1",
    modelTurnEpoch: 0,
    id: "preview-confirmation-1",
    confirmationGeneration: 1,
    kind: "apply",
    message: "Review this proposed change.",
    groups: [{ title: "Write MIDI", rows: ["1. Update notes in the Bass clip"] }],
    ...overrides,
  };
}

function element<T extends Element = HTMLElement>(harness: DialogHarness, selector: string): T {
  const result = harness.document.querySelector<T>(selector);
  assert.ok(result, `Expected ${selector}`);
  return result;
}

function renderedRows(harness: DialogHarness): string[] {
  return [...harness.document.querySelectorAll(".confirm-rows li")].map((row) => row.textContent ?? "");
}

test("MIDI confirmation shows proposed accessible before and after notes while retaining complete action details", async (t) => {
  const harness = await pendingSend(t);
  const preview = midiPreview();
  preview.targetLabel = '低音 <img src="x" onerror="alert(1)"> & <take>';
  const request = confirmation(harness, { previews: [preview] });
  harness.emitServerEvent(request);
  await harness.settle();

  const article = element(harness, "article.action-preview");
  assert.ok(article.closest(".confirm-card"));
  assert.ok(article.textContent?.includes(preview.targetLabel));
  assert.equal(article.querySelector("img, take, script"), null);
  assert.match(article.textContent ?? "", /proposed/i);
  assert.equal(harness.document.querySelectorAll(".action-preview").length, 1);
  for (const name of ["before", "after"] as const) {
    const side = element(harness, `.midi-preview-side[data-side="${name}"]`);
    const svg = side.querySelector("svg[role=img]");
    assert.ok(svg);
    assert.match(svg.getAttribute("aria-label") ?? "", new RegExp(`\\b${preview[name].totalNoteCount} notes?\\b`, "i"));
    assert.match(svg.getAttribute("aria-label") ?? "", /clip beats/i);
    assert.equal(side.querySelectorAll(".midi-preview-note").length, preview[name].notes.length);
    assert.equal(side.querySelector(".preview-limits"), null);
  }
  assert.deepEqual(renderedRows(harness), ["1. Update notes in the Bass clip"]);
  assert.deepEqual(jsonCalls(harness, "/confirm"), []);
  assert.equal(jsonCalls(harness, "/send").length, 1);
  assert.deepEqual(commandCalls(harness), []);
  assert.deepEqual(cloneState(harness.readBootstrappedClientStateReference()).events, []);
  assert.deepEqual(harness.errors, []);
});

test("a bounded MIDI preview reports full counts and omissions without drawing omitted notes", async (t) => {
  const harness = await pendingSend(t);
  const preview = midiPreview();
  preview.range.end = 64;
  preview.before = {
    notes: Array.from({ length: 256 }, (_, index) => ({ pitch: 36 + index % 48, startTime: index / 4, duration: 0.125 })),
    totalNoteCount: 300,
    omittedNoteCount: 44,
  };
  preview.after = { notes: [], totalNoteCount: 0, omittedNoteCount: 0 };
  harness.emitServerEvent(confirmation(harness, { previews: [preview] }));
  await harness.settle();

  const before = element(harness, '.midi-preview-side[data-side="before"]');
  const after = element(harness, '.midi-preview-side[data-side="after"]');
  assert.equal(before.querySelectorAll(".midi-preview-note").length, 256);
  assert.match(before.querySelector("svg[role=img]")?.getAttribute("aria-label") ?? "", /\b300 notes\b/);
  assert.match(before.querySelector(".preview-limits")?.textContent ?? "", /\b44 notes omitted\b/i);
  assert.match(before.querySelector(".preview-limits")?.textContent ?? "", /\b256\b/);
  assert.match(before.querySelector(".preview-limits")?.textContent ?? "", /\b300\b/);
  assert.equal(after.querySelectorAll(".midi-preview-note").length, 0);
  assert.match(after.querySelector("svg[role=img]")?.getAttribute("aria-label") ?? "", /\b0 notes\b/);
  assert.equal(after.querySelector(".preview-limits"), null);
  assert.deepEqual(jsonCalls(harness, "/confirm"), []);
  assert.deepEqual(harness.errors, []);
});

test("empty MIDI sides remain accessible without inventing note marks", async (t) => {
  const harness = await pendingSend(t);
  const preview = midiPreview();
  preview.before = { notes: [], totalNoteCount: 0, omittedNoteCount: 0 };
  preview.after = { notes: [], totalNoteCount: 0, omittedNoteCount: 0 };
  harness.emitServerEvent(confirmation(harness, { previews: [preview] }));
  await harness.settle();
  for (const name of ["before", "after"]) {
    const side = element(harness, `.midi-preview-side[data-side="${name}"]`);
    assert.match(side.querySelector("svg[role=img]")?.getAttribute("aria-label") ?? "", /\b0 notes\b/);
    assert.equal(side.querySelectorAll(".midi-preview-note").length, 0);
    assert.equal(side.querySelector(".preview-limits"), null);
  }
  assert.deepEqual(harness.errors, []);
});

test("MIDI note endpoints within the floating-point tolerance remain visible on both sides", async (t) => {
  const harness = await pendingSend(t);
  const preview = midiPreview();
  for (const side of ["before", "after"] as const) {
    preview[side].notes[0] = { ...preview[side].notes[0]!, startTime: 7, duration: 1 + 5e-8 };
  }
  harness.emitServerEvent(confirmation(harness, { previews: [preview] }));
  await harness.settle();
  assert.ok(harness.document.querySelector("article.action-preview"));
  for (const name of ["before", "after"] as const) {
    const side = element(harness, `.midi-preview-side[data-side="${name}"]`);
    assert.equal(side.querySelectorAll(".midi-preview-note").length, preview[name].notes.length);
    assert.match(side.querySelector("svg[role=img]")?.getAttribute("aria-label") ?? "", new RegExp(`\\b${preview[name].totalNoteCount} notes?\\b`, "i"));
    assert.equal(side.querySelector(".preview-limits"), null);
  }
  assert.deepEqual(jsonCalls(harness, "/confirm"), []);
  assert.deepEqual(harness.errors, []);
});

test("numeric preview preserves raw values and ranges without guessing units", async (t) => {
  const harness = await pendingSend(t);
  const preview = parameterPreview();
  preview.parameterName = "Gain <em>raw</em>";
  harness.emitServerEvent(confirmation(harness, {
    previews: [preview],
    groups: [{ title: "Set Parameters", rows: ["1. Set the observed Gain parameter"] }],
  }));
  await harness.settle();
  const article = element(harness, "article.action-preview");
  const values = element(harness, ".parameter-preview-values").textContent ?? "";
  const range = article.querySelector(".preview-coordinate")?.textContent ?? "";
  assert.ok(values.includes(String(preview.before)));
  assert.ok(values.includes(String(preview.after)));
  assert.ok(range.includes(String(preview.minimum)));
  assert.ok(range.includes(String(preview.maximum)));
  assert.ok(article.textContent?.includes(preview.parameterName));
  assert.equal(article.querySelector("em"), null);
  assert.doesNotMatch(article.textContent ?? "", /\bdB\b|\bHz\b|%/i);
  assert.match(article.textContent ?? "", /proposed/i);
  assert.equal(article.querySelector("svg"), null);
  assert.deepEqual(renderedRows(harness), ["1. Set the observed Gain parameter"]);
  assert.deepEqual(jsonCalls(harness, "/confirm"), []);
  assert.deepEqual(harness.errors, []);
});

test("up to 12 quantized parameter labels remain observed metadata rather than numeric index mappings", async (t) => {
  const harness = await pendingSend(t);
  const preview = parameterPreview();
  const valueItems = [
    { name: "Quiet <option>", shortName: "Q" },
    { name: "Loud", shortName: "L" },
    ...Array.from({ length: 10 }, (_, index) => ({ name: `Observed mode ${index + 3}`, shortName: `M${index + 3}` })),
  ];
  Object.assign(preview, {
    parameterName: "Mode", before: 10, after: 20, minimum: 10, maximum: 20, isQuantized: true,
    valueItems,
  });
  harness.emitServerEvent(confirmation(harness, {
    previews: [preview],
    groups: [{ title: "Set Parameters", rows: ["1. Set the observed Mode value"] }],
  }));
  await harness.settle();
  const values = element(harness, ".parameter-preview-values").textContent ?? "";
  assert.match(values, /\b10\b/);
  assert.match(values, /\b20\b/);
  assert.doesNotMatch(values, /Quiet|Loud/);
  const article = element(harness, "article.action-preview");
  assert.equal(article.querySelector("option"), null);
  assert.deepEqual([...article.querySelectorAll("details li")].map((item) => item.textContent), valueItems.map((item) => item.name));
  assert.deepEqual(harness.errors, []);
});

test("a multi-action confirmation rejects a partial preview and keeps every group and row when previews are omitted", async (t) => {
  const harness = await pendingSend(t);
  const groups = [
    { title: "Write MIDI", rows: ["1. Transpose the Bass clip", "2. Quantize the same clip"] },
    { title: "Set Parameters", rows: ["3. Set the track volume"] },
  ];
  harness.emitServerEvent(confirmation(harness, { groups, previews: [midiPreview()] }));
  await harness.settle();
  assert.equal(harness.document.querySelector(".confirm-card"), null);
  harness.emitServerEvent(confirmation(harness, { groups }));
  await harness.settle();
  assert.ok(harness.document.querySelector(".confirm-card"));
  assert.equal(harness.document.querySelector(".action-preview"), null);
  assert.deepEqual(renderedRows(harness), groups.flatMap((group) => group.rows));
  assert.deepEqual([...harness.document.querySelectorAll(".confirm-group-title")].map((heading) => heading.textContent), groups.map((group) => group.title));
  assert.equal(element<HTMLButtonElement>(harness, ".confirm-card button.primary").disabled, false);
  assert.equal(element<HTMLButtonElement>(harness, "[data-confirm-cancel]").disabled, false);
  assert.deepEqual(jsonCalls(harness, "/confirm"), []);
  assert.deepEqual(harness.errors, []);
});

test("Apply still sends only the confirmation ID and decision and preview facts do not become execution results", async (t) => {
  const harness = await pendingSend(t);
  harness.emitServerEvent(confirmation(harness, { previews: [parameterPreview()] }));
  await harness.settle();
  assert.ok(harness.document.querySelector(".action-preview"));
  harness.holdNextConfirmation();
  let held = true;
  try {
    harness.click(".confirm-card button.primary");
    await harness.settle();
    assert.deepEqual(jsonCalls(harness, "/confirm"), [{ path: "/confirm", body: { id: "preview-confirmation-1", apply: true } }]);
    assert.equal(element<HTMLButtonElement>(harness, ".confirm-card button.primary").disabled, true);
    assert.equal(element<HTMLButtonElement>(harness, "[data-confirm-cancel]").disabled, true);
    harness.releaseHeldConfirmation();
    held = false;
    await harness.settle();
    assert.equal(harness.document.querySelector(".action-preview"), null);
    assert.equal(harness.document.querySelector(".confirm-card"), null);
    assert.deepEqual(cloneState(harness.readBootstrappedClientStateReference()).events, []);
    harness.emitServerEvent({
      type: "session_event", sendId: harness.sendIds[0], sessionId: "session-1",
      event: { id: "actual-result", kind: "apply_result", content: "The parameter write completed.", createdAt: "2026-09-05T00:00:00.000Z" },
    });
    await harness.settle();
    assert.ok(element(harness, '[data-event-id="actual-result"]').textContent?.includes("The parameter write completed."));
    assert.equal(harness.document.querySelector(".action-preview"), null);
    assert.equal(jsonCalls(harness, "/send").length, 1);
    assert.deepEqual(commandCalls(harness), []);
    assert.deepEqual(harness.errors, []);
  } finally {
    if (held) harness.releaseHeldConfirmation();
  }
});

test("Cancel and a fresh confirmation generation do not retain the old preview or accept its delayed replay", async (t) => {
  const harness = await pendingSend(t);
  const first = confirmation(harness, { previews: [midiPreview()] });
  harness.emitServerEvent(first);
  const delayedReplay = harness.deferServerEvent(first);
  await harness.settle();
  assert.ok(harness.document.querySelector(".action-preview"));
  harness.click("[data-confirm-cancel]");
  await harness.settle();
  assert.deepEqual(jsonCalls(harness, "/confirm"), [{ path: "/confirm", body: { id: "preview-confirmation-1", apply: false } }]);
  assert.equal(harness.document.querySelector(".confirm-card"), null);
  assert.equal(harness.document.querySelector(".action-preview"), null);
  harness.emitRawServerEvent(delayedReplay);
  await harness.settle();
  assert.equal(harness.document.querySelector(".confirm-card"), null);

  const rows = ["1. Rename the track", "2. Change its mixer value"];
  harness.emitServerEvent(confirmation(harness, {
    id: "preview-confirmation-2", confirmationGeneration: 2,
    groups: [{ title: "Changes", rows }],
  }));
  await harness.settle();
  assert.ok(harness.document.querySelector(".confirm-card"));
  assert.equal(harness.document.querySelector(".action-preview"), null);
  assert.deepEqual(renderedRows(harness), rows);
  assert.deepEqual(cloneState(harness.readBootstrappedClientStateReference()).events, []);
  assert.equal(jsonCalls(harness, "/confirm").length, 1);
  assert.deepEqual(harness.errors, []);
});

test("a newer proposed preview replaces the prior generation and older replay cannot put it back", async (t) => {
  const harness = await pendingSend(t);
  const first = confirmation(harness, { previews: [midiPreview()] });
  harness.emitServerEvent(first);
  const replay = harness.deferServerEvent(first);
  const second = parameterPreview();
  second.targetLabel = "Lead device, refreshed observation";
  harness.emitServerEvent(confirmation(harness, {
    id: "preview-confirmation-2", confirmationGeneration: 2, previews: [second],
    groups: [{ title: "Set Parameters", rows: ["1. Set Lead device Gain"] }],
  }));
  await harness.settle();
  assert.equal(harness.document.querySelectorAll(".action-preview").length, 1);
  assert.ok(element(harness, ".action-preview").textContent?.includes(second.targetLabel));
  assert.equal(harness.document.querySelector(".midi-preview-side"), null);
  harness.emitRawServerEvent(replay);
  await harness.settle();
  assert.ok(element(harness, ".action-preview").textContent?.includes(second.targetLabel));
  assert.equal(harness.document.querySelector(".midi-preview-side"), null);
  assert.deepEqual(renderedRows(harness), ["1. Set Lead device Gain"]);
  assert.deepEqual(jsonCalls(harness, "/confirm"), []);
  assert.deepEqual(harness.errors, []);
});

test("same-generation replay cannot change or remove the preview attached to that confirmation", async (t) => {
  const harness = await pendingSend(t);
  const original = parameterPreview();
  const request = confirmation(harness, { previews: [original] });
  harness.emitServerEvent(request);
  await harness.settle();
  const originalText = element(harness, ".action-preview").textContent;
  const changed = cloneState(original);
  changed.after = 3;
  changed.targetLabel = "Unrelated device";
  for (const replay of [
    { ...request, previews: [changed] },
    confirmation(harness),
    cloneState(request),
  ]) {
    harness.emitServerEvent(replay);
    await harness.settle();
    assert.equal(harness.document.querySelectorAll(".action-preview").length, 1);
    assert.equal(element(harness, ".action-preview").textContent, originalText);
  }
  assert.deepEqual(jsonCalls(harness, "/confirm"), []);
  assert.deepEqual(harness.errors, []);
});

const malformedPreviews: Array<[string, () => unknown]> = [
  ["unknown preview fields", () => [{ ...midiPreview(), targetHandle: 123 }]],
  ["unknown note fields", () => {
    const preview = midiPreview();
    return [{ ...preview, before: { ...preview.before, notes: preview.before.notes.map((note) => ({ ...note, noteId: "opaque-note" })) } }];
  }],
  ["a before-note wholly outside the beat range", () => [midiPreviewWithNote("before", 8, 1)]],
  ["a negative note start", () => [midiPreviewWithNote("before", -0.25, 1)]],
  ["a note crossing the end of the beat range", () => [midiPreviewWithNote("before", 7.5, 1)]],
  ["an after-note outside the beat range", () => [midiPreviewWithNote("after", 9, 0.5)]],
  ["a note starting at the range end despite a duration below the endpoint tolerance", () => [midiPreviewWithNote("before", 8, 1e-8)]],
  ["inconsistent omitted counts", () => {
    const preview = midiPreview();
    return [{ ...preview, after: { ...preview.after, omittedNoteCount: 1 } }];
  }],
  ["total count below the displayed count", () => {
    const preview = midiPreview();
    return [{ ...preview, before: { ...preview.before, totalNoteCount: 1 } }];
  }],
  ["fractional note counts", () => {
    const preview = midiPreview();
    return [{ ...preview, before: { ...preview.before, totalNoteCount: 2.5, omittedNoteCount: 0.5 } }];
  }],
  ["more than 256 notes on one side", () => {
    const preview = midiPreview();
    return [{ ...preview, before: {
      notes: Array.from({ length: 257 }, (_, index) => ({ pitch: 60, startTime: index / 64, duration: 0.125 })),
      totalNoteCount: 257, omittedNoteCount: 0,
    } }];
  }],
  ["multiple previews", () => [midiPreview(), parameterPreview()]],
  ["an empty previews array", () => []],
  ["a nonzero action index", () => [{ ...midiPreview(), actionIndex: 1 }]],
  ["an actual rather than proposed status", () => [{ ...midiPreview(), status: "applied" }]],
  ["non-clip coordinates", () => [{ ...midiPreview(), range: { coordinate: "arrangement-beats", start: 0, end: 8 } }]],
  ["an empty beat range", () => [{ ...midiPreview(), range: { coordinate: "clip-beats", start: 0, end: 0 } }]],
  ["nonfinite parameter values", () => [{ ...parameterPreview(), before: Number.POSITIVE_INFINITY }]],
  ["parameter values outside the observed range", () => [{ ...parameterPreview(), after: 5 }]],
  ["invented enum value mappings", () => [{ ...parameterPreview(), isQuantized: true, valueItems: [{ name: "Low", shortName: "L", value: 0 }] }]],
  ["more than 12 observed parameter labels", () => [{
    ...parameterPreview(), isQuantized: true,
    valueItems: Array.from({ length: 13 }, (_, index) => ({ name: `Mode ${index}`, shortName: `M${index}` })),
  }]],
];

for (const [label, previews] of malformedPreviews) {
  test(`a correlated confirmation with ${label} is rejected before consuming its generation`, async (t) => {
    const harness = await pendingSend(t);
    harness.emitServerEvent(confirmation(harness, { previews: previews() }));
    await harness.settle();
    assert.equal(harness.document.querySelector(".confirm-card"), null);
    assert.equal(harness.document.querySelector(".action-preview"), null);
    assert.deepEqual(jsonCalls(harness, "/confirm"), []);
    assert.deepEqual(cloneState(harness.readBootstrappedClientStateReference()).events, []);
    harness.emitServerEvent(confirmation(harness, { previews: [midiPreview()] }));
    await harness.settle();
    assert.ok(harness.document.querySelector("article.action-preview"));
    assert.deepEqual(renderedRows(harness), ["1. Update notes in the Bass clip"]);
    assert.equal(element<HTMLButtonElement>(harness, ".confirm-card button.primary").disabled, false);
    assert.deepEqual(jsonCalls(harness, "/confirm"), []);
    assert.deepEqual(harness.errors, []);
  });
}

test("a malformed next generation cannot clear the currently reviewable preview", async (t) => {
  const harness = await pendingSend(t);
  harness.emitServerEvent(confirmation(harness, { previews: [midiPreview()] }));
  await harness.settle();
  const originalText = element(harness, ".action-preview").textContent;
  harness.emitServerEvent(confirmation(harness, {
    id: "preview-confirmation-2", confirmationGeneration: 2,
    previews: [{ ...parameterPreview(), unexpected: true }],
  }));
  await harness.settle();
  assert.equal(element(harness, ".action-preview").textContent, originalText);
  assert.equal(element<HTMLButtonElement>(harness, ".confirm-card button.primary").disabled, false);
  harness.click("[data-confirm-cancel]");
  await harness.settle();
  assert.deepEqual(jsonCalls(harness, "/confirm"), [{ path: "/confirm", body: { id: "preview-confirmation-1", apply: false } }]);
  assert.deepEqual(harness.errors, []);
});

test("recovery confirmation cannot carry a proposed action preview", async (t) => {
  const harness = await pendingSend(t);
  const recovery = confirmation(harness, { kind: "resolve_recovery", groups: [] });
  harness.emitServerEvent({ ...recovery, previews: [midiPreview()] });
  await harness.settle();
  assert.equal(harness.document.querySelector(".confirm-card"), null);
  harness.emitServerEvent(recovery);
  await harness.settle();
  assert.ok(harness.document.querySelector(".confirm-card"));
  assert.equal(harness.document.querySelector(".action-preview"), null);
  assert.deepEqual(jsonCalls(harness, "/confirm"), []);
  assert.deepEqual(harness.errors, []);
});
