import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { actionDiffGroups } from "../../../src/ui/action-diff.js";
import { formatUiMessage } from "../../../src/ui/i18n/ui-message.js";
import {
  commandCalls, createDialogHarness, jsonCalls, stateFixture, waitForCondition,
  type DialogHarness,
} from "../support/chat-dialog.test-harness.js";

async function pendingSend(t: TestContext): Promise<DialogHarness> {
  const state = stateFixture();
  state.settings.uiLanguage = "en";
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  harness.holdNextSend();
  t.after(async () => {
    harness.releaseHeldSend();
    await harness.settle();
    harness.close();
  });
  harness.input("#prompt", "Keep the exact model prompt: Delete / {startBeat}.");
  harness.click("#sendButton");
  await waitForCondition(() => harness.sendIds.length === 1, "Expected the owning Send");
  return harness;
}

function confirmation(harness: DialogHarness, groups: ReturnType<typeof actionDiffGroups>) {
  return {
    type: "confirm_request", sendId: harness.sendIds[0], sessionId: "session-1",
    modelTurnEpoch: 0, id: "localized-actions", confirmationGeneration: 1, kind: "apply",
    message: 'Delete <span data-i18n="Delete">{track}</span>', groups,
  };
}

async function language(harness: DialogHarness, uiLanguage: "en" | "zh-CN", revision: string) {
  const { settings } = stateFixture();
  harness.emitServerEvent({
    type: "global_settings_changed",
    defaultFollowUpBehavior: settings.defaultFollowUpBehavior,
    defaultFollowUpBehaviorRevision: settings.defaultFollowUpBehaviorRevision,
    showContextUsage: settings.showContextUsage,
    contextUsageVisibilityRevision: settings.contextUsageVisibilityRevision,
    uiLanguage, uiLanguageRevision: revision, commandId: `external-language-${revision}`,
  });
  await harness.settle();
  assert.equal(harness.document.documentElement.lang, uiLanguage);
}

function rows(harness: DialogHarness): string[] {
  return [...harness.document.querySelectorAll(".confirm-rows li")].map((row) => row.textContent ?? "");
}

test("composed action confirmation translates destructive details and preserves raw text while its decision is pending", async (t) => {
  const harness = await pendingSend(t);
  const name = 'Delete <span data-i18n="Song">{startBeat} $&</span>';
  const groups = actionDiffGroups([
    { type: "clear_arrangement_range", trackName: name, startBeat: 32, endBeat: 64 },
    { type: "create_session_audio_clip", trackName: "Song", slotIndex: 0, name: "Untitled", source: { kind: "selected" } },
    { type: "delete_track", trackName: "Delete" },
  ]);
  // Legacy/plain text is deliberately raw even when it equals a catalog source.
  groups.push({ title: "Delete", rows: ["Song", "selected Live object", 'track "{name}"'] });
  const request = confirmation(harness, groups);
  harness.emitServerEvent(JSON.parse(JSON.stringify(request)));
  await harness.settle();
  const english = groups.flatMap((group) => group.rows).map(formatUiMessage);
  assert.deepEqual(rows(harness), english);

  await language(harness, "zh-CN", "1");
  assert.deepEqual([...harness.document.querySelectorAll(".confirm-group-title")].map((node) => node.textContent), ["删除", "写入音频", "删除", "Delete"]);
  assert.equal(rows(harness)[0], `1. - 清除 轨道 "${name}" 上第 32 拍到第 64 拍的编曲内容；跨越边界的片段会被截短`);
  assert.match(rows(harness)[1]!, /选中的 Live 对象.*删除并重新创建该槽位中的片段/);
  assert.ok(rows(harness)[1]!.includes('"Untitled"'));
  assert.equal(rows(harness)[2], '3. - 删除 轨道 "Delete"');
  assert.deepEqual(rows(harness).slice(3), ["Song", "selected Live object", 'track "{name}"']);
  assert.equal(harness.document.querySelector("#pendingConfirmationMessage")?.textContent, request.message);
  assert.equal(harness.document.querySelector(".confirm-card span, .confirm-card img"), null);
  assert.deepEqual(jsonCalls(harness, "/confirm"), []);

  harness.holdNextConfirmation();
  let held = true;
  try {
    harness.click(".confirm-card button.primary");
    await harness.settle();
    await language(harness, "en", "2");
    assert.deepEqual(rows(harness), english);
    await language(harness, "zh-CN", "3");
    assert.match(rows(harness)[0]!, /跨越边界的片段会被截短/);
    for (const button of harness.document.querySelectorAll<HTMLButtonElement>(".confirm-buttons button")) assert.equal(button.disabled, true);
    assert.deepEqual(jsonCalls(harness, "/confirm"), [{ path: "/confirm", body: { id: request.id, apply: true } }]);
    assert.equal(jsonCalls(harness, "/send").length, 1);
    assert.deepEqual(jsonCalls(harness, "/send")[0]?.body, { prompt: "Keep the exact model prompt: Delete / {startBeat}.", sessionId: "session-1" });
    assert.deepEqual(commandCalls(harness), []);
    harness.releaseHeldConfirmation();
    held = false;
    await harness.settle();
    assert.equal(harness.document.querySelector(".confirm-card"), null);
    assert.deepEqual(harness.errors, []);
  } finally {
    if (held) harness.releaseHeldConfirmation();
  }
});

test("composed confirmation localizes nested refs, sample locators and lane scope without changing exact values", async (t) => {
  const harness = await pendingSend(t);
  const path = { deviceIndex: 2, nested: [{ chainIndex: 0, deviceIndex: 1 }] };
  const groups = actionDiffGroups([
    { type: "insert_device", trackRef: "return", deviceName: "Delete" },
    { type: "set_track_mixer_parameter", trackRef: "main", parameter: "send", sendIndex: 0, value: 0.25 },
    { type: "replace_simpler_sample", trackName: "Song", simplerName: "Delete", source: { kind: "simpler", trackName: "Source", deviceName: "clip", devicePath: path } },
    { type: "replace_simpler_sample", trackName: "Song", simplerName: "Delete", source: { kind: "session_audio_clip", trackName: "Source", clipName: "Song", slotIndex: 0 } },
    { type: "replace_simpler_sample", trackName: "Song", simplerName: "Delete", source: { kind: "arrangement_audio_clip", trackName: "Source", clipName: "Delete", startBeat: 16 } },
    { type: "replace_simpler_sample", trackName: "Song", simplerName: "Delete", source: { kind: "request_audio_attachment", requestId: "private-event-id", audioIndex: 0 } },
    { type: "create_midi_clip", trackName: "Song", laneIndex: 0, laneName: "Take Lane", startBeat: 0, durationBeats: 4, notes: [] },
    { type: "create_arrangement_audio_clip", trackName: "Song", laneIndex: 1, laneName: "Take Lane", startBeat: 8, source: { kind: "selected" }, isWarped: false, loopSettings: { loopStart: 0, loopEnd: 2, startMarker: 0, endMarker: 4, looping: false } },
    { type: "set_audio_clip_warp", trackName: "Song", slotIndex: 0, clipName: "Untitled", warpMode: "complex_pro", warping: false },
    { type: "scale_midi_velocity", trackName: "Song", startBeat: 8, clipName: "Delete", factor: 0.5 },
    { type: "replace_simpler_sample", trackName: "Song", simplerName: "Delete", source: { kind: "audio_asset", assetRef: "audio-result-opaque-1" } },
  ], {
    return: { trackRole: "return", trackIndex: 0, trackName: "Delete" },
    main: { trackRole: "main", trackName: "Song" },
  });
  harness.emitServerEvent(confirmation(harness, groups));
  await harness.settle();
  assert.deepEqual(rows(harness), groups.flatMap((group) => group.rows).map(formatUiMessage));
  await language(harness, "zh-CN", "1");
  const rendered = rows(harness);
  assert.match(rendered[0]!, /返回轨道索引 0 "Delete".*引用 return/);
  assert.match(rendered[1]!, /主轨道 "Song".*引用 main.*send\[0\] = 0\.25/);
  assert.ok(rendered[2]!.includes(`路径 ${JSON.stringify(path)}`));
  assert.match(rendered[3]!, /Source 上槽位 0 的会话片段 "Song"/);
  assert.match(rendered[4]!, /Source 上第 16 拍的编曲片段 "Delete"/);
  assert.match(rendered[5]!, /当前请求的音频输入 1/);
  assert.doesNotMatch(rendered[5]!, /private-event-id/);
  assert.match(rendered[6]!, /录音分轨 0 "Take Lane".*创建时要求目标范围为空/);
  assert.match(rendered[7]!, /原始时长.*选中的 Live 对象.*Warp 启用=false.*循环范围=0-2.*标记=0-4.*循环=false.*要求分轨的目标范围为空/);
  assert.match(rendered[8]!, /会话槽位 0 中的片段 "Untitled".*Warp 启用=false.*complex_pro/);
  assert.match(rendered[9]!, /编曲中第 8 拍的片段 "Delete".*所有音符力度乘以 0\.5/);
  assert.match(rendered[10]!, /已处理的音频资源 audio-result-opaque-1/);
  await language(harness, "en", "2");
  assert.deepEqual(rows(harness), groups.flatMap((group) => group.rows).map(formatUiMessage));
  harness.click("[data-confirm-cancel]");
  await harness.settle();
  assert.deepEqual(jsonCalls(harness, "/confirm"), [{ path: "/confirm", body: { id: "localized-actions", apply: false } }]);
  assert.deepEqual(harness.errors, []);
});
