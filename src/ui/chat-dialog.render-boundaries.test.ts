import assert from "node:assert/strict";
import test from "node:test";

import {
  commandCalls,
  createDialogHarness,
  documentFile,
  modelStateSourceFixture,
  pendingDocument,
  profileFixture,
  profileRevisionFixture,
  stateFixture,
  waitForCondition,
} from "./chat-dialog.test-harness.js";

test("the conversation scrollbar uses an idle fallback without scrollend", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state, undefined, {
    scrollendSupported: false,
  });
  try {
    const timeline = harness.document.querySelector<HTMLElement>("#timeline");
    const prompt = harness.document.querySelector<HTMLTextAreaElement>("#prompt");
    assert.ok(timeline);
    assert.ok(prompt);
    prompt.focus();
    assert.equal(timeline.classList.contains("is-scrolling"), false);

    timeline.dispatchEvent(new harness.window.Event("scroll"));
    assert.equal(timeline.classList.contains("is-scrolling"), true);
    assert.equal(harness.document.activeElement, prompt);
    await new Promise((resolve) => harness.window.setTimeout(resolve, 400));
    timeline.dispatchEvent(new harness.window.Event("scroll"));
    await new Promise((resolve) => harness.window.setTimeout(resolve, 400));
    assert.equal(timeline.classList.contains("is-scrolling"), true);
    assert.equal(harness.document.activeElement, prompt);
    await new Promise((resolve) => harness.window.setTimeout(resolve, 300));
    assert.equal(timeline.classList.contains("is-scrolling"), false);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("scrollend keeps the conversation scrollbar visible through a paused gesture", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state, undefined, {
    scrollendSupported: true,
  });
  try {
    const timeline = harness.document.querySelector<HTMLElement>("#timeline");
    const prompt = harness.document.querySelector<HTMLTextAreaElement>("#prompt");
    assert.ok(timeline);
    assert.ok(prompt);
    prompt.focus();

    timeline.dispatchEvent(new harness.window.Event("scroll"));
    await new Promise((resolve) => harness.window.setTimeout(resolve, 700));
    assert.equal(timeline.classList.contains("is-scrolling"), true);
    assert.equal(harness.document.activeElement, prompt);

    timeline.dispatchEvent(new harness.window.Event("scrollend"));
    assert.equal(timeline.classList.contains("is-scrolling"), false);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("selecting a Session shows pending feedback before authoritative state arrives", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  state.events = [{
    id: "event-bass-before-switch",
    createdAt: "2026-08-01T00:00:00.000Z",
    kind: "assistant",
    content: "Bass Session response",
  }];
  const harness = await createDialogHarness(state);
  try {
    const targetState = stateFixture();
    targetState.openSettingsOnLoad = false;
    targetState.events = [{
      id: "event-lead-after-switch",
      createdAt: "2026-08-01T00:01:00.000Z",
      kind: "assistant",
      content: "Lead Session response",
    }];
    harness.setServerState(targetState);
    harness.input("#prompt", "Unsent Bass Session draft");
    harness.holdNextCommandResponse();
    const targetRow = harness.document.querySelector<HTMLButtonElement>(
      '.session-entry[data-session-id="session-2"] .session-row',
    );
    assert.ok(targetRow);
    targetRow.focus();
    targetRow.click();
    await waitForCondition(
      () => commandCalls(harness).some((call) =>
        (call.body as { kind?: string }).kind === "select_session"
      ),
      "Expected the Session switch to wait for its authoritative response.",
    );

    assert.equal(targetRow.isConnected, true);
    assert.equal(targetRow.getAttribute("aria-busy"), "true");
    assert.equal(targetRow.hasAttribute("data-switching"), true);
    assert.equal(
      targetRow.querySelector(".session-title")?.textContent,
      "Lead session",
    );
    assert.equal(
      targetRow.querySelector(".session-meta-content")?.textContent,
      "Track · Lead",
    );
    assert.equal(
      harness.document.querySelector('.session-row[aria-pressed="true"]')
        ?.closest<HTMLElement>(".session-entry")?.dataset.sessionId,
      "session-1",
      "pending feedback must not claim that stale Session content is authoritative",
    );
    assert.equal(
      harness.document.querySelector("[data-event-id=event-bass-before-switch]")
        ?.isConnected,
      true,
    );
    assert.equal(
      harness.document.querySelector("[data-event-id=event-lead-after-switch]"),
      null,
    );
    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
      "Unsent Bass Session draft",
    );

    harness.releaseHeldCommandResponse();
    await harness.settle();
    assert.equal(
      harness.document.querySelector('.session-row[aria-pressed="true"]')
        ?.closest<HTMLElement>(".session-entry")?.dataset.sessionId,
      "session-2",
    );
    assert.equal(
      harness.document.querySelector("[data-event-id=event-bass-before-switch]"),
      null,
    );
    assert.equal(
      harness.document.querySelector("[data-event-id=event-lead-after-switch]")
        ?.isConnected,
      true,
    );
    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
      "",
    );
    assert.equal(
      harness.document.querySelector(".session-row[data-switching]"),
      null,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a failed Session switch clears pending feedback without changing Session", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextCommand();
    harness.failNextCommand("Could not switch Session");
    const targetRow = harness.document.querySelector<HTMLButtonElement>(
      '.session-entry[data-session-id="session-2"] .session-row',
    );
    assert.ok(targetRow);
    targetRow.click();
    await waitForCondition(
      () => commandCalls(harness).some((call) =>
        (call.body as { kind?: string }).kind === "select_session"
      ),
      "Expected the Session switch to wait before failing.",
    );
    assert.equal(targetRow.getAttribute("aria-busy"), "true");
    assert.equal(targetRow.hasAttribute("data-switching"), true);

    harness.releaseHeldCommand();
    await harness.settle();
    assert.equal(targetRow.isConnected, true);
    assert.equal(targetRow.hasAttribute("data-switching"), false);
    assert.equal(targetRow.hasAttribute("aria-busy"), false);
    assert.equal(
      targetRow.querySelector(".session-meta-content")?.textContent,
      "Track · Lead",
    );
    assert.equal(
      harness.document.querySelector('.session-row[aria-pressed="true"]')
        ?.closest<HTMLElement>(".session-entry")?.dataset.sessionId,
      "session-1",
    );
    assert.match(
      harness.document.querySelector("#status")?.textContent ?? "",
      /Could not switch Session/,
    );

    targetRow.click();
    await harness.settle();
    assert.equal(
      commandCalls(harness).filter((call) =>
        (call.body as { kind?: string }).kind === "select_session"
      ).length,
      2,
    );
    assert.equal(
      harness.document.querySelector('.session-row[aria-pressed="true"]')
        ?.closest<HTMLElement>(".session-entry")?.dataset.sessionId,
      "session-2",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("creating a Session preserves existing Session and Skill rows", async () => {
  const harness = await createDialogHarness();
  try {
    const existingSessionRow = harness.document.querySelector(
      '.session-entry[data-session-id="session-2"] .session-row',
    );
    const existingSkillRow = harness.document.querySelector(
      "#builtInSkillList .skill-row",
    );
    assert.ok(existingSessionRow);
    assert.ok(existingSkillRow);
    const nextState = stateFixture();
    nextState.sessions = [{
      id: "session-3",
      title: "New session",
      projectKey: "project-1",
      scope: { kind: "track", identity: "track-drums", label: "Drums" },
      createdAt: "2026-08-01T00:02:00.000Z",
      updatedAt: "2026-08-01T00:02:00.000Z",
    }, ...nextState.sessions];
    nextState.activeSessionId = "session-3";
    harness.setServerState(nextState);

    harness.click("#newSessionButton");
    await harness.settle();

    assert.equal(
      harness.document.querySelector(
        '.session-entry[data-session-id="session-2"] .session-row',
      ),
      existingSessionRow,
    );
    assert.equal(
      harness.document.querySelector("#builtInSkillList .skill-row"),
      existingSkillRow,
    );
    assert.equal(
      harness.document.querySelector('.session-entry[data-session-id="session-3"]')
        ?.querySelector(".session-row")?.getAttribute("aria-pressed"),
      "true",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("an Approval change keeps unrelated UI nodes mounted", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  state.events = [{
    id: "event-existing",
    createdAt: "2026-08-01T00:00:00.000Z",
    kind: "assistant",
    content: "Existing response",
  }];
  state.pendingAttachments = [pendingDocument(
    "attachment-existing",
    "arrangement-notes.docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  )];
  const harness = await createDialogHarness(state);
  try {
    harness.input("#profileName", "Local Profile edit");
    const stableNodes = {
      attachment: harness.document.querySelector(
        '[data-attachment-id="attachment-existing"]',
      ),
      context: harness.document.querySelector("#context .context-card"),
      profileOption: harness.document.querySelector("#profileSelector option"),
      reasoningOption: harness.document.querySelector("#reasoningMode option"),
      session: harness.document.querySelector(
        '.session-entry[data-session-id="session-1"] .session-row',
      ),
      skill: harness.document.querySelector("#builtInSkillList .skill-row"),
      timeline: harness.document.querySelector(
        '.timeline-item[data-event-id="event-existing"]',
      ),
    };
    for (const node of Object.values(stableNodes)) assert.ok(node);

    harness.holdNextCommandResponse();
    harness.select("#approvalMode", "everything");
    await waitForCondition(
      () => commandCalls(harness).some((call) =>
        (call.body as { kind?: string }).kind === "set_session_approval_mode"
      ),
      "Expected the Approval command to wait for its response.",
    );
    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#profileName")?.disabled,
      false,
    );
    assert.equal(
      harness.document.querySelector<HTMLElement>("#modelProfileControls")
        ?.getAttribute("aria-busy"),
      "false",
    );
    assert.equal(
      harness.document.querySelector<HTMLInputElement>(
        "#builtInSkillList input[type=checkbox]",
      )?.disabled,
      true,
    );
    assert.equal(
      harness.document.querySelector<HTMLButtonElement>("#saveProfileButton")
        ?.disabled,
      true,
    );
    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#approvalMode")?.disabled,
      true,
    );
    harness.releaseHeldCommandResponse();
    await harness.settle();
    assert.equal(
      harness.document.querySelector<HTMLButtonElement>("#saveProfileButton")
        ?.disabled,
      false,
    );

    assert.equal(
      harness.document.querySelector('[data-attachment-id="attachment-existing"]'),
      stableNodes.attachment,
    );
    assert.equal(
      harness.document.querySelector("#context .context-card"),
      stableNodes.context,
    );
    assert.equal(
      harness.document.querySelector("#profileSelector option"),
      stableNodes.profileOption,
    );
    assert.equal(
      harness.document.querySelector("#reasoningMode option"),
      stableNodes.reasoningOption,
    );
    assert.equal(
      harness.document.querySelector(
        '.session-entry[data-session-id="session-1"] .session-row',
      ),
      stableNodes.session,
    );
    assert.equal(
      harness.document.querySelector("#builtInSkillList .skill-row"),
      stableNodes.skill,
    );
    assert.equal(
      harness.document.querySelector(
        '.timeline-item[data-event-id="event-existing"]',
      ),
      stableNodes.timeline,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("an Approval change keeps Scope and runtime controls independent", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    const approval = harness.document.querySelector<HTMLSelectElement>(
      "#approvalMode",
    );
    const model = harness.document.querySelector<HTMLSelectElement>(
      "#composerModel",
    );
    const reasoning = harness.document.querySelector<HTMLSelectElement>(
      "#composerReasoning",
    );
    const status = harness.document.querySelector<HTMLElement>("#status");
    assert.ok(approval);
    assert.ok(model);
    assert.ok(reasoning);
    assert.ok(status);
    const modelValue = model.value;
    const reasoningValue = reasoning.value;
    const modelOptions = [...model.options];
    const reasoningOptions = [...reasoning.options];

    harness.holdNextCommandResponse();
    harness.select("#approvalMode", "everything");
    await waitForCondition(
      () => commandCalls(harness).some((call) =>
        (call.body as { kind?: string }).kind ===
          "set_session_approval_mode"
      ),
      "Expected the Approval command to remain pending.",
    );
    assert.equal(approval.value, "everything");
    assert.equal(harness.document.querySelector("#editScopeButton")?.textContent, "All scopes");
    assert.equal(harness.document.querySelector<HTMLElement>("#editScopePanel")?.hidden, true);
    assert.equal(status.hidden, false);
    assert.equal(status.textContent, "");
    assert.equal(model.value, modelValue);
    assert.equal(reasoning.value, reasoningValue);
    assert.deepEqual([...model.options], modelOptions);
    assert.deepEqual([...reasoning.options], reasoningOptions);

    harness.releaseHeldCommandResponse();
    await harness.settle();
    assert.equal(approval.value, "everything");
    assert.equal(harness.document.querySelector("#editScopeButton")?.textContent, "All scopes");
    assert.equal(harness.document.querySelector<HTMLElement>("#editScopePanel")?.hidden, true);
    assert.equal(status.hidden, false);
    assert.equal(status.textContent, "");
    assert.deepEqual([...model.options], modelOptions);
    assert.deepEqual([...reasoning.options], reasoningOptions);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("an Approval change does not rewrite unrelated Model Profile or composer content", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  let commandReleased = false;
  try {
    harness.click("#editScopeButton");
    const settings = harness.document.querySelector("#modelProfileSettings");
    const composer = harness.document.querySelector(".composer");
    assert.ok(settings);
    assert.ok(composer);
    const settingsRecords: MutationRecord[] = [];
    const composerRecords: MutationRecord[] = [];
    const settingsObserver = new harness.window.MutationObserver((records) => {
      settingsRecords.push(...records);
    });
    const composerObserver = new harness.window.MutationObserver((records) => {
      composerRecords.push(...records);
    });
    settingsObserver.observe(settings, {
      attributes: true,
      childList: true,
      subtree: true,
    });
    composerObserver.observe(composer, {
      attributes: true,
      childList: true,
      subtree: true,
    });

    harness.holdNextCommandResponse();
    harness.select("#approvalMode", "everything");
    await waitForCondition(
      () => commandCalls(harness).some((call) =>
        (call.body as { kind?: string }).kind ===
          "set_session_approval_mode"
      ),
      "Expected the Approval command to remain pending.",
    );
    harness.releaseHeldCommandResponse();
    commandReleased = true;
    await harness.settle();
    settingsObserver.disconnect();
    composerObserver.disconnect();

    const admissionControlIds = new Set([
      "profileSelector",
      "saveProfileButton",
      "deleteProfileButton",
      "discoverModelsButton",
      "oauthSignInButton",
      "oauthCheckAccountButton",
      "oauthSubmitCodeButton",
      "oauthLogoutButton",
      "defaultFollowUpBehavior",
      "showContextUsage",
      "networkProxyMode",
      "networkProxyUrl",
      "applyNetworkProxyButton",
    ]);
    const unexpectedSettings = settingsRecords.filter((record) =>
      record.type !== "attributes" ||
      record.attributeName !== "disabled" ||
      !admissionControlIds.has((record.target as Element).id)
    );
    const allowedComposerAttributes = new Map<string, Set<string>>([
      ["approvalMode", new Set(["aria-label", "class", "disabled"])],
      ["prompt", new Set(["disabled"])],
      ["sendButton", new Set(["disabled", "title"])],
      ["attachmentMenuButton", new Set(["disabled"])],
      ["pendingAttachments", new Set(["aria-busy"])],
      ["editScopeButton", new Set(["disabled"])],
    ]);
    for (const control of harness.document.querySelectorAll(
      "#editScopePanel input",
    )) {
      allowedComposerAttributes.set(control.id, new Set(["disabled"]));
    }
    const approvalLabel = harness.document.querySelector("#approvalMode")
      ?.closest("label");
    const unexpectedComposer = composerRecords.filter((record) => {
      if (record.type !== "attributes") return true;
      if (
        record.target === approvalLabel &&
        record.attributeName === "title"
      ) return false;
      const allowed = allowedComposerAttributes.get(
        (record.target as Element).id,
      );
      return !record.attributeName || !allowed?.has(record.attributeName);
    });
    const summarize = (record: MutationRecord) => ({
      attribute: record.attributeName,
      id: (record.target as Element).id,
      type: record.type,
    });
    assert.deepEqual(unexpectedSettings.map(summarize), []);
    assert.deepEqual(unexpectedComposer.map(summarize), []);
    assert.deepEqual(harness.errors, []);
  } finally {
    if (!commandReleased) harness.releaseHeldCommandResponse();
    await harness.settle();
    harness.close();
  }
});

test("a composer model change keeps unrelated Session content mounted", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const profile = state.settings.profiles[0];
  assert.ok(profile);
  profile.models.push({
    ...JSON.parse(JSON.stringify(profile.models[0])),
    model: "model-b",
  });
  state.configuredModels.push({ model: "model-b", label: "model-b" });
  state.events = [{
    id: "event-before-model-change",
    createdAt: "2026-08-01T00:00:00.000Z",
    kind: "assistant",
    content: "Keep this response mounted",
  }];
  const harness = await createDialogHarness(state);
  try {
    const sessionRow = harness.document.querySelector(
      '.session-entry[data-session-id="session-1"] .session-row',
    );
    const timelineItem = harness.document.querySelector(
      '.timeline-item[data-event-id="event-before-model-change"]',
    );
    assert.ok(sessionRow);
    assert.ok(timelineItem);

    harness.select("#composerModel", "model-b");
    await harness.settle();

    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#composerModel")?.value,
      "model-b",
    );
    assert.equal(
      harness.document.querySelector(
        '.session-entry[data-session-id="session-1"] .session-row',
      ),
      sessionRow,
    );
    assert.equal(
      harness.document.querySelector(
        '.timeline-item[data-event-id="event-before-model-change"]',
      ),
      timelineItem,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("editing a Profile model does not rewrite unrelated controls", async () => {
  const state = stateFixture();
  const profile = state.settings.profiles[0];
  assert.ok(profile);
  profile.models.push({
    ...JSON.parse(JSON.stringify(profile.models[0])),
    model: "model-b",
  });
  const harness = await createDialogHarness(state);
  try {
    const selector = harness.document.querySelector<HTMLSelectElement>(
      "#modelConfigSelector",
    );
    const capabilityItems = [...harness.document.querySelectorAll(
      "#inputCapabilitiesPreview [data-capability-state]",
    )];
    const unrelatedRegions = [
      harness.document.querySelector("#oauthAuthPanel"),
      harness.document.querySelector("#manualModelEntry"),
      harness.document.querySelector("#draftStatus"),
      harness.document.querySelector(".composer-toolbar"),
    ];
    assert.ok(selector);
    assert.equal(capabilityItems.length, 3);
    for (const region of unrelatedRegions) assert.ok(region);
    const mutations: MutationRecord[] = [];
    const observer = new harness.window.MutationObserver((records) => {
      mutations.push(...records);
    });
    for (const region of unrelatedRegions) {
      observer.observe(region!, {
        attributes: true,
        childList: true,
        subtree: true,
      });
    }

    harness.select("#modelConfigSelector", "1");
    await Promise.resolve();
    observer.disconnect();

    assert.equal(selector.value, "1");
    assert.deepEqual(mutations, []);
    assert.deepEqual(
      [...harness.document.querySelectorAll(
        "#inputCapabilitiesPreview [data-capability-state]",
      )],
      capabilityItems,
      "capability status rows should be reconciled instead of replaced",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("background progress preserves pending Session-switch feedback", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  let commandReleased = false;
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Keep working in Bass");
    harness.click("#sendButton");
    await waitForCondition(
      () => harness.sendIds.length === 1,
      "Expected the Bass send to start.",
    );
    const sendId = harness.sendIds[0];
    assert.ok(sendId);

    harness.holdNextCommandResponse();
    harness.click('.session-entry[data-session-id="session-2"] .session-row');
    await waitForCondition(
      () => commandCalls(harness).some((call) =>
        (call.body as { kind?: string }).kind === "select_session"
      ),
      "Expected the Session switch to wait for its response.",
    );
    const pendingRow = harness.document.querySelector(
      '.session-entry[data-session-id="session-2"] .session-row',
    );
    assert.equal(pendingRow?.hasAttribute("data-switching"), true);

    harness.emitServerEvent({
      type: "progress",
      sendId,
      sessionId: "session-1",
      message: "Writing the Bass part",
    });
    assert.equal(
      harness.document.querySelector(
        '.session-entry[data-session-id="session-2"] .session-row',
      ),
      pendingRow,
    );
    assert.equal(pendingRow?.hasAttribute("data-switching"), true);
    assert.equal(
      pendingRow?.querySelector(".session-meta-content")?.textContent,
      "Track · Lead",
    );

    harness.releaseHeldCommandResponse();
    commandReleased = true;
    await harness.settle();
    assert.equal(
      harness.document.querySelector(".session-row[data-switching]"),
      null,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    if (!commandReleased) harness.releaseHeldCommandResponse();
    harness.releaseHeldSend();
    await harness.settle();
    harness.close();
  }
});

test("Session setting changes update timestamps without replacing rows", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  const ui = (harness.window as unknown as {
    LiveSmithUI: {
      runCommand(kind: string, extra?: Record<string, unknown>): Promise<boolean>;
    };
  }).LiveSmithUI;
  try {
    const row = harness.document.querySelector(
      '.session-entry[data-session-id="session-1"] .session-row',
    );
    const meta = row?.querySelector<HTMLElement>(".session-meta");
    assert.ok(row);
    assert.ok(meta);
    const previousTitle = meta.title;
    const authoritative = stateFixture();
    authoritative.openSettingsOnLoad = false;
    authoritative.sessions[0]!.updatedAt = "2026-08-24T12:34:00.000Z";
    harness.setServerState(authoritative);

    assert.equal(
      await ui.runCommand("set_session_approval_mode", {
        sessionId: "session-1",
        approvalMode: "everything",
      }),
      true,
    );
    assert.equal(
      harness.document.querySelector(
        '.session-entry[data-session-id="session-1"] .session-row',
      ),
      row,
    );
    assert.notEqual(meta.title, previousTitle);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("an unrelated state refresh does not move History or Archived rows", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  state.previousSessions = [{
    ...state.sessions[1]!,
    id: "session-history",
    title: "History session",
    projectKey: "project-history",
    scope: { ...state.sessions[1]!.scope, label: "History Lead" },
  }];
  state.archivedSessions = [{
    ...state.sessions[1]!,
    id: "session-archived",
    title: "Archived session",
    archivedAt: "2026-08-02T00:00:00.000Z",
    scope: { ...state.sessions[1]!.scope, label: "Archived Lead" },
  }];
  const harness = await createDialogHarness(state);
  const ui = (harness.window as unknown as {
    LiveSmithUI: {
      runCommand(kind: string, extra?: Record<string, unknown>): Promise<boolean>;
    };
  }).LiveSmithUI;
  try {
    const list = harness.document.querySelector("#sessions");
    assert.ok(list);
    const mutations: MutationRecord[] = [];
    const observer = new harness.window.MutationObserver((records) => {
      mutations.push(...records);
    });
    observer.observe(list, {
      attributes: true,
      childList: true,
      subtree: true,
    });

    assert.equal(
      await ui.runCommand("set_session_approval_mode", {
        sessionId: "session-1",
        approvalMode: "low-risk",
      }),
      true,
    );
    await harness.settle();
    observer.disconnect();

    assert.deepEqual(
      mutations.filter((mutation) =>
        mutation.type !== "attributes" || mutation.attributeName !== "disabled"
      ),
      [],
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("an unrelated Session update preserves an in-progress rename", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  const ui = (harness.window as unknown as {
    LiveSmithUI: {
      runCommand(kind: string, extra?: Record<string, unknown>): Promise<boolean>;
    };
  }).LiveSmithUI;
  try {
    harness.click('.session-entry[data-session-id="session-2"] .session-row');
    await harness.settle();
    const leadRow = harness.document.querySelector<HTMLButtonElement>(
      '.session-entry[data-session-id="session-2"] .session-row',
    );
    assert.ok(leadRow);
    leadRow.dispatchEvent(new harness.window.KeyboardEvent("keydown", {
      key: "F2",
      bubbles: true,
    }));
    const rename = harness.document.querySelector<HTMLInputElement>(
      '.session-entry[data-session-id="session-2"] .session-rename-input',
    );
    assert.ok(rename);
    rename.value = "Unsaved Lead name";

    const authoritative = stateFixture();
    authoritative.openSettingsOnLoad = false;
    authoritative.activeSessionId = "session-2";
    authoritative.approvalMode = "low-risk";
    authoritative.sessions[1]!.scope = {
      ...authoritative.sessions[1]!.scope,
      label: "Lead Synth",
    };
    harness.setServerState(authoritative);
    assert.equal(
      await ui.runCommand("set_session_approval_mode", {
        sessionId: "session-2",
        approvalMode: "low-risk",
      }),
      true,
    );

    const restoredRename = harness.document.querySelector<HTMLInputElement>(
      '.session-entry[data-session-id="session-2"] .session-rename-input',
    );
    assert.ok(restoredRename);
    assert.equal(restoredRename, rename);
    assert.equal(restoredRename.value, "Unsaved Lead name");
    assert.equal(harness.document.activeElement, restoredRename);
    restoredRename.dispatchEvent(new harness.window.KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
    }));
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a temporary Session lock does not commit or discard a rename on blur", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  const ui = (harness.window as unknown as {
    LiveSmithUI: {
      runCommand(kind: string, extra?: Record<string, unknown>): Promise<boolean>;
    };
  }).LiveSmithUI;
  try {
    const row = harness.document.querySelector<HTMLButtonElement>(
      '.session-entry[data-session-id="session-1"] .session-row',
    );
    assert.ok(row);
    row.dispatchEvent(new harness.window.KeyboardEvent("keydown", {
      key: "F2",
      bubbles: true,
    }));
    const rename = harness.document.querySelector<HTMLInputElement>(
      '.session-entry[data-session-id="session-1"] .session-rename-input',
    );
    assert.ok(rename);
    rename.value = "Unsaved Bass name";

    harness.holdNextCommandResponse();
    const command = ui.runCommand("set_session_approval_mode", {
      sessionId: "session-1",
      approvalMode: "low-risk",
    });
    await waitForCondition(
      () => commandCalls(harness).some((call) =>
        (call.body as { kind?: string }).kind === "set_session_approval_mode"
      ),
      "Expected the temporary Session lock.",
    );
    assert.equal(rename.disabled, true);
    rename.dispatchEvent(new harness.window.FocusEvent("blur"));
    assert.equal(rename.isConnected, true);
    assert.equal(rename.value, "Unsaved Bass name");
    assert.equal(
      commandCalls(harness).filter((call) =>
        (call.body as { kind?: string }).kind === "rename_session"
      ).length,
      0,
    );

    harness.document.body.tabIndex = -1;
    harness.document.body.focus();
    harness.document.body.removeAttribute("tabindex");
    harness.releaseHeldCommandResponse();
    assert.equal(await command, true);
    await harness.settle();
    assert.equal(rename.disabled, false);
    assert.equal(rename.isConnected, true);
    assert.equal(rename.value, "Unsaved Bass name");
    assert.equal(harness.document.activeElement, rename);
    rename.dispatchEvent(new harness.window.KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
    }));
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("an authoritative title change cancels a stale Session rename", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Generate a title while I edit it");
    harness.click("#sendButton");
    await waitForCondition(
      () => harness.sendIds.length === 1,
      "Expected the send to stay active.",
    );
    const row = harness.document.querySelector<HTMLButtonElement>(
      '.session-entry[data-session-id="session-1"] .session-row',
    );
    assert.ok(row);
    row.dispatchEvent(new harness.window.KeyboardEvent("keydown", {
      key: "F2",
      bubbles: true,
    }));
    const rename = harness.document.querySelector<HTMLInputElement>(
      '.session-entry[data-session-id="session-1"] .session-rename-input',
    );
    assert.ok(rename);
    rename.value = "Unsaved Bass name";

    const authoritative = stateFixture();
    authoritative.openSettingsOnLoad = false;
    authoritative.sessions[0]!.title = "Generated Bass title";
    harness.emitServerEvent({
      type: "done",
      sendId: harness.sendIds[0],
      sessionId: "session-1",
      state: authoritative,
    });
    await harness.settle();

    assert.equal(rename.isConnected, false);
    assert.equal(
      harness.document.querySelector(
        '.session-entry[data-session-id="session-1"] .session-rename-input',
      ),
      null,
    );
    assert.equal(
      harness.document.querySelector(
        '.session-entry[data-session-id="session-1"] .session-title',
      )?.textContent,
      "Generated Bass title",
    );
    assert.equal(
      harness.document.activeElement,
      harness.document.querySelector(
        '.session-entry[data-session-id="session-1"] .session-row',
      ),
    );
    assert.match(
      harness.document.querySelector("#status")?.textContent || "",
      /title changed while you were editing/i,
    );
    assert.equal(
      commandCalls(harness).filter((call) =>
        (call.body as { kind?: string }).kind === "rename_session"
      ).length,
      0,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.releaseHeldSend();
    await harness.settle();
    harness.close();
  }
});

test("a clean Session rename adopts a new title without losing its selection", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Refresh the Session title");
    harness.click("#sendButton");
    await waitForCondition(
      () => harness.sendIds.length === 1,
      "Expected the send to stay active.",
    );
    const row = harness.document.querySelector<HTMLButtonElement>(
      '.session-entry[data-session-id="session-1"] .session-row',
    );
    assert.ok(row);
    row.dispatchEvent(new harness.window.KeyboardEvent("keydown", {
      key: "F2",
      bubbles: true,
    }));
    const rename = harness.document.querySelector<HTMLInputElement>(
      '.session-entry[data-session-id="session-1"] .session-rename-input',
    );
    assert.ok(rename);
    rename.setSelectionRange(0, 4);

    const authoritative = stateFixture();
    authoritative.openSettingsOnLoad = false;
    authoritative.sessions[0]!.title = "Generated Bass title";
    harness.emitServerEvent({
      type: "done",
      sendId: harness.sendIds[0],
      sessionId: "session-1",
      state: authoritative,
    });
    await harness.settle();

    assert.equal(rename.isConnected, true);
    assert.equal(rename.value, "Generated Bass title");
    assert.equal(rename.dataset.originalTitle, "Generated Bass title");
    assert.equal(harness.document.activeElement, rename);
    assert.equal(rename.selectionStart, 0);
    assert.equal(rename.selectionEnd, 4);
    rename.dispatchEvent(new harness.window.KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
    }));
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.releaseHeldSend();
    await harness.settle();
    harness.close();
  }
});

test("a send title update preserves an open Session menu and its focus", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  const ui = (harness.window as unknown as {
    LiveSmithUI: {
      runCommand(kind: string, extra?: Record<string, unknown>): Promise<boolean>;
    };
  }).LiveSmithUI;
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Keep the Session menu stable");
    harness.click("#sendButton");
    await waitForCondition(
      () => harness.sendIds.length === 1,
      "Expected the send to stay active.",
    );
    harness.click(
      '.session-entry[data-session-id="session-1"] .session-menu-button',
    );
    const entry = harness.document.querySelector(
      '.session-entry[data-session-id="session-1"]',
    );
    const menu = entry?.querySelector<HTMLElement>(".session-action-menu");
    const archive = entry?.querySelector<HTMLButtonElement>(
      '[data-session-action="archive"]',
    );
    assert.ok(entry);
    assert.ok(menu);
    assert.ok(archive);
    archive.focus();

    const authoritative = stateFixture();
    authoritative.openSettingsOnLoad = false;
    authoritative.sessions[0]!.title = "Generated Bass title";
    harness.emitServerEvent({
      type: "done",
      sendId: harness.sendIds[0],
      sessionId: "session-1",
      state: authoritative,
    });
    await harness.settle();

    assert.equal(
      harness.document.querySelector(
        '.session-entry[data-session-id="session-1"]',
      ),
      entry,
    );
    assert.equal(archive.isConnected, true);
    assert.equal(menu.hidden, false);
    assert.equal(harness.document.activeElement, archive);
    assert.equal(
      entry.querySelector(".session-title")?.textContent,
      "Generated Bass title",
    );

    const deleteAction = menu.querySelector<HTMLButtonElement>(
      '[data-session-action="delete"]',
    );
    assert.ok(deleteAction);
    deleteAction.click();
    const confirmation = menu.querySelector<HTMLElement>(
      ".session-delete-confirm",
    );
    assert.equal(
      confirmation?.getAttribute("aria-label"),
      "Delete session Generated Bass title",
    );

    const retitled = stateFixture();
    retitled.openSettingsOnLoad = false;
    retitled.sessions[0]!.title = "Retitled Bass session";
    harness.setServerState(retitled);
    assert.equal(
      await ui.runCommand("set_session_approval_mode", {
        sessionId: "session-1",
        approvalMode: "low-risk",
      }),
      true,
    );
    assert.equal(
      menu.querySelector(".session-delete-confirm"),
      confirmation,
    );
    assert.equal(
      confirmation?.getAttribute("aria-label"),
      "Delete session Retitled Bass session",
    );
    menu.querySelector<HTMLButtonElement>("[data-delete-cancel]")?.click();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.releaseHeldSend();
    await harness.settle();
    harness.close();
  }
});

test("command selects regain focus after their temporary lock", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const primaryProfile = profileFixture({
    models: [
      {
        model: "model-a",
        parameters: {
          maxOutputTokens: 8192,
          temperature: 0.4,
          reasoning: { mode: "default" },
        },
        advanced: {},
      },
      {
        model: "model-b",
        parameters: {
          maxOutputTokens: 8192,
          temperature: 0.4,
          reasoning: { mode: "default" },
        },
        advanced: {},
      },
    ],
  });
  state.settings.profiles[0] = primaryProfile;
  state.configuredModels = [
    { model: "model-a", label: "Model A" },
    { model: "model-b", label: "Model B" },
  ];
  state.modelStateSource = modelStateSourceFixture(primaryProfile);
  state.activeProfileRevision = profileRevisionFixture(primaryProfile);
  const harness = await createDialogHarness(state);
  const ui = (harness.window as unknown as {
    LiveSmithUI: {
      runCommand(kind: string, extra?: Record<string, unknown>): Promise<boolean>;
    };
  }).LiveSmithUI;
  async function expectFocusRestored(
    selector: string,
    kind: string,
    extra: Record<string, unknown>,
  ) {
    const control = harness.document.querySelector<HTMLSelectElement>(selector);
    assert.ok(control);
    assert.equal(control.disabled, false);
    control.focus();
    assert.equal(harness.document.activeElement, control);
    const previousCallCount = commandCalls(harness).length;
    harness.holdNextCommandResponse();
    const command = ui.runCommand(kind, extra);
    await waitForCondition(
      () => commandCalls(harness).length > previousCallCount,
      `Expected ${kind} to reach the bridge.`,
    );
    assert.equal(control.disabled, true);
    harness.document.body.tabIndex = -1;
    harness.document.body.focus();
    assert.equal(harness.document.activeElement, harness.document.body);
    harness.document.body.removeAttribute("tabindex");
    harness.releaseHeldCommandResponse();
    assert.equal(await command, true);
    await harness.settle();
    assert.equal(harness.document.activeElement, control);
  }
  try {
    await expectFocusRestored(
      "#composerModel",
      "set_session_model_selection",
      {
        sessionId: "session-1",
        profileId: "profile-1",
        model: "model-a",
        reasoningEffort: null,
      },
    );
    await expectFocusRestored(
      "#approvalMode",
      "set_session_approval_mode",
      {
        sessionId: "session-1",
        approvalMode: "low-risk",
      },
    );
    harness.click("#settingsButton");
    await expectFocusRestored(
      "#profileSelector",
      "activate_profile",
      { profileId: "profile-2" },
    );

    const approval = harness.document.querySelector<HTMLSelectElement>("#approvalMode");
    const profileName = harness.document.querySelector<HTMLInputElement>("#profileName");
    assert.ok(approval);
    assert.ok(profileName);
    harness.click("#settingsButton");
    approval.focus();
    const previousCallCount = commandCalls(harness).length;
    harness.holdNextCommandResponse();
    const command = ui.runCommand("set_session_approval_mode", {
      sessionId: "session-1",
      approvalMode: "everything",
    });
    await waitForCondition(
      () => commandCalls(harness).length > previousCallCount,
      "Expected the second Approval command to reach the bridge.",
    );
    harness.click("#settingsButton");
    profileName.focus();
    assert.equal(harness.document.activeElement, profileName);
    harness.releaseHeldCommandResponse();
    assert.equal(await command, true);
    await harness.settle();
    assert.equal(
      harness.document.activeElement,
      profileName,
      "unlocking must not steal focus the user moved elsewhere",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a Session lifecycle action restores focus to the moved Session controls", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    harness.click(
      '.session-entry[data-session-id="session-2"] .session-menu-button',
    );
    const archive = harness.document.querySelector<HTMLButtonElement>(
      '.session-entry[data-session-id="session-2"] [data-session-action="archive"]',
    );
    assert.ok(archive);
    archive.focus();
    harness.holdNextCommandResponse();
    archive.click();
    await waitForCondition(
      () => commandCalls(harness).some((call) =>
        (call.body as { kind?: string }).kind === "archive_session"
      ),
      "Expected the Archive command to reach the bridge.",
    );
    assert.equal(
      harness.document.activeElement,
      harness.document.querySelector(
        '.session-entry[data-session-id="session-2"] .session-menu-button',
      ),
    );
    harness.document.body.tabIndex = -1;
    harness.document.body.focus();
    harness.document.body.removeAttribute("tabindex");
    harness.releaseHeldCommandResponse();
    await harness.settle();

    const archivedEntry = harness.document.querySelector(
      '.archived-session-entry[data-session-id="session-2"]',
    );
    assert.ok(archivedEntry);
    assert.equal(
      harness.document.activeElement,
      archivedEntry.querySelector(".session-menu-button"),
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("deleting a focused Session moves focus to the remaining Session", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    harness.click(
      '.session-entry[data-session-id="session-2"] .session-menu-button',
    );
    harness.click(
      '.session-entry[data-session-id="session-2"] [data-session-action="delete"]',
    );
    const confirmDelete = harness.document.querySelector<HTMLButtonElement>(
      '.session-entry[data-session-id="session-2"] [data-delete-confirm]',
    );
    assert.ok(confirmDelete);
    confirmDelete.focus();
    harness.holdNextCommandResponse();
    confirmDelete.click();
    await waitForCondition(
      () => commandCalls(harness).some((call) =>
        (call.body as { kind?: string }).kind === "delete_session"
      ),
      "Expected the Delete command to reach the bridge.",
    );
    harness.document.body.tabIndex = -1;
    harness.document.body.focus();
    harness.document.body.removeAttribute("tabindex");
    harness.releaseHeldCommandResponse();
    await harness.settle();

    assert.equal(
      harness.document.querySelector(
        '.session-entry[data-session-id="session-2"]',
      ),
      null,
    );
    assert.equal(
      harness.document.activeElement,
      harness.document.querySelector(
        '.session-entry[data-session-id="session-1"] .session-row',
      ),
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("unchanged Skills restore focus after a Profile command without rebuilding", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  const ui = (harness.window as unknown as {
    LiveSmithUI: {
      runCommand(kind: string, extra?: Record<string, unknown>): Promise<boolean>;
    };
  }).LiveSmithUI;
  let commandReleased = false;
  try {
    const toggle = harness.document.querySelector<HTMLInputElement>(
      "#builtInSkillList input[type=checkbox]",
    );
    assert.ok(toggle);
    toggle.focus();
    harness.holdNextCommandResponse();
    const command = ui.runCommand("activate_profile", { profileId: "profile-2" });
    await waitForCondition(
      () => commandCalls(harness).some((call) =>
        (call.body as { kind?: string }).kind === "activate_profile"
      ),
      "Expected the Profile command to wait for its response.",
    );
    assert.equal(
      harness.document.activeElement,
      harness.document.querySelector("#skillManager"),
    );
    harness.releaseHeldCommandResponse();
    commandReleased = true;
    assert.equal(await command, true);

    assert.equal(toggle.isConnected, true);
    assert.equal(harness.document.activeElement, toggle);
    assert.deepEqual(harness.errors, []);
  } finally {
    if (!commandReleased) harness.releaseHeldCommandResponse();
    await harness.settle();
    harness.close();
  }
});

test("switching Sessions refreshes Skill values while a send keeps them locked", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  state.sessions[1]!.activeSkillIds = ["arranging-section-energy"];
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Keep the Bass send active");
    harness.click("#sendButton");
    await waitForCondition(
      () => harness.sendIds.length === 1,
      "Expected the Bass send to start.",
    );
    harness.click('.session-entry[data-session-id="session-2"] .session-row');
    await harness.settle();

    const toggle = harness.document.querySelector<HTMLInputElement>(
      '[data-skill-id="arranging-section-energy"] input[type=checkbox]',
    );
    assert.equal(toggle?.checked, true);
    assert.equal(toggle?.disabled, true);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.releaseHeldSend();
    await harness.settle();
    harness.close();
  }
});

test("Session rows introduced during a file operation inherit its lock", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  let releaseSecondRead: (() => void) | null = null;
  try {
    const authoritative = stateFixture();
    authoritative.openSettingsOnLoad = false;
    authoritative.sessions.push({
      id: "session-3",
      title: "New peer Session",
      projectKey: "project-1",
      scope: { kind: "track", identity: "track-peer", label: "Peer" },
      createdAt: "2026-08-25T00:00:00.000Z",
      updatedAt: "2026-08-25T00:00:00.000Z",
    });
    harness.setServerState(authoritative);

    const first = documentFile(
      harness.window,
      "first.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    const second = documentFile(
      harness.window,
      "second.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    const bytes = new Uint8Array(24).buffer;
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    releaseSecondRead = releaseGate;
    Object.defineProperty(second, "arrayBuffer", {
      configurable: true,
      value: async () => {
        await gate;
        return bytes.slice(0);
      },
    });

    harness.dropAttachmentFiles([first, second]);
    await waitForCondition(
      () => Boolean(
        harness.document.querySelector('[data-attachment-id="attachment-1"]') &&
        harness.document.querySelector('.session-entry[data-session-id="session-3"]'),
      ),
      "Expected the first file state before the second file read completed.",
    );
    assert.equal(
      harness.document.querySelector(".sessions-pane")?.getAttribute("aria-busy"),
      "true",
    );
    assert.equal(
      harness.document.querySelector<HTMLButtonElement>(
        '.session-entry[data-session-id="session-3"] .session-row',
      )?.disabled,
      true,
    );

    releaseSecondRead();
    releaseSecondRead = null;
    await harness.settleAttachmentOperation();
    assert.deepEqual(harness.errors, []);
  } finally {
    releaseSecondRead?.();
    await harness.settleAttachmentOperation();
    harness.close();
  }
});
