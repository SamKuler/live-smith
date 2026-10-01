import assert from "node:assert/strict";
import test from "node:test";

import { agentActionPromptExamples, parseAgentAction } from "../../src/agent/action-schema.js";
import { actionDiffGroups } from "../../src/ui/action-diff.js";
import { actionMessages } from "../../src/ui/i18n/action-messages.js";
import { formatUiMessage, uiMessage, type UiMessage, type UiMessageValues } from "../../src/ui/i18n/ui-message.js";

test("English message formatting binds parameters and never interprets raw strings", () => {
  const raw = 'Delete <span data-i18n="Song">{name} $& ${value}</span>';
  const values: UiMessageValues = { name: raw };
  const nested = uiMessage('track "{name}"', values);
  values.name = "Changed after binding";
  const message = uiMessage("{description}: {number} / {enabled} / {missing}", {
    description: nested, number: 0, enabled: false,
  });
  assert.equal(formatUiMessage(raw), raw);
  assert.equal(formatUiMessage("Delete"), "Delete");
  assert.equal(formatUiMessage(message), `track "${raw}": 0 / false / {missing}`);
  assert.equal(formatUiMessage(JSON.parse(JSON.stringify(message))), formatUiMessage(message));
  assert.equal(formatUiMessage(uiMessage("{constructor} {toString}")), "{constructor} {toString}");
});

test("every registered action builds complete catalogued messages within the wire descriptor limits", () => {
  const actions = agentActionPromptExamples().map((example) =>
    parseAgentAction(JSON.parse(example.slice(example.indexOf(": ") + 2))));
  const original = JSON.stringify(actions);
  const groups = actionDiffGroups(actions);
  const rows = groups.flatMap((group) => group.rows);
  assert.equal(rows.length, actions.length);
  assert.deepEqual(JSON.parse(JSON.stringify(groups)), groups);
  for (const [index, row] of rows.entries()) {
    inspectMessage(row);
    assert.ok(formatUiMessage(row).startsWith(`${index + 1}. `));
    assert.doesNotMatch(formatUiMessage(row), /undefined|\[object Object\]/);
  }
  for (const group of groups) inspectMessage(group.title);
  assert.equal(JSON.stringify(actions), original);

  function inspectMessage(message: UiMessage | number | boolean, depth = 0): void {
    if (typeof message !== "object") {
      if (typeof message === "number") assert.ok(Number.isFinite(message));
      return;
    }
    assert.ok(depth < 16, message.source);
    assert.deepEqual(Object.keys(message).sort(), ["source", "values"]);
    assert.ok(Object.hasOwn(actionMessages, message.source), message.source);
    assert.ok(Object.keys(message.values).length <= 64, message.source);
    const fields = [...new Set([...message.source.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map((match) => match[1]))].sort();
    assert.deepEqual(Object.keys(message.values).sort(), fields, message.source);
    for (const value of Object.values(message.values)) inspectMessage(value, depth + 1);
  }
});

test("bound action values keep exact names, enum values and JSON after input changes", () => {
  const path = { deviceIndex: 2, nested: [{ chainIndex: 0, deviceIndex: 1 }] };
  const sourceName = 'selected Live object <b>{path}</b>';
  const action = {
    type: "replace_simpler_sample" as const,
    trackName: "Delete",
    simplerName: "Song",
    simplerPath: path,
    source: { kind: "simpler" as const, trackName: "clip", deviceName: sourceName, devicePath: path },
  };
  const groups = actionDiffGroups([
    action,
    { type: "set_audio_clip_warp", trackName: "Delete", clipName: "Untitled", startBeat: 0, warpMode: "complex_pro", warping: false },
  ]);
  const snapshot = JSON.stringify(groups);
  const pathJson = JSON.stringify(path);
  action.trackName = "Edited after binding";
  action.source.deviceName = "Changed";
  path.nested[0]!.deviceIndex = 42;
  assert.equal(JSON.stringify(groups), snapshot);
  const text = groups.flatMap((group) => group.rows).map(formatUiMessage).join("\n");
  assert.ok(text.includes(sourceName));
  assert.ok(text.includes(pathJson));
  assert.match(text, /warping=false warpMode=complex_pro/);
  assert.match(text, /track "Delete"/);
});
