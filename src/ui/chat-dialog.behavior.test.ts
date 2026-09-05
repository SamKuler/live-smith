import assert from "node:assert/strict";
import test from "node:test";

import type { DirectApiProfile, SavedProfile } from "../model/profile.js";
import { INSPECTOR_DRAWER_MAX_WIDTH } from "./chat-document.js";
import type { ChatDialogState } from "./chat-state.js";
import {
  capabilities,
  capabilityEvidence,
  cloneState,
  commandCalls,
  createDialogHarness,
  jsonCalls,
  modelStateSourceFixture,
  profileFixture,
  renderedCapabilityStatuses,
  stateFixture,
  waitForCondition,
} from "./chat-dialog.test-harness.js";

test("real script boots and Add then Discard restores the saved profile", async () => {
  const harness = await createDialogHarness();
  try {
    const selector = harness.document.querySelector<HTMLSelectElement>("#profileSelector");
    assert.equal(selector?.value, "profile-1");
    assert.deepEqual(harness.eventSourceUrls, [
      "http://bridge.test/events?token=test-token",
    ]);
    assert.equal(harness.document.activeElement?.id, "profileName");

    harness.clickButton("Add");
    assert.equal(harness.document.querySelector("#draftStatus")?.textContent, "Unsaved changes");
    assert.equal(
      [...(selector?.options ?? [])].some((option) => option.text === "Unsaved profile"),
      true,
    );

    harness.click("#discardProfileButton");
    assert.equal(selector?.value, "profile-1");
    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#profileName")?.value,
      "Studio",
    );
    assert.equal(harness.document.querySelector("#draftStatus")?.textContent, "Saved");
    assert.equal(
      [...(selector?.options ?? [])].some((option) => option.text === "Unsaved profile"),
      false,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a valid Profile starts in chat-first mode and exposes an accessible Inspector", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    const app = harness.document.querySelector(".app");
    const inspector = harness.document.querySelector<HTMLElement>("#inspectorPane");
    const profileControl = harness.document.querySelector<HTMLButtonElement>(
      "#settingsButton",
    );
    assert.equal(harness.document.querySelector("#inspectorToggleButton"), null);
    assert.equal(app?.classList.contains("inspector-open"), false);
    assert.equal(inspector?.hidden, true);
    assert.equal(profileControl?.getAttribute("aria-expanded"), "false");
    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value,
      "",
    );
    assert.equal(
      harness.document.querySelector<HTMLElement>("#modelSetupGuide")?.hidden,
      true,
    );
    assert.equal(harness.document.activeElement?.id, "prompt");
    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#composerModel")?.value,
      "model-a",
    );

    profileControl?.click();

    assert.equal(app?.classList.contains("inspector-open"), true);
    assert.equal(inspector?.hidden, false);
    assert.equal(profileControl?.getAttribute("aria-expanded"), "true");
    assert.equal(
      profileControl?.getAttribute("aria-label"),
      "Close Inspector",
    );
    assert.equal(
      harness.document.querySelector("#agentTab")?.getAttribute("aria-selected"),
      "true",
    );
    profileControl?.click();
    assert.equal(inspector?.hidden, true);
    assert.equal(profileControl?.getAttribute("aria-expanded"), "false");
    profileControl?.click();

    harness.click("#contextTab");
    assert.equal(
      harness.document.querySelector("#contextTab")?.getAttribute("aria-selected"),
      "true",
    );
    assert.equal(
      harness.document.querySelector<HTMLElement>("#contextPanel")?.hidden,
      false,
    );
    harness.document.querySelector("#contextTab")?.dispatchEvent(
      new harness.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    assert.equal(
      harness.document.querySelector("#agentTab")?.getAttribute("aria-selected"),
      "true",
    );
    harness.document.querySelector("#agentTab")?.dispatchEvent(
      new harness.window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
    );
    assert.equal(
      harness.document.querySelector("#contextTab")?.getAttribute("aria-selected"),
      "true",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("the narrow Inspector drawer isolates covered chat and restores focus on close", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    const setViewportWidth = (width: number) => {
      Object.defineProperty(harness.window, "innerWidth", {
        configurable: true,
        value: width,
      });
      harness.window.dispatchEvent(new harness.window.Event("resize"));
    };
    setViewportWidth(INSPECTOR_DRAWER_MAX_WIDTH);

    const chat = harness.document.querySelector<HTMLElement>(".chat-pane");
    const prompt = harness.document.querySelector<HTMLTextAreaElement>("#prompt");
    const settings = harness.document.querySelector<HTMLButtonElement>("#settingsButton");
    assert.equal(chat?.hasAttribute("inert"), false);
    assert.equal(harness.document.activeElement, prompt);

    settings?.click();
    assert.equal(chat?.hasAttribute("inert"), true);
    assert.equal(harness.document.activeElement?.id, "agentTab");

    setViewportWidth(INSPECTOR_DRAWER_MAX_WIDTH + 1);
    assert.equal(chat?.hasAttribute("inert"), false);
    prompt?.focus();
    assert.equal(harness.document.activeElement, prompt);

    setViewportWidth(INSPECTOR_DRAWER_MAX_WIDTH);
    assert.equal(chat?.hasAttribute("inert"), true);
    assert.equal(harness.document.activeElement?.id, "agentTab");

    settings?.click();
    assert.equal(chat?.hasAttribute("inert"), false);
    assert.equal(harness.document.activeElement, settings);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("the dialog exposes accessible names, tabs, and live status semantics", async () => {
  const harness = await createDialogHarness();
  try {
    assert.equal(
      harness.document.querySelector("#prompt")?.getAttribute("aria-label"),
      "Message Live Smith",
    );
    for (const [selector, label] of [
      ["#closeButton", "Close Live Smith"],
      ["#newSessionButton", "New Session"],
    ] as const) {
      assert.equal(harness.document.querySelector(selector)?.getAttribute("aria-label"), label);
    }
    assert.equal(
      harness.document.querySelector('[data-session-menu-button="session-1"]')
        ?.getAttribute("aria-label"),
      "Session actions for Bass session",
    );
    const status = harness.document.querySelector("#status");
    assert.equal(status?.getAttribute("role"), "status");
    assert.equal(status?.getAttribute("aria-live"), "polite");
    assert.equal(status?.getAttribute("aria-atomic"), "true");
    assert.equal(
      harness.document.querySelector(".tab-bar")?.getAttribute("role"),
      "tablist",
    );
    assert.equal(harness.document.querySelector("#agentTab")?.getAttribute("role"), "tab");
    assert.equal(harness.document.querySelector("#appTab")?.getAttribute("role"), "tab");
    assert.equal(
      harness.document.querySelector("#agentPanel")?.getAttribute("role"),
      "tabpanel",
    );
    for (const selector of ["#agentPanel", "#appPanel", "#contextPanel"]) {
      assert.equal(harness.document.querySelector(selector)?.getAttribute("tabindex"), "0");
    }
    assert.equal(
      harness.document.querySelector("#modelSetupGuideHeading")?.tagName,
      "H3",
    );
    assert.equal(
      harness.document.querySelector("#oauthAuthHeading")?.tagName,
      "H4",
    );
    assert.equal(
      harness.document.querySelector("#apiMode")?.getAttribute("aria-describedby"),
      null,
    );
    assert.equal(
      harness.document.querySelector("#baseUrl")?.getAttribute("aria-describedby"),
      null,
    );
    assert.equal(harness.document.getElementById("apiModeHelp"), null);
    assert.equal(harness.document.getElementById("followUpSettingsOwnerHelp"), null);
    for (const id of ["baseUrlHelp", "discoverModelsHelp"]) {
      const help = harness.document.getElementById(id);
      assert.equal(help?.tabIndex, 0);
      assert.equal(help?.getAttribute("role"), "note");
      assert.equal(help?.dataset.tooltip, help?.getAttribute("aria-label"));
    }
    harness.document.getElementById("discoverModelsHelp")?.focus();
    assert.equal(harness.document.activeElement?.id, "discoverModelsHelp");
    for (const section of [
      "#profileSettingsSection",
      "#connectionSettingsSection",
      "#modelSettingsSection",
      "#capabilitySettingsSection",
      "#generationSettings",
      "#advancedSettings",
      "#followUpSettingsSection",
    ]) assert.ok(harness.document.querySelector(section));
    const approvalMode = harness.document.querySelector<HTMLSelectElement>("#approvalMode");
    assert.equal(approvalMode?.getAttribute("aria-label"), "Apply approval mode");
    assert.deepEqual(
      [...(approvalMode?.options ?? [])].map((option) => [option.value, option.textContent]),
      [
        ["manual", "Manual"],
        ["low-risk", "Low Risk"],
        ["everything", "Accept Everything"],
      ],
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("the compact composer uses one attachment menu and no unsupported file picker", async () => {
  const harness = await createDialogHarness();
  try {
    assert.equal(harness.document.querySelector(".attachment-actions"), null);
    assert.equal(harness.document.querySelector("#attachFileButton"), null);
    assert.equal(harness.document.querySelector("#attachmentInput"), null);
    assert.equal(
      harness.document.querySelector("#prompt")?.getAttribute("placeholder"),
      "Describe your idea…",
    );
    assert.match(
      harness.document.querySelector("#sendButton")?.getAttribute("aria-keyshortcuts") ?? "",
      /Meta\+Enter.*Control\+Enter/,
    );

    const menuButton = harness.document.querySelector<HTMLButtonElement>(
      "#attachmentMenuButton",
    );
    const menu = harness.document.querySelector<HTMLElement>("#attachmentMenu");
    assert.equal(menuButton?.getAttribute("aria-expanded"), "false");
    assert.equal(menu?.hidden, true);

    harness.click("#attachmentMenuButton");
    assert.equal(menuButton?.getAttribute("aria-expanded"), "true");
    assert.equal(menu?.hidden, false);
    assert.match(menu?.textContent ?? "", /drop or paste files/i);

    harness.document.dispatchEvent(
      new harness.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    assert.equal(menu?.hidden, true);
    assert.equal(menuButton?.getAttribute("aria-expanded"), "false");
    assert.equal(harness.document.activeElement, menuButton);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("first-run model setup is primary while advanced controls stay collapsed", async () => {
  const state = stateFixture();
  state.settings.profiles = [];
  state.settings.activeProfileId = null;
  state.activeProfileRevision = null;
  state.runtimeProfile = null;
  state.modelStateSource = null;
  state.availableModels = [];
  const harness = await createDialogHarness(state);
  try {
    assert.equal(
      harness.document.querySelector<HTMLElement>("#inspectorPane")?.hidden,
      false,
    );
    assert.equal(
      harness.document.querySelector("#agentTab")?.getAttribute("aria-selected"),
      "true",
    );
    const guide = harness.document.querySelector("#modelSetupGuide");
    assert.deepEqual(
      [...(guide?.querySelectorAll("li") ?? [])].map((item) => item.textContent),
      ["Enter connection details.", "Load Models.", "Save & Use."],
    );
    assert.equal(
      harness.document.querySelector<HTMLElement>("#savedProfileControls")?.hidden,
      true,
    );
    assert.equal(guide?.hasAttribute("tabindex"), false);
    assert.equal(harness.document.activeElement?.id, "profileName");
    assert.equal(
      harness.document.querySelector("#profileSettingsSection")?.nextElementSibling?.id,
      "connectionSettingsSection",
    );
    assert.equal(
      harness.document.querySelector("#modelSettingsSection")?.contains(
        harness.document.querySelector("#modelConfigSelector"),
      ),
      true,
    );
    assert.match(
      harness.document.querySelector("#discoverModelsButton")?.textContent ?? "",
      /load models/i,
    );
    assert.match(
      harness.document.querySelector("#saveProfileButton")?.textContent ?? "",
      /save.*use/i,
    );
    for (const selector of ["#generationSettings", "#advancedSettings"]) {
      assert.equal(
        harness.document.querySelector<HTMLDetailsElement>(selector)?.open,
        false,
        `${selector} should be collapsed initially`,
      );
    }
    for (const removedDisclosure of [
      "#inputOverrideSettings",
      "#generationOverrideSettings",
      "#reasoningOverrideSettings",
      "#extraBodySettings",
    ]) assert.equal(harness.document.querySelector(removedDisclosure), null);
    assert.equal(
      harness.document.querySelector("#skillManager")?.closest("#agentPanel")?.id,
      "agentPanel",
    );
    harness.click("#appTab");
    assert.equal(
      harness.document.querySelector<HTMLElement>("#appPanel")?.hidden,
      false,
    );
    assert.equal(
      harness.document.querySelector<HTMLElement>("#agentPanel")?.hidden,
      true,
    );
    harness.click("#agentTab");
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("the compact workbench prioritizes chat and makes model connection sequential", async () => {
  const harness = await createDialogHarness();
  try {
    const app = harness.document.querySelector<HTMLElement>(".app");
    assert.equal(harness.document.querySelector("#inspectorToggleButton"), null);
    assert.equal(
      harness.document.querySelector("#apiFamily option")?.textContent,
      "OpenAI",
    );
    assert.deepEqual(
      [...harness.document.querySelectorAll("#apiFamily option")].map(
        (option) => option.textContent,
      ),
      ["OpenAI", "Anthropic"],
    );
    const connectionHelp = [...harness.document.querySelectorAll<HTMLElement>(
      "#connectionSettingsSection .inline-help",
    )];
    assert.equal(connectionHelp.length, 3);
    assert.ok(connectionHelp.some((help) =>
      /official and compatible endpoints/i.test(help.getAttribute("aria-label") ?? "")
    ));
    assert.ok(connectionHelp.some((help) =>
      /optional.*local.*loopback/i.test(help.getAttribute("aria-label") ?? "")
    ));
    assert.deepEqual(
      connectionHelp.map((help) => [help.textContent, help.tabIndex, help.dataset.tooltip]),
      connectionHelp.map((help) => ["?", 0, help.getAttribute("aria-label")]),
    );
    assert.equal(
      harness.document.querySelector('label[for="apiMode"]')?.textContent,
      "Request format",
    );
    const discover = harness.document.querySelector("#discoverModelsButton")!;
    const modelField = harness.document.querySelector("#modelConfigSelector")!;
    assert.equal(
      Boolean(discover.compareDocumentPosition(modelField) &
        harness.window.Node.DOCUMENT_POSITION_FOLLOWING),
      true,
    );
    assert.equal(discover.closest(".model-load-row") !== null, true);
    assert.equal(
      harness.document.querySelectorAll("#advancedSettingsSection > details").length,
      0,
    );
    assert.ok(harness.document.querySelector("#advancedSettings > .advanced-groups"));
    assert.equal(app?.classList.contains("inspector-open"), true);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("Model Behavior exposes generation before compatibility overrides", async () => {
  const harness = await createDialogHarness();
  try {
    assert.equal(harness.document.querySelector("#generationSettingsSection"), null);
    const disclosures = ["#generationSettings", "#advancedSettings"].map(
      (selector) => harness.document.querySelector<HTMLDetailsElement>(selector)!,
    );
    assert.deepEqual(
      disclosures.map((details) =>
        details.querySelector(".settings-disclosure-title")?.textContent
      ),
      ["Generation", "Compatibility Overrides"],
    );
    for (const details of disclosures) {
      assert.equal(details.parentElement?.id, "capabilitySettingsSection");
      assert.equal(details.classList.contains("top-level-settings"), true);
      const summary = details.querySelector("summary")!;
      const chevron = summary.querySelector(".settings-disclosure-chevron");
      assert.equal(chevron?.getAttribute("aria-hidden"), "true");
      assert.equal(summary.querySelector("small"), null);
      summary.dispatchEvent(new harness.window.MouseEvent("click", { bubbles: true }));
      assert.equal(details.open, true);
    }
    assert.match(
      disclosures[1]?.textContent ?? "",
      /Cannot override protected request fields/i,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("Context renders a safe Live-object card with scannable properties", async () => {
  const state = stateFixture();
  state.contextSummary = [
    'MIDI track "Bass <img src=x onerror=alert(1)>"',
    "mute=false, solo=true, armed=false",
    "arrangement clips=2",
    "devices=Operator, EQ Eight",
  ].join("\n");
  const harness = await createDialogHarness(state);
  try {
    harness.click("#contextTab");
    const shell = harness.document.querySelector("#context > .context-shell");
    assert.ok(shell);
    assert.equal(shell.querySelector(":scope > .context-header") !== null, true);
    assert.equal(shell.querySelector(":scope > .context-card") !== null, true);
    assert.equal(
      harness.document.querySelector("#context .context-title")?.textContent,
      'MIDI track "Bass <img src=x onerror=alert(1)>"',
    );
    assert.equal(harness.document.querySelector("#context img"), null);
    assert.deepEqual(
      [...harness.document.querySelectorAll("#context .context-property")].map(
        (item) => [
          item.querySelector(".context-property-label")?.textContent,
          item.querySelector(".context-property-value")?.textContent,
        ],
      ),
      [
        ["MUTE", "false"],
        ["SOLO", "true"],
        ["ARMED", "false"],
        ["ARRANGEMENT CLIPS", "2"],
        ["DEVICES", "Operator, EQ Eight"],
      ],
    );
    assert.equal(
      harness.document.querySelector("#context .context-header h2")?.textContent,
      "Live Context",
    );
    assert.equal(
      harness.document.querySelector("#context .context-title")?.tagName,
      "H3",
    );
    assert.equal(harness.document.querySelector("#context .context-snapshot-label"), null);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("first-run setup connects, selects a discovered model, and saves it for use", async () => {
  const state = stateFixture();
  state.settings.profiles = [];
  state.settings.activeProfileId = null;
  state.activeProfileRevision = null;
  state.runtimeProfile = null;
  state.modelStateSource = null;
  state.availableModels = [];
  const harness = await createDialogHarness(state);
  try {
    harness.input("#profileName", "Studio model");
    harness.input("#apiKey", "");
    harness.input("#baseUrl", "http://localhost:1234/v1");
    harness.input("#maxOutputTokens", "6000");
    harness.click("#discoverModelsButton");
    await harness.settle();

    assert.equal(
      harness.document.querySelector("#profileModelCount")?.textContent,
      "1 model",
    );
    assert.deepEqual(
      [...harness.document.querySelectorAll<HTMLOptionElement>(
        "#modelConfigSelector option",
      )].map((option) => option.textContent),
      ["Discovered model · model-discovered · Default"],
    );
    harness.click("#saveProfileButton");
    await harness.settle();

    const savedProfile = (commandCalls(harness).at(-1)?.body as {
      profile: {
        connection: { apiKey: string; baseUrl: string };
        models: Array<{ model: string; parameters: { maxOutputTokens: number } }>;
      };
    }).profile;
    assert.equal(savedProfile.connection.apiKey, "");
    assert.equal(savedProfile.connection.baseUrl, "http://localhost:1234/v1");
    assert.equal(savedProfile.models[0]?.parameters.maxOutputTokens, 6000);

    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#composerModel")?.value,
      "model-discovered",
    );
    assert.equal(
      harness.document.querySelector<HTMLElement>("#modelSetupGuide")?.hidden,
      true,
    );
    assert.equal(
      harness.document.querySelector<HTMLElement>("#savedProfileControls")?.hidden,
      false,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("Accept Everything saves without confirmation and remains visibly dangerous", async () => {
  const harness = await createDialogHarness();
  try {
    harness.select("#approvalMode", "everything");
    await harness.settle();

    assert.deepEqual(commandCalls(harness).at(-1), {
      path: "/command",
      body: {
        kind: "set_session_approval_mode",
        sessionId: "session-1",
        approvalMode: "everything",
      },
    });
    const control = harness.document.querySelector<HTMLSelectElement>("#approvalMode");
    assert.equal(control?.value, "everything");
    assert.equal(control?.classList.contains("is-everything"), true);
    assert.match(
      control?.closest("label")?.getAttribute("title") ?? "",
      /including deletes and replacement writes/i,
    );

    harness.select("#approvalMode", "manual");
    await harness.settle();
    assert.equal(control?.classList.contains("is-everything"), false);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("Apply approval mode follows the selected Session", async () => {
  const harness = await createDialogHarness();
  try {
    harness.select("#approvalMode", "everything");
    await harness.settle();

    harness.click('.session-entry[data-session-id="session-2"] .session-row');
    await harness.settle();
    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#approvalMode")?.value,
      "low-risk",
    );

    harness.click('.session-entry[data-session-id="session-1"] .session-row');
    await harness.settle();
    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#approvalMode")?.value,
      "everything",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a Session approval update from another dialog refreshes the active control", async () => {
  const harness = await createDialogHarness();
  try {
    const row = harness.document.querySelector(
      '.session-entry[data-session-id="session-1"] .session-row',
    );
    const meta = harness.document.querySelector<HTMLElement>(
      '.session-entry[data-session-id="session-1"] .session-meta',
    );
    assert.ok(row);
    assert.ok(meta);
    const previousTimestamp = meta.title;
    harness.emitServerEvent({
      type: "approval_mode_changed",
      sessionId: "session-1",
      approvalMode: "everything",
      updatedAt: "2026-08-25T00:00:00.000Z",
    });

    const control = harness.document.querySelector<HTMLSelectElement>("#approvalMode");
    assert.equal(control?.value, "everything");
    assert.equal(control?.classList.contains("is-everything"), true);
    assert.match(
      control?.closest("label")?.getAttribute("title") ?? "",
      /including deletes and replacement writes/i,
    );
    assert.equal(
      harness.document.querySelector(
        '.session-entry[data-session-id="session-1"] .session-row',
      ),
      row,
    );
    assert.notEqual(meta.title, previousTimestamp);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("Profile actions stay local to Model Profile before Session Skills", async () => {
  const harness = await createDialogHarness();
  try {
    const panel = harness.document.querySelector<HTMLElement>("#agentPanel");
    const profile = harness.document.querySelector<HTMLElement>("#modelProfileSettings");
    const actions = harness.document.querySelector<HTMLElement>(".settings-actions");
    const skills = harness.document.querySelector<HTMLElement>("#skillManager");

    assert.ok(panel);
    assert.ok(profile);
    assert.ok(actions);
    assert.ok(skills);
    assert.equal(actions.parentElement?.id, "modelProfileControls");
    assert.equal(profile.contains(actions), true);
    assert.equal(panel.contains(actions), true);
    assert.equal(
      Boolean(actions.compareDocumentPosition(skills) &
        harness.window.Node.DOCUMENT_POSITION_FOLLOWING),
      true,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("closing a dirty Profile uses an in-page confirmation instead of native confirm", async () => {
  const harness = await createDialogHarness();
  try {
    harness.input("#profileName", "Unsaved studio");
    const closeButton = harness.document.querySelector<HTMLButtonElement>(
      "#closeButton",
    );
    const app = harness.document.querySelector<HTMLElement>(".app");
    const setAppAttribute = app!.setAttribute.bind(app);
    app!.setAttribute = (name, value) => {
      if (name === "inert") closeButton?.blur();
      setAppAttribute(name, value);
    };
    closeButton?.focus();
    harness.click("#closeButton");

    const confirmation = harness.document.querySelector<HTMLElement>(
      "#appConfirmation",
    );
    assert.equal(confirmation?.hidden, false);
    assert.equal(confirmation?.getAttribute("role"), "alertdialog");
    assert.match(
      confirmation?.querySelector("#appConfirmationMessage")?.textContent ?? "",
      /discard unsaved profile changes/i,
    );
    const cancel = confirmation?.querySelector<HTMLButtonElement>(
      "#appConfirmationCancel",
    );
    const accept = confirmation?.querySelector<HTMLButtonElement>(
      "#appConfirmationAccept",
    );
    assert.equal(harness.document.activeElement, cancel);
    assert.equal(
      harness.document.querySelector(".app")?.hasAttribute("inert"),
      true,
    );
    assert.deepEqual(harness.hostMessages, []);

    cancel?.dispatchEvent(new harness.window.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Tab",
      shiftKey: true,
    }));
    assert.equal(harness.document.activeElement, accept);
    accept?.dispatchEvent(new harness.window.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Tab",
    }));
    assert.equal(harness.document.activeElement, cancel);
    closeButton?.focus();
    closeButton?.dispatchEvent(new harness.window.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Tab",
    }));
    assert.equal(harness.document.activeElement, cancel);
    cancel?.dispatchEvent(new harness.window.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Escape",
    }));
    await Promise.resolve();
    assert.equal(confirmation?.hidden, true);
    assert.equal(
      harness.document.querySelector(".app")?.hasAttribute("inert"),
      false,
    );
    assert.equal(harness.document.activeElement, closeButton);

    harness.click("#closeButton");
    harness.click("#appConfirmationAccept");
    await Promise.resolve();
    assert.deepEqual(JSON.parse(JSON.stringify(harness.hostMessages)), [{
      method: "close_and_send",
      params: [JSON.stringify({ kind: "close" })],
    }]);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("closing while a send is active requires explicit confirmation", async () => {
  const harness = await createDialogHarness();
  try {
    harness.input("#prompt", "Keep working");
    harness.holdNextSend();
    harness.click("#sendButton");
    await Promise.resolve();

    harness.click("#closeButton");
    await harness.cancelAppConfirmation();

    assert.deepEqual(harness.hostMessages, []);
    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("Escape dismisses only the top close confirmation while Live Apply waits", async () => {
  const harness = await createDialogHarness();
  try {
    harness.input("#prompt", "Keep the Live confirmation pending");
    harness.holdNextSend();
    harness.click("#sendButton");
    await Promise.resolve();
    const sendId = harness.sendIds[0];
    assert.ok(sendId);
    harness.emitServerEvent({
      type: "confirm_request",
      sendId,
      sessionId: "session-1",
      id: "confirm-under-close",
      message: "Change the Live Set.",
      groups: [{ title: "Mix", rows: ["Set tempo to 124 BPM"] }],
    });
    assert.ok(harness.document.querySelector(".confirm-card"));

    harness.click("#closeButton");
    assert.equal(
      harness.document.querySelector<HTMLElement>("#appConfirmation")?.hidden,
      false,
    );
    harness.document.dispatchEvent(new harness.window.KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    }));
    await Promise.resolve();

    assert.equal(
      harness.document.querySelector<HTMLElement>("#appConfirmation")?.hidden,
      true,
    );
    assert.ok(harness.document.querySelector(".confirm-card"));
    assert.deepEqual(jsonCalls(harness, "/confirm"), []);

    harness.click("[data-confirm-cancel]");
    await harness.settle();
    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("API key visibility exposes an accessible Show and Hide state", async () => {
  const harness = await createDialogHarness();
  try {
    const field = harness.document.querySelector<HTMLInputElement>("#apiKey");
    const toggle = harness.document.querySelector<HTMLButtonElement>(
      "#apiKeyVisibilityButton",
    );
    assert.equal(field?.type, "password");
    assert.equal(toggle?.textContent, "Show");
    assert.equal(toggle?.getAttribute("aria-pressed"), "false");

    toggle?.click();
    assert.equal(field?.type, "text");
    assert.equal(toggle?.textContent, "Hide");
    assert.equal(toggle?.getAttribute("aria-pressed"), "true");

    toggle?.click();
    assert.equal(field?.type, "password");
    assert.equal(toggle?.textContent, "Show");
    assert.equal(toggle?.getAttribute("aria-pressed"), "false");
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("current Session actions keep deletion confirmation in the action menu", async () => {
  const harness = await createDialogHarness();
  try {
    assert.equal(harness.document.querySelector("#renameSessionButton"), null);
    assert.equal(harness.document.querySelector("#deleteSession"), null);
    harness.click('[data-session-menu-button="session-1"]');
    harness.click('[data-session-id="session-1"] [data-session-action="rename"]');
    const cancelledRename = harness.document.querySelector<HTMLInputElement>(
      ".session-rename-input",
    );
    assert.ok(cancelledRename);
    cancelledRename.value = "Do not save this";
    cancelledRename.dispatchEvent(new harness.window.KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
    }));
    await harness.settle();
    assert.equal(
      commandCalls(harness).some(
        (call) => (call.body as { kind?: string }).kind === "rename_session",
      ),
      false,
    );

    harness.click('[data-session-menu-button="session-1"]');
    harness.click('[data-session-id="session-1"] [data-session-action="delete"]');
    const deletingRow = harness.document.querySelector<HTMLElement>(
      '[data-session-id="session-1"] .session-row',
    );
    assert.ok(deletingRow);
    assert.equal(deletingRow.hidden, false);
    assert.equal(deletingRow.style.visibility, "");
    assert.equal(
      harness.document.querySelector<HTMLElement>(
        '[data-session-menu-button="session-1"]',
      )?.hidden,
      false,
    );
    const singleDeleteConfirmation = harness.document.querySelector<HTMLElement>(
      '.session-delete-confirm[data-delete-session-id="session-1"]',
    );
    assert.ok(singleDeleteConfirmation);
    assert.equal(singleDeleteConfirmation.className, "session-delete-confirm");
    assert.ok(singleDeleteConfirmation.closest(".session-action-menu"));
    assert.equal(
      singleDeleteConfirmation.querySelector(".session-delete-question")?.textContent,
      "Delete this session?",
    );
    assert.equal(
      harness.document.querySelector(
        '[data-session-menu-button="session-1"]',
      )?.getAttribute("aria-expanded"),
      "true",
    );
    harness.click('[data-delete-session-id="session-1"] [data-delete-cancel]');
    assert.equal(
      commandCalls(harness).some(
        (call) => (call.body as { kind?: string }).kind === "delete_session",
      ),
      false,
    );

    const activeRow = harness.document.querySelector<HTMLButtonElement>(
      '.session-row[aria-pressed="true"]',
    );
    activeRow?.dispatchEvent(new harness.window.KeyboardEvent("keydown", {
      key: "F2",
      bubbles: true,
    }));
    assert.ok(harness.document.querySelector(".session-rename-input"));
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("focused Sessions use macOS Backspace and Windows Delete with the existing confirmation", async () => {
  const harness = await createDialogHarness();
  try {
    const row = harness.document.querySelector<HTMLButtonElement>(
      '[data-session-id="session-1"] .session-row',
    );
    assert.ok(row);
    assert.equal(row.getAttribute("aria-keyshortcuts"), "Backspace Delete");
    row.focus();
    row.dispatchEvent(new harness.window.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Backspace",
    }));
    assert.equal(
      harness.document.querySelector<HTMLElement>(
        ".session-delete-confirm",
      )?.dataset.deleteSessionId,
      "session-1",
    );
    harness.click(".session-delete-confirm [data-delete-cancel]");

    row.focus();
    row.dispatchEvent(new harness.window.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Delete",
    }));
    assert.equal(
      harness.document.querySelector<HTMLElement>(
        ".session-delete-confirm",
      )?.dataset.deleteSessionId,
      "session-1",
    );
    harness.click(".session-delete-confirm [data-delete-cancel]");

    const prompt = harness.document.querySelector<HTMLTextAreaElement>("#prompt")!;
    prompt.focus();
    prompt.dispatchEvent(new harness.window.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Backspace",
    }));
    assert.equal(harness.document.querySelector(".session-delete-confirm"), null);
    assert.deepEqual(commandCalls(harness), []);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("Cmd and Shift select Session ranges for bulk lifecycle actions", async () => {
  const state = stateFixture();
  state.previousSessions = [{
    id: "session-previous",
    title: "Previous drum arrangement",
    projectKey: "previous-activation",
    scope: { kind: "track", identity: "old-drum-handle", label: "Drums" },
    createdAt: "2026-07-31T00:00:00.000Z",
    updatedAt: "2026-07-31T00:15:00.000Z",
  }];
  const harness = await createDialogHarness(state);
  try {
    const first = harness.document.querySelector<HTMLElement>(
      '[data-session-id="session-1"] .session-row',
    );
    const previous = harness.document.querySelector<HTMLElement>(
      '[data-session-id="session-previous"] .session-row',
    );
    assert.ok(first);
    assert.ok(previous);

    first.dispatchEvent(new harness.window.MouseEvent("click", {
      bubbles: true,
      metaKey: true,
    }));
    previous.dispatchEvent(new harness.window.MouseEvent("click", {
      bubbles: true,
      shiftKey: true,
    }));

    assert.deepEqual(
      [...harness.document.querySelectorAll<HTMLElement>(".session-entry[data-selected]")]
        .map((entry) => entry.dataset.sessionId),
      ["session-1", "session-2", "session-previous"],
    );
    assert.equal(
      harness.document.querySelector("#sessionSelectionCount")?.textContent,
      "3 selected",
    );
    assert.deepEqual(commandCalls(harness), []);

    harness.click('[data-session-menu-button="session-previous"]');
    assert.equal(
      harness.document.querySelector(
        '[data-session-id="session-previous"] [data-session-action="rename"]',
      ),
      null,
    );
    assert.match(
      harness.document.querySelector(
        '[data-session-id="session-previous"] [data-session-action="archive"]',
      )?.textContent ?? "",
      /Archive 3 Sessions/,
    );
    assert.match(
      harness.document.querySelector(
        '[data-session-id="session-previous"] [data-session-action="delete"]',
      )?.textContent ?? "",
      /Delete 3 Sessions/,
    );

    harness.click(
      '[data-session-id="session-previous"] [data-session-action="delete"]',
    );
    const bulkDeleteConfirmation = harness.document.querySelector<HTMLElement>(
      ".session-delete-confirm",
    );
    assert.ok(bulkDeleteConfirmation);
    assert.equal(bulkDeleteConfirmation.className, "session-delete-confirm");
    assert.equal(
      bulkDeleteConfirmation.querySelector(".session-delete-question")?.textContent,
      "Delete 3 sessions?",
    );
    const bulkDeleteMenu = bulkDeleteConfirmation.closest<HTMLElement>(
      ".session-action-menu",
    );
    assert.ok(bulkDeleteMenu);
    assert.equal(
      bulkDeleteMenu.closest<HTMLElement>(".session-entry")?.dataset.sessionId,
      "session-previous",
    );
    assert.equal(bulkDeleteMenu.hidden, false);
    assert.equal(
      harness.document.querySelector(
        '[data-session-menu-button="session-previous"]',
      )?.getAttribute("aria-expanded"),
      "true",
    );
    for (const sessionId of ["session-1", "session-2", "session-previous"]) {
      assert.equal(
        harness.document.querySelector<HTMLElement>(
          `[data-session-id="${sessionId}"] .session-row`,
        )?.hidden,
        false,
      );
    }
    harness.click('.session-delete-confirm [data-delete-cancel]');
    assert.equal(
      harness.document.querySelector("#sessionSelectionCount")?.textContent,
      "3 selected",
    );

    harness.click('[data-session-menu-button="session-previous"]');
    harness.click(
      '[data-session-id="session-previous"] [data-session-action="archive"]',
    );
    await waitForCondition(
      () => commandCalls(harness).length === 3,
      "Expected every selected Session to be archived",
    );
    assert.deepEqual(commandCalls(harness).map((call) => call.body), [
      { kind: "archive_session", sessionId: "session-1" },
      { kind: "archive_session", sessionId: "session-2" },
      { kind: "archive_session", sessionId: "session-previous" },
    ]);
    assert.equal(
      harness.document.querySelector<HTMLElement>("#sessionSelectionCount")?.hidden,
      true,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("clicking History selects it without continuing until the explicit action", async () => {
  const state = stateFixture();
  state.previousSessions = [{
    id: "session-previous",
    title: "Previous drum arrangement",
    projectKey: "previous-activation",
    scope: { kind: "track", identity: "old-drum-handle", label: "Drums" },
    createdAt: "2026-07-31T00:00:00.000Z",
    updatedAt: "2026-07-31T00:15:00.000Z",
  }];
  const harness = await createDialogHarness(state);
  try {
    harness.click('[data-session-id="session-previous"] .session-row');
    assert.equal(
      harness.document.querySelector(
        '[data-session-id="session-previous"]',
      )?.hasAttribute("data-selected"),
      true,
    );
    assert.deepEqual(commandCalls(harness), []);

    harness.click('[data-continue-session-id="session-previous"]');
    await harness.settle();
    assert.deepEqual(commandCalls(harness).map((call) => call.body), [
      { kind: "restore_session", sessionId: "session-previous" },
    ]);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("batch selection marks the active Session without issuing a command", async () => {
  const harness = await createDialogHarness();
  try {
    const activeRow = harness.document.querySelector<HTMLElement>(
      '[data-session-id="session-1"] .session-row',
    );
    assert.ok(activeRow);
    activeRow.dispatchEvent(new harness.window.MouseEvent("click", {
      bubbles: true,
      metaKey: true,
    }));

    assert.equal(activeRow.getAttribute("aria-pressed"), "true");
    assert.equal(
      activeRow.closest<HTMLElement>(".session-entry")?.hasAttribute("data-selected"),
      true,
    );
    assert.deepEqual(commandCalls(harness), []);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("history separates object labels from identity and exposes lifecycle actions", async () => {
  const state = stateFixture();
  state.previousSessions = [{
    id: "session-previous",
    title: "Previous drum arrangement",
    projectKey: "previous-activation",
    scope: { kind: "track", identity: "old-drum-handle", label: "Drums" },
    createdAt: "2026-07-31T00:00:00.000Z",
    updatedAt: "2026-07-31T00:15:00.000Z",
  }, {
    id: "session-previous-clip",
    title: "Chorus clip details",
    projectKey: "previous-activation",
    scope: { kind: "clip", identity: "old-clip-handle", label: "Chorus" },
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:15:00.000Z",
  }];
  state.archivedSessions = [{
    id: "session-archived",
    title: "Archived mix notes",
    projectKey: "older-activation",
    scope: { kind: "track", identity: "old-mix-handle", label: "Mix Bus" },
    archivedAt: "2026-07-29T00:00:00.000Z",
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
  }];
  const harness = await createDialogHarness(state);
  try {
    const sidebar = harness.document.querySelector("#sessions")?.textContent ?? "";
    assert.match(sidebar, /History/);
    assert.doesNotMatch(sidebar, /Object names are labels only/);
    assert.match(sidebar, /Previous drum arrangement.*Track · Drums.*Continue/s);
    assert.match(sidebar, /Chorus clip details.*Clip · Chorus/s);
    assert.match(sidebar, /Archived.*Archived mix notes.*Track · Mix Bus/s);
    assert.doesNotMatch(sidebar, /→|same object/i);
    assert.equal(
      harness.document.querySelector(
        '[data-continue-session-id="session-previous-clip"]',
      ),
      null,
    );

    harness.click('[data-session-menu-button="session-previous"]');
    harness.click('[data-session-id="session-previous"] [data-session-action="rename"]');
    const rename = harness.document.querySelector<HTMLInputElement>(".session-rename-input");
    assert.ok(rename);
    rename.value = "Renamed history";
    rename.dispatchEvent(new harness.window.KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
    }));
    await harness.settle();
    assert.match(
      harness.document.querySelector("#sessions")?.textContent ?? "",
      /Renamed history/,
    );

    harness.click('[data-session-menu-button="session-previous"]');
    harness.click('[data-session-id="session-previous"] [data-session-action="archive"]');
    await harness.settle();
    assert.equal(
      harness.document.querySelector('[data-continue-session-id="session-previous"]'),
      null,
    );
    assert.match(
      harness.document.querySelector("#sessions")?.textContent ?? "",
      /Archived.*Renamed history/s,
    );

    harness.click('[data-session-menu-button="session-previous"]');
    harness.click('[data-session-id="session-previous"] [data-session-action="unarchive"]');
    await harness.settle();
    const continueHere = harness.document.querySelector<HTMLButtonElement>(
      '[data-continue-session-id="session-previous"]',
    );
    assert.ok(continueHere);
    assert.match(
      continueHere.getAttribute("aria-label") ?? "",
      /current track Drums/i,
    );
    continueHere.click();
    await harness.settle();

    assert.deepEqual(commandCalls(harness), [
      {
        path: "/command",
        body: {
          kind: "rename_session",
          sessionId: "session-previous",
          title: "Renamed history",
        },
      },
      {
        path: "/command",
        body: { kind: "archive_session", sessionId: "session-previous" },
      },
      {
        path: "/command",
        body: { kind: "unarchive_session", sessionId: "session-previous" },
      },
      {
        path: "/command",
        body: { kind: "restore_session", sessionId: "session-previous" },
      },
    ]);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("Session rows pan overflowing metadata and keep action menus inside the viewport", async () => {
  const state = stateFixture();
  state.previousSessions = [{
    id: "session-previous",
    title: "Previous drum arrangement",
    projectKey: "previous-activation",
    scope: { kind: "track", identity: "old-drum-handle", label: "Chords" },
    createdAt: "2026-07-31T00:00:00.000Z",
    updatedAt: "2026-07-31T00:15:00.000Z",
  }];
  const harness = await createDialogHarness(state);
  try {
    const entry = harness.document.querySelector<HTMLElement>(
      '[data-session-id="session-previous"]',
    );
    const menuButton = entry?.querySelector<HTMLButtonElement>(
      ".session-menu-button",
    );
    const menu = entry?.querySelector<HTMLElement>(".session-action-menu");
    const metadata = entry?.querySelector<HTMLElement>(".session-meta");
    const metadataContent = entry?.querySelector<HTMLElement>(
      ".session-meta-content",
    );
    const continueButton = entry?.querySelector<HTMLButtonElement>(
      ".session-continue-button",
    );
    const sessions = harness.document.querySelector<HTMLElement>("#sessions");
    assert.ok(entry);
    assert.ok(menuButton);
    assert.ok(menu);
    assert.ok(metadata);
    assert.ok(metadataContent);
    assert.ok(continueButton);
    assert.ok(sessions);

    assert.equal(metadata.textContent, "Track · Chords");
    assert.equal(
      entry.querySelector('[data-continue-session-id="session-previous"]')?.textContent,
      "Continue",
    );

    Object.defineProperty(metadata, "clientWidth", {
      configurable: true,
      value: 120,
    });
    Object.defineProperty(metadataContent, "scrollWidth", {
      configurable: true,
      value: 210,
    });
    harness.window.dispatchEvent(new harness.window.Event("resize"));
    assert.equal(metadata.classList.contains("is-overflowing"), true);
    assert.equal(metadata.style.getPropertyValue("--session-meta-shift"), "90px");
    assert.equal(metadata.style.getPropertyValue("--session-meta-duration"), "4.45s");

    Object.defineProperty(harness.window, "innerWidth", {
      configurable: true,
      value: 400,
    });
    Object.defineProperty(harness.window, "innerHeight", {
      configurable: true,
      value: 240,
    });
    menuButton.getBoundingClientRect = () => ({
      bottom: 226,
      height: 22,
      left: 350,
      right: 372,
      top: 204,
      width: 22,
      x: 350,
      y: 204,
      toJSON: () => ({}),
    });
    menu.getBoundingClientRect = () => ({
      bottom: 0,
      height: 100,
      left: 0,
      right: 116,
      top: 0,
      width: 116,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    menuButton.click();
    assert.equal(menu.hidden, false);
    assert.ok(Number.parseFloat(menu.style.top) < 204);
    assert.ok(Number.parseFloat(menu.style.left) >= 6);
    assert.ok(Number.parseFloat(menu.style.left) + 116 <= 394);

    sessions.dispatchEvent(new harness.window.Event("scroll"));
    assert.equal(menu.hidden, true);
    assert.equal(menuButton.getAttribute("aria-expanded"), "false");
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("double-clicking an inactive Session selects it and keeps rename editing open", async () => {
  const harness = await createDialogHarness();
  try {
    const leadRow = [...harness.document.querySelectorAll<HTMLButtonElement>(".session-row")]
      .find((row) => row.textContent?.includes("Lead session"));
    assert.ok(leadRow);
    leadRow.dispatchEvent(new harness.window.MouseEvent("dblclick", { bubbles: true }));
    await harness.settle();

    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#profileSelector")?.value,
      "profile-1",
    );
    assert.ok(harness.document.querySelector(".session-rename-input"));
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("keyboard Session selection and rename restore focus to the current row", async () => {
  const harness = await createDialogHarness();
  try {
    const leadRow = [...harness.document.querySelectorAll<HTMLButtonElement>(".session-row")]
      .find((row) => row.textContent?.includes("Lead session"));
    assert.ok(leadRow);
    leadRow.focus();
    leadRow.dispatchEvent(new harness.window.MouseEvent("click", {
      bubbles: true,
      detail: 0,
    }));
    await harness.settle();

    const selectedRow = harness.document.querySelector<HTMLButtonElement>(
      '.session-entry[data-session-id="session-2"] .session-row',
    );
    assert.equal(selectedRow?.getAttribute("aria-pressed"), "true");
    assert.equal(harness.document.activeElement, selectedRow);

    selectedRow?.dispatchEvent(new harness.window.KeyboardEvent("keydown", {
      key: "F2",
      bubbles: true,
    }));
    const rename = harness.document.querySelector<HTMLInputElement>(
      ".session-rename-input",
    );
    assert.ok(rename);
    rename.value = "Lead ideas";
    rename.dispatchEvent(new harness.window.KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
    }));
    await harness.settle();

    const renamedRow = harness.document.querySelector<HTMLButtonElement>(
      '.session-entry[data-session-id="session-2"] .session-row',
    );
    assert.match(renamedRow?.textContent ?? "", /Lead ideas/);
    assert.equal(harness.document.activeElement, renamedRow);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a running Session can be left in the background and shows an unread completion dot", async () => {
  const harness = await createDialogHarness();
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Build a 64 bar bass arrangement");
    harness.click("#sendButton");
    await Promise.resolve();
    const bassSendId = harness.sendIds[0];
    assert.ok(bassSendId);

    const leadRow = harness.document.querySelector<HTMLButtonElement>(
      '.session-entry[data-session-id="session-2"] .session-row',
    );
    assert.equal(leadRow?.disabled, false);
    leadRow?.click();
    await harness.settle();

    assert.equal(
      harness.document.querySelector('.session-row[aria-pressed="true"]')
        ?.closest<HTMLElement>(".session-entry")?.dataset.sessionId,
      "session-2",
    );
    assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Send");
    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.disabled,
      false,
    );
    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#profileName")?.disabled,
      true,
    );
    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#approvalMode")?.disabled,
      false,
    );
    assert.equal(
      harness.document.querySelector<HTMLButtonElement>("#saveProfileButton")?.disabled,
      true,
    );
    assert.equal(
      harness.document.querySelector<HTMLButtonElement>("#contextTab")?.disabled,
      false,
    );
    assert.match(
      harness.document.querySelector("#approvalMode")?.closest("label")?.getAttribute("title") ?? "",
      /Low Risk auto-applies/i,
    );
    assert.equal(
      harness.document.querySelector("#approvalMode")?.getAttribute("aria-describedby"),
      null,
    );
    assert.equal(
      harness.document.querySelector("#approvalModeLockHint"),
      null,
    );
    assert.equal(
      harness.document.querySelector<HTMLElement>("#settingsLockNotice")?.hidden,
      false,
    );
    assert.match(
      harness.document.querySelector("#settingsLockNotice")?.textContent ?? "",
      /another Session is running/i,
    );

    harness.select("#approvalMode", "low-risk");
    await harness.settle();
    assert.deepEqual(commandCalls(harness).at(-1), {
      path: "/command",
      body: {
        kind: "set_session_approval_mode",
        sessionId: "session-2",
        approvalMode: "low-risk",
      },
    });
    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#approvalMode")?.value,
      "low-risk",
    );
    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#profileName")?.disabled,
      true,
    );

    const selectedLeadRow = harness.document.querySelector<HTMLButtonElement>(
      '.session-entry[data-session-id="session-2"] .session-row',
    );
    selectedLeadRow?.dispatchEvent(new harness.window.KeyboardEvent("keydown", {
      key: "F2",
      bubbles: true,
    }));
    const leadRename = harness.document.querySelector<HTMLInputElement>(
      ".session-rename-input",
    );
    assert.ok(leadRename);
    leadRename.value = "Lead renamed while Bass runs";
    leadRename.dispatchEvent(new harness.window.KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
    }));
    await harness.settle();

    harness.holdNextSend();
    harness.input("#prompt", "Build a lead counterline");
    harness.click("#sendButton");
    await Promise.resolve();
    const leadSendId = harness.sendIds[1];
    assert.ok(leadSendId);
    assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Stop");

    harness.emitServerEvent({
      type: "progress",
      sendId: bassSendId,
      sessionId: "session-1",
      message: "Writing MIDI clip",
    });
    assert.doesNotMatch(
      harness.document.querySelector("#status")?.textContent ?? "",
      /Writing MIDI clip/,
    );

    harness.emitServerEvent({
      type: "session_event",
      sendId: leadSendId,
      sessionId: "session-2",
      event: {
        id: "lead-live-event",
        kind: "assistant",
        content: "Lead event received while Bass was finishing.",
        createdAt: "2026-08-01T00:03:00.000Z",
      },
    });

    const completedState = cloneState(stateFixture());
    completedState.activeSessionId = "session-2";
    completedState.approvalMode = "low-risk";
    completedState.sessionActivities = [{
      sessionId: "session-1",
      status: "completed",
      message: "Completed",
      unread: true,
    }];
    harness.emitServerEvent({
      type: "done",
      sendId: bassSendId,
      sessionId: "session-1",
      state: completedState,
    });
    await harness.settle();

    const bassEntry = harness.document.querySelector(
      '.session-entry[data-session-id="session-1"]',
    );
    assert.equal(bassEntry?.querySelector(".session-unread-dot") !== null, true);
    assert.match(bassEntry?.textContent ?? "", /Completed/);
    assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Stop");
    assert.match(
      harness.document.querySelector(
        '.session-entry[data-session-id="session-2"]',
      )?.textContent ?? "",
      /Lead renamed while Bass runs/,
    );
    assert.match(
      harness.document.querySelector("#timeline")?.textContent ?? "",
      /Lead event received while Bass was finishing/,
    );

    harness.click('.session-entry[data-session-id="session-1"] .session-row');
    await harness.settle();
    assert.equal(
      harness.document.querySelector(
        '.session-entry[data-session-id="session-1"] .session-unread-dot',
      ),
      null,
    );
    assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Send");
    assert.deepEqual(harness.errors, []);

    harness.releaseHeldSend();
    harness.releaseHeldSend();
    await harness.settle();
  } finally {
    harness.close();
  }
});

test("a background assistant event resets only that Session's streaming draft", async () => {
  const harness = await createDialogHarness();
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Run a multi-turn Bass task");
    harness.click("#sendButton");
    await Promise.resolve();
    const bassSendId = harness.sendIds[0];
    assert.ok(bassSendId);

    harness.emitServerEvent({
      type: "assistant_delta",
      sendId: bassSendId,
      sessionId: "session-1",
      delta: "Old draft",
    });
    harness.click('.session-entry[data-session-id="session-2"] .session-row');
    await harness.settle();
    harness.emitServerEvent({
      type: "session_event",
      sendId: bassSendId,
      sessionId: "session-1",
      modelTurnEpoch: 1,
      event: {
        id: "bass-assistant-turn-1",
        kind: "assistant",
        content: "First assistant turn",
        createdAt: "2026-08-01T00:03:00.000Z",
      },
    });
    harness.emitServerEvent({
      type: "assistant_delta",
      sendId: bassSendId,
      sessionId: "session-1",
      delta: "Fresh draft",
    });

    harness.click('.session-entry[data-session-id="session-1"] .session-row');
    await harness.settle();
    assert.equal(
      harness.document.querySelector(".timeline-item.streaming .timeline-content")
        ?.textContent,
      "Fresh draft",
    );
    assert.deepEqual(harness.errors, []);

    harness.releaseHeldSend();
    await harness.settle();
  } finally {
    harness.close();
  }
});

test("a background persisted Web Search event clears its transient update before returning", async () => {
  const harness = await createDialogHarness();
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Research from the Bass Session");
    harness.click("#sendButton");
    await Promise.resolve();
    const sendId = harness.sendIds[0];
    assert.ok(sendId);

    harness.emitServerEvent({
      type: "web_search_update",
      sendId,
      sessionId: "session-1",
      update: {
        id: "background-search",
        status: "searching",
        action: "search",
        queries: ["current Ableton release"],
        sources: [],
      },
    });
    harness.click('.session-entry[data-session-id="session-2"] .session-row');
    await harness.settle();

    harness.emitServerEvent({
      type: "session_event",
      sendId,
      sessionId: "session-1",
      modelTurnEpoch: 1,
      event: {
        id: "event-background-search",
        createdAt: "2026-08-06T00:00:00.000Z",
        kind: "web_search",
        content: "Searched for current Ableton release",
        webSearch: {
          id: "background-search",
          status: "completed",
          action: "search",
          queries: ["current Ableton release"],
          sources: [{
            url: "https://example.test/release",
            title: "Release notes",
          }],
        },
      },
    });

    const returnState = stateFixture();
    returnState.activeSessionId = "session-2";
    returnState.events = [];
    harness.setServerState(returnState);
    harness.click('.session-entry[data-session-id="session-1"] .session-row');
    await harness.settle();

    assert.equal(
      harness.document.querySelector(".timeline-item.web_search.live"),
      null,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.releaseHeldSend();
    await harness.settle();
    harness.close();
  }
});

test("authoritative Session state reconciles a failed Web Search whose SSE was lost", async () => {
  const harness = await createDialogHarness();
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Research from the Bass Session");
    harness.click("#sendButton");
    await Promise.resolve();
    const sendId = harness.sendIds[0];
    assert.ok(sendId);

    harness.emitServerEvent({
      type: "web_search_update",
      sendId,
      sessionId: "session-1",
      update: {
        id: "search-with-lost-event",
        status: "searching",
        action: "search",
        queries: ["current Ableton release"],
        sources: [],
      },
    });
    harness.click('.session-entry[data-session-id="session-2"] .session-row');
    await harness.settle();

    const returnState = stateFixture();
    returnState.activeSessionId = "session-2";
    returnState.events = [{
      id: "event-search-with-lost-event",
      createdAt: "2026-08-06T00:00:00.000Z",
      kind: "web_search",
      content: "Web Search failed before result pages were returned.",
      webSearch: {
        id: "search-with-lost-event",
        status: "failed",
        action: "search",
        queries: ["current Ableton release"],
        sources: [],
      },
    }];
    harness.setServerState(returnState);
    harness.click('.session-entry[data-session-id="session-1"] .session-row');
    await harness.settle();

    assert.equal(
      harness.document.querySelectorAll(".timeline-item.web_search").length,
      1,
    );
    assert.equal(
      harness.document.querySelector(".timeline-item.web_search.live"),
      null,
    );
    const failedCard = harness.document.querySelector<HTMLDetailsElement>(
      ".timeline-item.web_search",
    );
    assert.match(
      failedCard?.querySelector("summary")?.textContent ?? "",
      /failed before result pages were returned/i,
    );
    assert.equal(
      failedCard?.querySelector(".web-search-source-empty")?.textContent,
      "Web Search failed before result pages were returned.",
    );
    assert.match(
      failedCard?.querySelector("summary")?.getAttribute("aria-label") ?? "",
      /failed before result pages were returned/i,
    );
    assert.equal(failedCard?.querySelector(".web-search-source-list a"), null);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.releaseHeldSend();
    await harness.settle();
    harness.close();
  }
});

test("authoritative state ignores a historical Web Search ID until a new terminal event appears", async () => {
  const historicalEvent: ChatDialogState["events"][number] = {
    id: "event-search-from-previous-send",
    createdAt: "2026-08-05T00:00:00.000Z",
    kind: "web_search",
    content: "Searched a previous request",
    webSearch: {
      id: "openai-search-1",
      status: "completed",
      action: "search",
      queries: ["previous search query"],
      sources: [{
        url: "https://example.test/previous",
        title: "Previous result",
      }],
    },
  };
  const state = stateFixture();
  state.events = [historicalEvent];
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Run another search");
    harness.click("#sendButton");
    await Promise.resolve();
    const sendId = harness.sendIds[0];
    assert.ok(sendId);

    harness.emitServerEvent({
      type: "web_search_update",
      sendId,
      sessionId: "session-1",
      update: {
        id: "openai-search-1",
        status: "searching",
        action: "search",
        queries: ["current search query"],
        sources: [],
      },
    });
    assert.equal(
      harness.document.querySelectorAll(".timeline-item.web_search").length,
      2,
    );

    harness.click('.session-entry[data-session-id="session-2"] .session-row');
    await harness.settle();
    harness.click('.session-entry[data-session-id="session-1"] .session-row');
    await harness.settle();

    const currentSearch = harness.document.querySelector<HTMLDetailsElement>(
      ".timeline-item.web_search.live",
    );
    assert.ok(currentSearch);
    assert.match(currentSearch.textContent ?? "", /current search query/);
    assert.equal(
      harness.document.querySelectorAll(".timeline-item.web_search").length,
      2,
    );

    harness.click('.session-entry[data-session-id="session-2"] .session-row');
    await harness.settle();
    const terminalState = stateFixture();
    terminalState.activeSessionId = "session-2";
    terminalState.events = [
      historicalEvent,
      {
        id: "event-search-from-current-send",
        createdAt: "2026-08-06T00:00:00.000Z",
        kind: "web_search",
        content: "Web Search failed before result pages were returned.",
        webSearch: {
          id: "openai-search-1",
          status: "failed",
          action: "search",
          queries: ["current search query"],
          sources: [],
        },
      },
    ];
    harness.setServerState(terminalState);
    harness.click('.session-entry[data-session-id="session-1"] .session-row');
    await harness.settle();

    assert.equal(
      harness.document.querySelectorAll(".timeline-item.web_search").length,
      2,
    );
    assert.equal(
      harness.document.querySelector(".timeline-item.web_search.live"),
      null,
    );
    assert.match(
      harness.document.querySelectorAll(".timeline-item.web_search summary")[1]
        ?.textContent ?? "",
      /failed before result pages were returned/i,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.releaseHeldSend();
    await harness.settle();
    harness.close();
  }
});

test("a background send keeps global Skill mutations locked until it settles", async () => {
  const state = stateFixture();
  state.availableSkills = [{
    id: "mix-review",
    description: "Review balance and space",
    source: "user",
  }];
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Hold the Bass Session open");
    harness.click("#sendButton");
    await Promise.resolve();

    harness.click('.session-entry[data-session-id="session-2"] .session-row');
    await harness.settle();

    const skillRow = harness.document.querySelector<HTMLElement>(
      '[data-skill-id="mix-review"]',
    );
    assert.equal(skillRow?.querySelector<HTMLInputElement>('input[type="checkbox"]')?.disabled, true);
    assert.equal(skillRow?.querySelector<HTMLButtonElement>("button")?.disabled, true);
    assert.equal(
      harness.document.querySelector("#skillDropZone")?.getAttribute("aria-disabled"),
      "true",
    );

    const file = new harness.window.File([
      "---\nname: another-skill\ndescription: Another Skill\n---\nBody\n",
    ], "SKILL.md", { type: "text/markdown" });
    assert.equal(harness.dropSkillFile(file), true);
    await harness.settle();
    assert.equal(harness.calls.some((call) => call.path === "/skills"), false);
    assert.equal(
      commandCalls(harness).some(
        (call) => (call.body as { kind?: string }).kind === "set_session_skills",
      ),
      false,
    );

    harness.releaseHeldSend();
    await harness.settle();
    const restoredSkillRow = harness.document.querySelector<HTMLElement>(
      '[data-skill-id="mix-review"]',
    );
    assert.equal(
      restoredSkillRow?.querySelector<HTMLInputElement>('input[type="checkbox"]')?.disabled,
      false,
    );
    assert.equal(restoredSkillRow?.querySelector<HTMLButtonElement>("button")?.disabled, false);
    assert.equal(
      harness.document.querySelector("#skillDropZone")?.getAttribute("aria-disabled"),
      "false",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("Live Set confirmations announce their action count, focus Cancel, and support Escape", async () => {
  const state = stateFixture();
  state.events = [{
    id: "tool-event",
    kind: "tool_call",
    name: "inspect_track",
    content: "Inspect Bass",
    createdAt: "2026-08-01T00:02:00.000Z",
  }];
  const harness = await createDialogHarness(state);
  try {
    harness.input("#prompt", "Prepare confirmation");
    harness.holdNextSend();
    harness.click("#sendButton");
    await Promise.resolve();
    const sendId = harness.sendIds[0];
    assert.ok(sendId);
    const priorSummary = harness.document.querySelector<HTMLElement>(
      ".timeline-activity-group > summary",
    );
    priorSummary?.focus();
    assert.equal(harness.document.activeElement, priorSummary);
    harness.emitServerEvent({
      type: "confirm_request",
      sendId,
      sessionId: "session-1",
      id: "confirm-1",
      message: "Add a track and update the mix.",
      groups: [
        { title: "Tracks", rows: ["Create MIDI track Bass", "Rename track Lead"] },
        { title: "Mix", rows: ["Set tempo to 124 BPM"] },
        {
          title: "Write MIDI",
          rows: [
            'Replace MIDI clip "Full arrangement" at beat 0, relative beats 16-32 (24 notes)',
          ],
        },
      ],
    });

    const dialog = harness.document.querySelector<HTMLElement>(".confirm-card");
    assert.equal(dialog?.getAttribute("role"), "alertdialog");
    assert.equal(dialog?.hasAttribute("aria-modal"), false);
    const labelledBy = dialog?.getAttribute("aria-labelledby") ?? "";
    assert.equal(
      harness.document.getElementById(labelledBy)?.textContent,
      "Apply 4 changes to the Live Set?",
    );
    assert.match(dialog?.textContent ?? "", /relative beats 16-32.*24 notes/i);
    const cancel = dialog?.querySelector<HTMLButtonElement>("[data-confirm-cancel]");
    const apply = dialog?.querySelector<HTMLButtonElement>(".primary");
    assert.equal(harness.document.activeElement, cancel);
    assert.equal(harness.document.querySelector("header")?.hasAttribute("inert"), false);
    assert.equal(
      harness.document.querySelector("#inspectorPane")?.hasAttribute("inert"),
      false,
    );
    assert.equal(
      harness.document.querySelector(".sessions-pane")?.hasAttribute("inert"),
      false,
    );
    assert.equal(
      harness.document.querySelector<HTMLButtonElement>(
        '.session-entry[data-session-id="session-2"] .session-row',
      )?.disabled,
      false,
    );
    assert.equal(
      [...(harness.document.querySelector("#timeline")?.children ?? [])]
        .filter((child) => child !== dialog)
        .every((child) => child.hasAttribute("inert")),
      true,
    );

    const followUpBehavior = harness.document.querySelector<HTMLSelectElement>(
      "#defaultFollowUpBehavior",
    );
    assert.equal(followUpBehavior?.disabled, false);
    followUpBehavior?.focus();
    assert.equal(harness.document.activeElement, followUpBehavior);
    assert.equal(cancel?.disabled, false);
    assert.equal(apply?.disabled, false);
    harness.emitServerEvent({
      type: "assistant_delta",
      sendId,
      sessionId: "session-1",
      delta: "Waiting for your decision.",
    });
    assert.equal(harness.flushAnimationFrames(), 1);
    assert.equal(
      harness.document.querySelector(".timeline-item.streaming")
        ?.hasAttribute("inert"),
      true,
    );
    assert.equal(harness.document.activeElement, followUpBehavior);

    harness.document.dispatchEvent(new harness.window.KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
    }));
    await harness.settle();

    assert.equal(harness.document.querySelector(".confirm-card"), null);
    assert.equal(harness.document.querySelector("header")?.hasAttribute("inert"), false);
    assert.equal(
      harness.document.activeElement,
      harness.document.querySelector("#sendButton"),
    );
    assert.deepEqual(commandCalls(harness), []);
    assert.deepEqual(
      jsonCalls(harness, "/confirm"),
      [{ path: "/confirm", body: { id: "confirm-1", apply: false } }],
    );
    assert.deepEqual(harness.errors, []);
    harness.releaseHeldSend();
    await harness.settle();
  } finally {
    harness.close();
  }
});

test("Live Set confirmations render mixed action categories in execution order", async () => {
  const harness = await createDialogHarness();
  try {
    harness.input("#prompt", "Replace a scratch track");
    harness.holdNextSend();
    harness.click("#sendButton");
    await Promise.resolve();
    const sendId = harness.sendIds[0];
    assert.ok(sendId);
    harness.emitServerEvent({
      type: "confirm_request",
      sendId,
      sessionId: "session-1",
      id: "confirm-ordered",
      message: "Replace the scratch track in order.",
      groups: [
        { title: "Delete", rows: ['1. - track "Scratch"'] },
        { title: "Create", rows: ['2. + MIDI track "Replacement"'] },
        { title: "Song", rows: ["3. ~ Tempo = 132 BPM"] },
      ],
    });

    assert.deepEqual(
      [...harness.document.querySelectorAll(".confirm-rows li")]
        .map((item) => item.textContent),
      [
        '1. - track "Scratch"',
        '2. + MIDI track "Replacement"',
        "3. ~ Tempo = 132 BPM",
      ],
    );

    harness.clickButton("Cancel");
    await harness.settle();
    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a failed confirmation request terminates the send before dismissing the decision", async () => {
  const harness = await createDialogHarness();
  try {
    harness.input("#prompt", "Prepare retry confirmation");
    harness.holdNextSend();
    harness.click("#sendButton");
    await Promise.resolve();
    const sendId = harness.sendIds[0];
    assert.ok(sendId);
    harness.emitServerEvent({
      type: "confirm_request",
      sendId,
      sessionId: "session-1",
      id: "confirm-retry",
      message: "Set tempo.",
      groups: [{ title: "Song", rows: ["Set tempo to 124 BPM"] }],
    });
    harness.failNextConfirmation("Confirmation could not be sent.");
    harness.clickButton("Apply");
    await harness.settle();

    assert.equal(harness.document.querySelector(".confirm-card"), null);
    assert.equal(harness.document.querySelector("header")?.hasAttribute("inert"), false);
    assert.equal(
      [...harness.document.querySelectorAll("#timeline > *")]
        .every((child) => !child.hasAttribute("inert")),
      true,
    );
    assert.equal(
      harness.calls.filter((call) => call.path === "/stop").length,
      1,
    );
    assert.deepEqual(harness.stopIds, [sendId]);
    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.disabled,
      false,
    );
    assert.deepEqual(harness.errors, []);
    harness.releaseHeldSend();
    await harness.settle();
  } finally {
    harness.close();
  }
});

test("a network-interrupted send stops to terminal state before clearing its confirmation", async () => {
  const harness = await createDialogHarness();
  try {
    harness.input("#prompt", "Interrupt while confirming");
    harness.holdNextSend();
    harness.rejectNextSend("Bridge connection was interrupted.");
    harness.click("#sendButton");
    await Promise.resolve();
    const sendId = harness.sendIds[0];
    assert.ok(sendId);
    harness.emitServerEvent({
      type: "confirm_request",
      sendId,
      sessionId: "session-1",
      id: "confirm-interrupted",
      message: "Set tempo.",
      groups: [{ title: "Song", rows: ["Set tempo to 124 BPM"] }],
    });
    assert.equal(harness.document.querySelector("header")?.hasAttribute("inert"), false);
    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#defaultFollowUpBehavior")?.disabled,
      false,
    );

    harness.releaseHeldSend();
    await harness.settle();

    assert.equal(harness.calls.filter((call) => call.path === "/stop").length, 1);
    assert.deepEqual(harness.stopIds, [sendId]);
    assert.equal(harness.document.querySelector(".confirm-card"), null);
    assert.equal(harness.document.querySelector("header")?.hasAttribute("inert"), false);
    assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Send");
    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.disabled,
      false,
    );
    assert.match(
      harness.document.querySelector("#status")?.textContent ?? "",
      /interrupted|unknown/i,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a network-interrupted send polls Stop by send ID until terminal and state refresh", async () => {
  const harness = await createDialogHarness();
  try {
    harness.queueStopTerminals(false, true);
    harness.rejectNextSend("Bridge connection was interrupted.");
    harness.input("#prompt", "Recover this interrupted send");
    harness.click("#sendButton");

    await waitForCondition(
      () => harness.stopIds.length === 2,
      "Expected the interrupted send to retry Stop until terminal.",
    );
    await harness.settle();

    assert.equal(harness.sendIds.length, 1);
    assert.deepEqual(harness.stopIds, [harness.sendIds[0], harness.sendIds[0]]);
    const recoveryCalls = harness.calls
      .filter((call) => call.path === "/stop" || call.path === "/state")
      .map((call) => call.path);
    assert.deepEqual(recoveryCalls, ["/stop", "/stop", "/state"]);
    assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Send");
    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.disabled,
      false,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("terminal Stop settles send A and cancels its poll before send B starts", async () => {
  const harness = await createDialogHarness();
  try {
    harness.queueStopOutcomes(
      { terminal: false },
      { terminal: true, promptPersistence: "persisted" },
    );
    harness.holdNextSend();
    harness.input("#prompt", "Prompt A");
    harness.click("#sendButton");
    await Promise.resolve();
    const sendA = harness.sendIds[0];
    assert.ok(sendA);

    harness.click("#sendButton");
    await harness.settle();
    assert.deepEqual(harness.stopIds, [sendA]);

    harness.releaseHeldSend();
    await waitForCondition(
      () => harness.stopIds.length === 2,
      "Expected Stop polling to reach the correlated terminal classification.",
    );
    await harness.settle();

    harness.holdNextSend();
    harness.input("#prompt", "Prompt B");
    harness.click("#sendButton");
    await Promise.resolve();
    const sendB = harness.sendIds[1];
    assert.ok(sendB);
    assert.notEqual(sendB, sendA);

    await new Promise<void>((resolve) => setTimeout(resolve, 350));
    assert.deepEqual(harness.stopIds, [sendA, sendA]);
    assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Stop");

    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a late confirmation response from send A cannot block or clear send B", async () => {
  const harness = await createDialogHarness();
  try {
    harness.input("#prompt", "Prompt A");
    harness.holdNextSend();
    harness.click("#sendButton");
    await Promise.resolve();
    const sendA = harness.sendIds[0];
    assert.ok(sendA);

    harness.emitServerEvent({
      type: "confirm_request",
      sendId: sendA,
      sessionId: "session-1",
      id: "confirm-a",
      message: "Apply A?",
      groups: [{ title: "Song", rows: ["Set tempo to 120 BPM"] }],
    });
    harness.holdNextConfirmation();
    harness.clickButton("Apply");
    await Promise.resolve();

    harness.emitServerEvent({
      type: "done",
      sendId: sendA,
      sessionId: "session-1",
      state: cloneState(stateFixture()),
    });
    harness.releaseHeldSend();
    await Promise.resolve();

    harness.input("#prompt", "Prompt B");
    harness.holdNextSend();
    harness.click("#sendButton");
    await Promise.resolve();
    const sendB = harness.sendIds[1];
    assert.ok(sendB);

    harness.emitServerEvent({
      type: "confirm_request",
      sendId: sendB,
      sessionId: "session-1",
      id: "confirm-b-1",
      message: "Apply B first?",
      groups: [{ title: "Song", rows: ["Set tempo to 121 BPM"] }],
    });
    harness.clickButton("Apply");
    await harness.settle();
    assert.equal(
      harness.calls.filter((call) => call.path === "/confirm").length,
      2,
    );

    harness.emitServerEvent({
      type: "confirm_request",
      sendId: sendB,
      sessionId: "session-1",
      id: "confirm-b-2",
      message: "Apply B second?",
      groups: [{ title: "Song", rows: ["Set tempo to 122 BPM"] }],
    });
    harness.releaseHeldConfirmation();
    await harness.settle();

    assert.match(
      harness.document.querySelector(".confirm-card")?.textContent ?? "",
      /Apply B second/,
    );
    assert.equal(
      harness.document.querySelector("#status")?.textContent,
      "Waiting for confirmation",
    );
    harness.releaseHeldSend();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a background Session confirmation response cannot clear the active Session status", async () => {
  const harness = await createDialogHarness();
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Prepare Bass changes");
    harness.click("#sendButton");
    await Promise.resolve();
    const bassSendId = harness.sendIds[0];
    assert.ok(bassSendId);
    harness.emitServerEvent({
      type: "confirm_request",
      sendId: bassSendId,
      sessionId: "session-1",
      id: "confirm-bass",
      message: "Apply Bass changes?",
      groups: [{ title: "Bass", rows: ["Create MIDI clip"] }],
    });
    harness.holdNextConfirmation();
    harness.clickButton("Apply");
    await Promise.resolve();

    harness.click('.session-entry[data-session-id="session-2"] .session-row');
    await harness.settle();
    harness.holdNextSend();
    harness.input("#prompt", "Build Lead while Bass waits");
    harness.click("#sendButton");
    await Promise.resolve();
    const leadSendId = harness.sendIds[1];
    assert.ok(leadSendId);
    harness.emitServerEvent({
      type: "progress",
      sendId: leadSendId,
      sessionId: "session-2",
      message: "Writing Lead MIDI",
    });

    harness.releaseHeldConfirmation();
    await harness.settle();
    assert.equal(harness.document.querySelector("#status")?.textContent, "Writing Lead MIDI");
    assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Stop");
    assert.equal(harness.document.querySelector(".confirm-card"), null);
    assert.deepEqual(harness.errors, []);

    harness.releaseHeldSend();
    harness.releaseHeldSend();
    await harness.settle();
  } finally {
    harness.close();
  }
});

test("Session metadata keeps object labels separate from locale-aware dates", async () => {
  const state = stateFixture();
  state.sessions[1]!.updatedAt = "not-a-date";
  const harness = await createDialogHarness(state);
  try {
    const formatter = new harness.window.Intl.DateTimeFormat(undefined, {
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      month: "short",
    });
    const metadata = [...harness.document.querySelectorAll<HTMLElement>(".session-meta")];
    assert.equal(metadata[0]?.textContent, "Track · Bass");
    assert.equal(
      metadata[0]?.title,
      `Updated ${formatter.format(new harness.window.Date("2026-08-01T00:00:00.000Z"))}`,
    );
    assert.equal(metadata[1]?.textContent, "Track · Lead");
    assert.equal(metadata[1]?.title, "");
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("assistant delta bursts coalesce without rebuilding existing timeline items", async () => {
  const state = stateFixture();
  state.events = [{
    id: "event-1",
    kind: "user",
    content: "Make the chorus wider",
    createdAt: "2026-08-01T00:02:00.000Z",
  }];
  const harness = await createDialogHarness(state);
  try {
    harness.input("#prompt", "Stream a response");
    harness.holdNextSend();
    harness.click("#sendButton");
    await Promise.resolve();
    const sendId = harness.sendIds[0];
    assert.ok(sendId);
    const existingEvent = harness.document.querySelector(".timeline-item.user");
    assert.ok(existingEvent);
    const markdownRenderer = harness.window.LiveSmithMarkdown;
    assert.ok(markdownRenderer);
    const renderInto = markdownRenderer.renderInto;
    let renderCount = 0;
    markdownRenderer.renderInto = (target, source) => {
      renderCount += 1;
      renderInto(target, source);
    };

    harness.emitServerEvent({
      type: "assistant_delta",
      sendId,
      sessionId: "session-1",
      delta: "I’ll add **wide",
    });
    harness.emitServerEvent({
      type: "assistant_delta",
      sendId,
      sessionId: "session-1",
      delta: " chords**",
    });
    harness.emitServerEvent({
      type: "assistant_delta",
      sendId,
      sessionId: "session-1",
      delta: " with `Wavetable`.",
    });
    assert.equal(harness.document.querySelector(".timeline-item.streaming"), null);
    assert.equal(renderCount, 0);
    assert.equal(harness.flushAnimationFrames(), 1);

    const firstDraft = harness.document.querySelector(".timeline-item.streaming");
    assert.ok(firstDraft);
    assert.equal(firstDraft.querySelector("strong")?.textContent, "wide chords");
    assert.equal(firstDraft.querySelector("code")?.textContent, "Wavetable");
    assert.equal(renderCount, 1);
    assert.equal(
      harness.document.querySelector("#conversationAnnouncements")?.textContent,
      "",
    );

    harness.emitServerEvent({
      type: "assistant_delta",
      sendId,
      sessionId: "session-1",
      delta: " Done.",
    });
    assert.equal(harness.flushAnimationFrames(), 1);
    const secondDraft = harness.document.querySelector(".timeline-item.streaming");
    assert.equal(secondDraft, firstDraft);
    assert.equal(harness.document.querySelector(".timeline-item.user"), existingEvent);
    assert.equal(
      secondDraft?.querySelector(".timeline-content")?.textContent,
      "I’ll add wide chords with Wavetable. Done.",
    );
    assert.equal(renderCount, 2);

    harness.emitServerEvent({
      type: "assistant_delta",
      sendId,
      sessionId: "session-1",
      delta: " Stale.",
    });
    harness.emitServerEvent({
      type: "session_event",
      sendId,
      sessionId: "session-1",
      modelTurnEpoch: 1,
      event: {
        id: "event-2",
        kind: "assistant",
        content: "I’ll add wide chords with Wavetable. Done.",
        createdAt: "2026-08-01T00:03:00.000Z",
      },
    });
    assert.equal(harness.flushAnimationFrames(), 0);
    assert.equal(harness.document.querySelector(".timeline-item.streaming"), null);
    assert.equal(
      harness.document.querySelector("#conversationAnnouncements")?.textContent,
      "Live Smith: I’ll add wide chords with Wavetable. Done.",
    );
    assert.deepEqual(harness.errors, []);
    harness.releaseHeldSend();
    await harness.settle();
  } finally {
    harness.close();
  }
});

test("a full timeline render preserves expanded details and summary focus", async () => {
  const state = stateFixture();
  state.events = [{
    id: "tool-event",
    kind: "tool_call",
    name: "inspect_track",
    content: "Inspect Bass",
    createdAt: "2026-08-01T00:02:00.000Z",
  }];
  const harness = await createDialogHarness(state);
  try {
    const details = harness.document.querySelector<HTMLDetailsElement>(
      ".timeline-activity-group",
    );
    const summary = details?.querySelector<HTMLElement>("summary");
    assert.ok(details);
    assert.ok(summary);
    details.open = true;
    summary.focus();

    harness.click("#newSessionButton");
    await harness.settle();

    const renderedDetails = harness.document.querySelector<HTMLDetailsElement>(
      ".timeline-activity-group",
    );
    const renderedSummary = renderedDetails?.querySelector("summary");
    assert.equal(renderedDetails?.open, true);
    assert.equal(harness.document.activeElement, renderedSummary);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("Duplicate then Discard restores the active saved profile", async () => {
  const harness = await createDialogHarness();
  try {
    harness.click("#duplicateProfileButton");
    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#profileName")?.value,
      "Studio Copy",
    );
    assert.equal(harness.document.querySelector("#draftStatus")?.textContent, "Unsaved changes");

    harness.click("#discardProfileButton");
    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#profileName")?.value,
      "Studio",
    );
    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#profileSelector")?.value,
      "profile-1",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("dirty drafts disable Send and Discard restores the clean gate", async () => {
  const harness = await createDialogHarness();
  try {
    const send = harness.document.querySelector<HTMLButtonElement>("#sendButton");
    const discard = harness.document.querySelector<HTMLButtonElement>("#discardProfileButton");
    assert.equal(send?.disabled, false);
    assert.equal(discard?.disabled, true);

    harness.input("#profileName", "Edited locally");
    assert.equal(send?.disabled, true);
    assert.equal(discard?.disabled, false);
    assert.equal(harness.document.querySelector("#draftStatus")?.textContent, "Unsaved changes");

    harness.click("#discardProfileButton");
    assert.equal(send?.disabled, false);
    assert.equal(discard?.disabled, true);
    assert.equal(harness.document.querySelector("#draftStatus")?.textContent, "Saved");
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("cancelling a dirty Profile switch preserves the draft and selector", async () => {
  const harness = await createDialogHarness();
  try {
    harness.input("#profileName", "Keep this draft");
    harness.select("#profileSelector", "profile-2");
    await harness.cancelAppConfirmation();
    await harness.settle();

    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#profileSelector")?.value,
      "profile-1",
    );
    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#profileName")?.value,
      "Keep this draft",
    );
    assert.deepEqual(commandCalls(harness), []);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("failed Session approval and Profile activation commands restore the saved UI state", async () => {
  const harness = await createDialogHarness();
  try {
    harness.failNextCommand("Could not save Session Approval Mode.");
    harness.select("#approvalMode", "low-risk");
    await harness.settle();
    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#approvalMode")?.value,
      "manual",
    );

    harness.failNextCommand("Could not activate Profile.");
    harness.select("#profileSelector", "profile-2");
    await harness.settle();
    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#profileSelector")?.value,
      "profile-1",
    );
    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#profileName")?.value,
      "Studio",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("command IDs stay in headers and stale command SSE state cannot roll back newer UI state", async () => {
  const harness = await createDialogHarness();
  try {
    harness.click("#newSessionButton");
    await harness.settle();
    const oldCommandId = harness.commandIds[0];
    assert.ok(oldCommandId);
    assert.deepEqual(commandCalls(harness)[0], {
      path: "/command",
      body: { kind: "new_session" },
    });

    harness.select("#profileSelector", "profile-2");
    await harness.settle();
    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#composerModel")?.value,
      "model-b",
    );

    harness.emitServerEvent({
      type: "state",
      commandId: oldCommandId,
      state: cloneState(stateFixture()),
    });

    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#composerModel")?.value,
      "model-b",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("an unknown Session approval commit applies authoritative state instead of reverting the control", async () => {
  const harness = await createDialogHarness();
  try {
    const authoritative = cloneState(stateFixture());
    authoritative.approvalMode = "everything";
    const activeSession = authoritative.sessions.find(
      (session) => session.id === authoritative.activeSessionId,
    );
    assert.ok(activeSession);
    activeSession.approvalMode = "everything";
    harness.failNextCommand(
      "Storage replacement completed, but its durable commit could not be confirmed.",
      undefined,
      { commandOutcome: "unknown", state: authoritative },
    );

    harness.select("#approvalMode", "everything");
    await harness.settle();

    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#approvalMode")?.value,
      "everything",
    );
    assert.equal(
      harness.document.querySelector<HTMLButtonElement>("#sendButton")?.disabled,
      false,
    );
    assert.match(
      harness.document.querySelector("#status")?.textContent ?? "",
      /could not be confirmed/i,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("an unreconciled command outcome keeps sends and settings blocked", async () => {
  const harness = await createDialogHarness();
  try {
    harness.failNextCommand(
      "Storage replacement completed, but its durable commit could not be confirmed.",
      undefined,
      {
        commandOutcome: "unknown",
        reconciliationRequired: true,
      },
    );

    harness.select("#approvalMode", "everything");
    await harness.settle();

    assert.equal(
      harness.document.querySelector<HTMLButtonElement>("#sendButton")?.disabled,
      true,
    );
    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.disabled,
      true,
    );
    assert.equal(
      harness.document.querySelector("#modelProfileControls")?.getAttribute("aria-busy"),
      "true",
    );
    assert.match(
      harness.document.querySelector("#status")?.textContent ?? "",
      /could not be confirmed/i,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a command network error reconciles through state after the event stream disconnects", async () => {
  const harness = await createDialogHarness();
  try {
    harness.rejectNextCommand("Bridge response was lost.");
    harness.select("#approvalMode", "low-risk");
    await harness.settle();

    harness.emitServerEventError();
    await harness.settle();
    harness.emitServerEventOpen();
    await harness.settle();
    await harness.settle();

    assert.equal(
      harness.calls.filter((call) => call.path === "/state").length,
      2,
    );
    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#approvalMode")?.value,
      "manual",
    );
    assert.equal(
      harness.document.querySelector<HTMLButtonElement>("#sendButton")?.disabled,
      false,
    );
    assert.equal(
      harness.document.querySelector("#modelProfileControls")?.getAttribute("aria-busy"),
      "false",
    );
    assert.doesNotMatch(
      harness.document.querySelector("#status")?.textContent ?? "",
      /lost connection|close and reopen/i,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a committed command with truncated JSON reconciles through authoritative state", async () => {
  const harness = await createDialogHarness();
  try {
    harness.truncateNextCommandResponseAfterCommit();
    harness.select("#approvalMode", "low-risk");
    await harness.settle();

    harness.emitServerEventError();
    await harness.settle();
    harness.emitServerEventOpen();
    await harness.settle();

    assert.equal(
      harness.calls.filter((call) => call.path === "/state").length,
      2,
    );
    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#approvalMode")?.value,
      "low-risk",
    );
    assert.equal(
      harness.document.querySelector<HTMLButtonElement>("#sendButton")?.disabled,
      false,
    );
    assert.doesNotMatch(
      harness.document.querySelector("#status")?.textContent ?? "",
      /lost connection|close and reopen/i,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a malformed command SSE state reconciles without waiting on the settled SSE promise", async () => {
  const harness = await createDialogHarness();
  try {
    harness.holdNextCommandResponse();
    harness.select("#approvalMode", "low-risk");
    await waitForCondition(
      () => harness.commandIds.length === 1,
      "Expected the held command to start.",
    );
    harness.emitServerEvent({
      type: "state",
      commandId: harness.commandIds[0],
      state: {},
    });
    await harness.settle();

    assert.equal(
      harness.calls.filter((call) => call.path === "/state").length,
      1,
    );
    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#approvalMode")?.value,
      "low-risk",
    );
    assert.equal(
      harness.document.querySelector<HTMLButtonElement>("#sendButton")?.disabled,
      false,
    );
    assert.deepEqual(harness.errors, []);

    harness.releaseHeldCommandResponse();
    await harness.settle();
  } finally {
    harness.close();
  }
});

test("a response-lost Profile save rebuilds the editor from reconciled state", async () => {
  const harness = await createDialogHarness();
  try {
    harness.input("#profileName", "Studio reconciled");
    harness.rejectNextCommandResponse("Bridge response was lost.");
    harness.click("#saveProfileButton");
    await harness.settle();
    harness.emitServerEventError();
    await harness.settle();
    harness.emitServerEventOpen();
    await harness.settle();

    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#profileName")?.value,
      "Studio reconciled",
    );
    assert.equal(harness.document.querySelector("#draftStatus")?.textContent, "Saved");
    assert.equal(
      harness.document.querySelector<HTMLButtonElement>("#sendButton")?.disabled,
      false,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a response-lost Profile activation rebuilds the editor without rolling back", async () => {
  const harness = await createDialogHarness();
  try {
    harness.rejectNextCommandResponse("Bridge response was lost.");
    harness.select("#profileSelector", "profile-2");
    await harness.settle();
    harness.emitServerEventError();
    await harness.settle();

    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#profileSelector")?.value,
      "profile-2",
    );
    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#profileName")?.value,
      "Mix review",
    );
    assert.equal(harness.document.querySelector("#draftStatus")?.textContent, "Saved");
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a response-lost Profile deletion rebuilds the editor from reconciled state", async () => {
  const harness = await createDialogHarness();
  try {
    harness.rejectNextCommandResponse("Bridge response was lost.");
    harness.click("#deleteProfileButton");
    await harness.acceptAppConfirmation();
    await harness.settle();
    harness.emitServerEventError();
    await harness.settle();

    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#profileSelector")?.value,
      "profile-2",
    );
    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#profileName")?.value,
      "Mix review",
    );
    assert.equal(harness.document.querySelector("#draftStatus")?.textContent, "Saved");
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a command network error blocks mutations when stream and state reconciliation fail", async () => {
  const harness = await createDialogHarness();
  try {
    harness.rejectNextCommand("Bridge response was lost.");
    harness.rejectNextState("Bridge state is unavailable.");
    harness.select("#approvalMode", "everything");
    await harness.settle();

    harness.emitServerEventError();
    await harness.settle();
    harness.rejectNextState("Bridge state is still unavailable.");
    harness.emitServerEventOpen();
    await harness.settle();

    assert.equal(
      harness.document.querySelector<HTMLButtonElement>("#sendButton")?.disabled,
      true,
    );
    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.disabled,
      true,
    );
    assert.equal(
      harness.document.querySelector("#modelProfileControls")?.getAttribute("aria-busy"),
      "true",
    );
    assert.match(
      harness.document.querySelector("#status")?.textContent ?? "",
      /could not.*(?:reconcil|confirm)|state.*unavailable/i,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("Load Models replaces models after the Draft switches API connections", async () => {
  const harness = await createDialogHarness();
  try {
    harness.input("#profileName", "Draft discovery");
    harness.input("#apiKey", "draft-key");
    harness.input("#baseUrl", "https://draft.example/v1");
    harness.input("#manualModelId", "typed-model");
    harness.click("#addManualModelButton");
    harness.click("#discoverModelsButton");
    await harness.settle();

    const commands = commandCalls(harness);
    assert.equal(commands.length, 1);
    const expectedProfile = profileFixture({
      name: "Draft discovery",
      connection: {
        kind: "direct-api",
        apiFamily: "openai",
        apiMode: "chat-completions",
        apiKey: "draft-key",
        baseUrl: "https://draft.example/v1",
      },
    }) as DirectApiProfile;
    expectedProfile.defaultModel = "typed-model";
    expectedProfile.models.push({
      model: "typed-model",
      parameters: {
        maxOutputTokens: 8192,
        reasoning: { mode: "default" },
      },
      advanced: {},
    });
    assert.deepEqual(commands[0], {
      path: "/command",
      body: {
        kind: "discover_models",
        profile: expectedProfile,
      },
    });
    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#profileName")?.value,
      "Draft discovery",
    );
    assert.equal(
      harness.document.querySelector<HTMLSelectElement>(
        "#modelConfigSelector",
      )?.selectedOptions[0]?.textContent,
      "Discovered model · model-discovered · Default",
    );
    assert.deepEqual(
      [...harness.document.querySelectorAll<HTMLOptionElement>(
        "#modelConfigSelector option",
      )].map((option) => option.textContent),
      ["Discovered model · model-discovered · Default"],
    );

    harness.input("#manualModelId", "new-api-manual-model");
    harness.click("#addManualModelButton");
    harness.click("#discoverModelsButton");
    await harness.settle();
    assert.deepEqual(
      [...harness.document.querySelectorAll<HTMLOptionElement>(
        "#modelConfigSelector option",
      )].map((option) => option.textContent),
      [
        "Discovered model · model-discovered · Default",
        "new-api-manual-model",
      ],
      "reloading the same API must keep manually configured models",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("Load Models permits a local keyless Draft with blank name and model", async () => {
  const state = stateFixture();
  state.settings.profiles = [];
  state.settings.activeProfileId = null;
  state.activeProfileRevision = null;
  state.runtimeProfile = null;
  state.modelStateSource = null;
  state.availableModels = [];
  const harness = await createDialogHarness(state);
  try {
    harness.input("#profileName", "");
    harness.input("#apiKey", "");
    harness.input("#baseUrl", "http://127.0.0.1:1234/v1");
    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#composerModel")?.title,
      "Configure a model Profile in Agent",
    );
    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#composerModel")?.value,
      "",
    );
    assert.equal(
      harness.document.querySelector("#draftPreviewLabel")?.textContent,
      "Unsaved Draft preview",
    );

    harness.click("#discoverModelsButton");
    await harness.settle();

    const command = commandCalls(harness).at(-1);
    const body = command?.body as {
      kind: string;
      profile: {
        name: string;
        connection: { apiKey: string; baseUrl: string };
        defaultModel: string;
      };
    };
    assert.equal(body.kind, "discover_models");
    assert.equal(body.profile.name, "");
    assert.equal(body.profile.connection.apiKey, "");
    assert.equal(body.profile.connection.baseUrl, "http://127.0.0.1:1234/v1");
    assert.equal(body.profile.defaultModel, "");
    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#profileName")?.value,
      "",
    );
    assert.equal(
      harness.document.querySelector<HTMLSelectElement>(
        "#modelConfigSelector",
      )?.selectedOptions[0]?.textContent,
      "Discovered model · model-discovered · Default",
    );
    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#composerModel")?.value,
      "",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a later discovery SSE state cannot replace the settled HTTP command state", async () => {
  const harness = await createDialogHarness();
  try {
    harness.input("#profileName", "Draft discovery");
    harness.input("#apiKey", "draft-key");
    harness.input("#baseUrl", "https://draft.example/v1");
    harness.input("#manualModelId", "typed-model");
    harness.click("#addManualModelButton");
    harness.click("#discoverModelsButton");
    await harness.settle();

    assert.deepEqual(
      [...harness.document.querySelectorAll<HTMLOptionElement>(
        "#modelConfigSelector option",
      )].map((option) => option.textContent),
      ["Discovered model · model-discovered · Default"],
    );
    const draft = profileFixture({
      name: "Draft discovery",
      connection: {
        kind: "direct-api",
        apiFamily: "openai",
        apiMode: "chat-completions",
        apiKey: "draft-key",
        baseUrl: "https://draft.example/v1",
      },
      model: "typed-model",
    });
    const discoveryState = Object.assign(cloneState(stateFixture()), {
      availableModels: [{
        id: "typed-model",
        displayName: "Typed model",
        capabilities: { ...capabilities(), maxOutputTokens: 24_000 },
        capabilityEvidence: capabilityEvidence(),
      }],
      capabilities: { ...capabilities(), maxOutputTokens: 24_000 },
      modelStateSource: modelStateSourceFixture(draft),
    });

    harness.emitServerEvent({
      type: "state",
      commandId: harness.commandIds.at(-1),
      state: discoveryState,
    });

    assert.deepEqual(
      [...harness.document.querySelectorAll<HTMLOptionElement>(
        "#modelConfigSelector option",
      )].map((option) => option.textContent),
      ["Discovered model · model-discovered · Default"],
    );
    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#maxOutputTokens")?.max,
      "8192",
    );
    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#profileName")?.value,
      "Draft discovery",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("an earlier discovery SSE state is usable before its HTTP response arrives", async () => {
  const harness = await createDialogHarness();
  try {
    harness.input("#apiKey", "draft-key");
    harness.input("#baseUrl", "https://draft.example/v1");
    harness.input("#manualModelId", "typed-model");
    harness.click("#addManualModelButton");
    const draft = profileFixture({
      connection: {
        kind: "direct-api",
        apiFamily: "openai",
        apiMode: "chat-completions",
        apiKey: "draft-key",
        baseUrl: "https://draft.example/v1",
      },
      model: "typed-model",
    });
    const discoveryState = Object.assign(cloneState(stateFixture()), {
      availableModels: [{
        id: "typed-model",
        displayName: "Typed model",
        capabilities: { ...capabilities(), maxOutputTokens: 24_000 },
        capabilityEvidence: capabilityEvidence(),
      }],
      capabilities: { ...capabilities(), maxOutputTokens: 24_000 },
      modelStateSource: modelStateSourceFixture(draft),
    });
    harness.holdNextCommandResponse();
    harness.click("#discoverModelsButton");
    await Promise.resolve();
    const commandId = harness.commandIds.at(-1);
    assert.ok(commandId);

    discoveryState.modelCatalogLoadReceipt = commandId;
    harness.emitServerEvent({ type: "state", commandId, state: discoveryState });
    await harness.settle();

    assert.deepEqual(
      [...harness.document.querySelectorAll<HTMLOptionElement>(
        "#modelConfigSelector option",
      )].map((option) => option.textContent),
      ["Typed model · typed-model · Default"],
    );
    harness.releaseHeldCommandResponse();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("Save and Use sends the complete current draft for its selected API mode", async () => {
  const state = stateFixture();
  const expectedProfileRevision = state.activeProfileRevision;
  const harness = await createDialogHarness(state);
  try {
    harness.input("#profileName", "Anthropic studio");
    harness.select("#apiFamily", "anthropic");
    assert.deepEqual(
      [...harness.document.querySelectorAll<HTMLOptionElement>("#apiMode option")]
        .map((option) => option.value),
      ["messages"],
    );
    harness.input("#apiKey", "anthropic-key");
    harness.input("#baseUrl", "https://anthropic.example/v1");
    harness.input("#manualModelId", "claude-test");
    harness.click("#addManualModelButton");
    harness.click("#setDefaultModelButton");
    harness.select("#modelConfigSelector", "0");
    harness.click("#removeModelConfigButton");
    harness.input("#temperature", "0.7");
    harness.input("#maxOutputTokens", "4096");
    harness.input("#extraBody", "{\"metadata\":{\"source\":\"live\"}}");
    harness.click("#saveProfileButton");
    await harness.settle();

    assert.deepEqual(commandCalls(harness), [{
      path: "/command",
      body: {
        kind: "save_profile",
        expectedProfileRevision,
        profile: {
          id: "profile-1",
          name: "Anthropic studio",
          connection: {
            kind: "direct-api",
            apiFamily: "anthropic",
            apiMode: "messages",
            apiKey: "anthropic-key",
            baseUrl: "https://anthropic.example/v1",
          },
          defaultModel: "claude-test",
          models: [{
            model: "claude-test",
            parameters: {
              maxOutputTokens: 4096,
              temperature: 0.7,
              reasoning: { mode: "default" },
            },
            advanced: {
              extraBody: { metadata: { source: "live" } },
            },
          }],
        },
      },
    }]);
    assert.equal(harness.document.querySelector("#draftStatus")?.textContent, "Saved");
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("initial state preserves arbitrary JSON keys through Profile save", async () => {
  const state = stateFixture();
  const extraBody = JSON.parse(
    '{"__proto__":{"preserved":true},"nested":{"constructor":"data"}}',
  ) as Record<string, unknown>;
  state.settings.profiles[0]!.models[0]!.advanced.extraBody = extraBody;
  const harness = await createDialogHarness(state);
  try {
    assert.match(
      harness.document.querySelector<HTMLTextAreaElement>("#extraBody")?.value ?? "",
      /"__proto__"/,
    );
    harness.input("#profileName", "Prototype-safe profile");
    harness.click("#saveProfileButton");
    await harness.settle();

    const save = commandCalls(harness)[0]?.body as {
      profile?: SavedProfile;
    };
    const savedExtraBody = save.profile?.models[0]?.advanced.extraBody;
    assert.ok(savedExtraBody);
    assert.equal(
      Object.prototype.hasOwnProperty.call(savedExtraBody, "__proto__"),
      true,
    );
    assert.deepEqual(savedExtraBody, extraBody);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("Web Search is a single automatic Profile capability", async () => {
  const state = stateFixture();
  state.settings.profiles[0] = profileFixture({
    connection: {
      kind: "direct-api",
      apiFamily: "openai",
      apiMode: "responses",
      apiKey: "test-key",
      baseUrl: "https://example.test/v1",
    },
  });
  const harness = await createDialogHarness(state);
  try {
    const control = harness.document.querySelector<HTMLInputElement>(
      "#webSearchEnabled",
    );
    const hint = harness.document.querySelector("#webSearchHint");
    assert.ok(control);
    assert.equal(control.checked, false);
    assert.equal(control.disabled, false);
    assert.equal(control.labels?.[0]?.textContent?.trim(), "Allow Web Search");
    assert.equal((hint as HTMLElement | null)?.hidden, true);
    assert.equal(control.getAttribute("aria-describedby"), null);
    assert.equal(hint?.getAttribute("aria-live"), "polite");

    control.click();
    assert.equal((hint as HTMLElement | null)?.hidden, false);
    assert.match(hint?.textContent ?? "", /endpoint support.*verified/i);
    assert.equal(control.getAttribute("aria-describedby"), "webSearchHint");
    harness.click("#saveProfileButton");
    await harness.settle();
    const saved = (commandCalls(harness).at(-1)?.body as {
      profile?: SavedProfile;
    }).profile;
    assert.deepEqual(saved?.models[0]?.advanced.hostedTools, { webSearch: true });
    assert.equal(control.checked, true);

    assert.equal(harness.document.querySelector("#webSearchMenuButton"), null);

    harness.select("#apiMode", "chat-completions");
    assert.equal(control.checked, false);
    assert.equal(control.disabled, true);
    assert.match(hint?.textContent ?? "", /turned off.*Chat Completions/i);

    harness.select("#apiMode", "responses");
    assert.equal(control.disabled, false);
    assert.equal(control.checked, false);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("saved Web Search settings round-trip and remain locked with Profile settings", async () => {
  const state = stateFixture();
  state.settings.profiles[0] = profileFixture({
    connection: {
      kind: "direct-api",
      apiFamily: "openai",
      apiMode: "responses",
      apiKey: "test-key",
      baseUrl: "https://example.test/v1",
    },
    advanced: { hostedTools: { webSearch: true } },
  });
  const harness = await createDialogHarness(state);
  try {
    const control = harness.document.querySelector<HTMLInputElement>(
      "#webSearchEnabled",
    );
    assert.equal(control?.checked, true);
    harness.holdNextSend();
    harness.input("#prompt", "Keep settings locked");
    harness.click("#sendButton");
    await Promise.resolve();
    assert.equal(control?.disabled, true);
    harness.releaseHeldSend();
    await harness.settle();
    assert.equal(control?.disabled, false);
    assert.equal(control?.checked, true);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("unsupported discovered parameters become an explicit repair draft before Save", async () => {
  const state = stateFixture();
  state.settings.profiles[0] = profileFixture({
    parameters: {
      maxOutputTokens: 32_000,
      temperature: 0.7,
      reasoning: { mode: "enabled", effort: "high", budgetTokens: 4096 },
    },
  });
  state.availableModels = [{
    id: "model-a",
    displayName: "Model A",
    capabilities: {
      ...capabilities(),
      temperature: "unsupported",
      reasoning: {
        supported: false,
        canDisable: false,
        efforts: [],
        budgetTokens: false,
        strategy: "none",
      },
    },
    capabilityEvidence: {
      ...capabilityEvidence(),
      temperature: "unsupported",
    },
  }];
  const harness = await createDialogHarness(state);
  try {
    const temperature = harness.document.querySelector<HTMLInputElement>("#temperature");
    assert.equal(temperature?.disabled, true);
    assert.equal(temperature?.value, "");
    assert.equal(
      harness.document.querySelector<HTMLSelectElement>("#reasoningMode")?.value,
      "default",
    );
    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#reasoningBudgetTokens")?.value,
      "",
    );
    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#maxOutputTokens")?.value,
      "8192",
    );
    assert.equal(harness.document.querySelector("#draftStatus")?.textContent, "Unsaved changes");
    assert.equal(harness.document.querySelector<HTMLButtonElement>("#sendButton")?.disabled, true);

    harness.click("#saveProfileButton");
    await harness.settle();
    const save = commandCalls(harness).at(-1);
    assert.equal((save?.body as { kind?: string }).kind, "save_profile");
    assert.deepEqual(
      (save?.body as { profile: SavedProfile }).profile.models[0]?.parameters,
      { maxOutputTokens: 8192, reasoning: { mode: "default" } },
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("input capability overrides round-trip through the Profile form", async () => {
  const harness = await createDialogHarness();
  try {
    harness.select("#overrideInputImage", "true");
    harness.select("#overrideInputAudio", "false");
    harness.select("#overrideInputPdf", "true");

    assert.deepEqual(renderedCapabilityStatuses(harness), [
      ["Image ✓", "supported"],
      ["Audio ×", "unsupported"],
      ["PDF ✓", "supported"],
    ]);

    harness.click("#saveProfileButton");
    await harness.settle();

    const profile = (commandCalls(harness).at(-1)?.body as {
      profile?: SavedProfile;
    }).profile;
    assert.deepEqual(profile?.models[0]?.advanced.capabilityOverrides?.inputs, {
      image: true,
      audio: false,
      pdf: true,
    });
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("input capability preview distinguishes unverified fields from unsupported fields", async () => {
  const harness = await createDialogHarness();
  try {
    const preview = () => renderedCapabilityStatuses(harness);
    assert.deepEqual(preview(), [
      ["Image ×", "unsupported"],
      ["Audio ×", "unsupported"],
      ["PDF ×", "unsupported"],
    ]);

    const originalBaseUrl = harness.document.querySelector<HTMLInputElement>(
      "#baseUrl",
    )?.value;
    assert.ok(originalBaseUrl);
    harness.input("#baseUrl", "https://unverified.example/v1");
    assert.deepEqual(preview(), [
      ["Image ?", "unverified"],
      ["Audio ?", "unverified"],
      ["PDF ?", "unverified"],
    ]);

    harness.select("#overrideInputImage", "true");
    assert.deepEqual(preview(), [
      ["Image ✓", "supported"],
      ["Audio ?", "unverified"],
      ["PDF ?", "unverified"],
    ]);

    harness.input("#baseUrl", originalBaseUrl);
    assert.deepEqual(preview(), [
      ["Image ✓", "supported"],
      ["Audio ×", "unsupported"],
      ["PDF ×", "unsupported"],
    ]);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("Profile command errors identify and focus the invalid field", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const harness = await createDialogHarness(state);
  try {
    harness.input("#baseUrl", "invalid-url");
    harness.failNextCommand("Base URL is invalid.", "connection.baseUrl");
    harness.click("#saveProfileButton");
    await harness.settle();

    const baseUrl = harness.document.querySelector<HTMLInputElement>("#baseUrl");
    assert.equal(baseUrl?.getAttribute("aria-invalid"), "true");
    assert.equal(
      baseUrl?.closest(".field")?.querySelector(".field-error")?.textContent,
      "Base URL is invalid.",
    );
    assert.equal(harness.document.activeElement, baseUrl);
    assert.equal(
      harness.document.querySelector<HTMLElement>("#inspectorPane")?.hidden,
      false,
    );
    assert.equal(
      harness.document.querySelector("#agentTab")?.getAttribute("aria-selected"),
      "true",
    );
    assert.equal(harness.document.querySelector<HTMLElement>("#agentPanel")?.hidden, false);

    harness.input("#profileName", "Another name");
    assert.equal(baseUrl?.getAttribute("aria-invalid"), "true");
    assert.equal(
      baseUrl?.closest(".field")?.querySelector(".field-error")?.textContent,
      "Base URL is invalid.",
    );
    harness.click("#newSessionButton");
    await harness.settle();
    assert.equal(baseUrl?.getAttribute("aria-invalid"), "true");
    assert.equal(
      baseUrl?.closest(".field")?.querySelector(".field-error")?.textContent,
      "Base URL is invalid.",
    );
    harness.input("#baseUrl", "https://valid.example/v1");
    assert.equal(baseUrl?.hasAttribute("aria-invalid"), false);
    assert.equal(baseUrl?.closest(".field")?.querySelector(".field-error"), null);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("Save exposes pending feedback until the Profile command completes", async () => {
  const harness = await createDialogHarness();
  try {
    harness.input("#profileName", "Studio updated");
    harness.holdNextCommand();
    harness.click("#saveProfileButton");
    await Promise.resolve();

    const save = harness.document.querySelector<HTMLButtonElement>("#saveProfileButton");
    assert.equal(save?.textContent, "Saving…");
    assert.equal(save?.disabled, true);
    const close = harness.document.querySelector<HTMLButtonElement>("#closeButton");
    assert.equal(close?.disabled, false);
    close?.click();
    await harness.cancelAppConfirmation();
    assert.deepEqual(harness.hostMessages, []);
    assert.equal(
      harness.document.querySelector("#modelProfileControls")?.getAttribute("aria-busy"),
      "true",
    );
    assert.match(harness.document.querySelector("#status")?.textContent ?? "", /saving/i);

    harness.releaseHeldCommand();
    await harness.settle();

    assert.equal(save?.textContent, "Save & Use");
    assert.equal(save?.disabled, true);
    assert.equal(close?.disabled, false);
    assert.equal(
      harness.document.querySelector("#modelProfileControls")?.getAttribute("aria-busy"),
      "false",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("Cmd or Ctrl Enter cannot send while a command is running", async () => {
  const harness = await createDialogHarness();
  try {
    harness.holdNextCommand();
    harness.click("#newSessionButton");
    await Promise.resolve();
    harness.input("#prompt", "Do not send during save");
    harness.document.querySelector("#prompt")?.dispatchEvent(
      new harness.window.KeyboardEvent("keydown", {
        bubbles: true,
        key: "Enter",
        metaKey: true,
      }),
    );
    await harness.settle();

    assert.deepEqual(harness.calls.filter((call) => call.path === "/send"), []);
    harness.releaseHeldCommand();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a late send completion cannot unlock controls owned by an active command", async () => {
  const harness = await createDialogHarness();
  try {
    harness.input("#profileName", "Studio updated");
    harness.holdNextCommand();
    harness.click("#saveProfileButton");
    await Promise.resolve();
    harness.emitServerEvent({ type: "done", state: cloneState(stateFixture()) });

    assert.equal(
      harness.document.querySelector<HTMLButtonElement>("#saveProfileButton")?.disabled,
      true,
    );
    assert.equal(
      harness.document.querySelector<HTMLButtonElement>("#discardProfileButton")?.disabled,
      true,
    );
    harness.releaseHeldCommand();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("unknown model output limits allow values above the 8192 profile default", async () => {
  const harness = await createDialogHarness();
  try {
    harness.input("#manualModelId", "custom-unknown-model");
    harness.click("#addManualModelButton");
    const outputTokens = harness.document.querySelector<HTMLInputElement>(
      "#maxOutputTokens",
    );
    assert.equal(outputTokens?.max, "1000000");
    assert.equal(
      harness.document.querySelector("label[for='maxOutputTokens']")?.textContent,
      "Requested max output tokens",
    );
    assert.match(
      harness.document.querySelector("#maxOutputTokensHint")?.textContent ?? "",
      /unknown.*validated by the provider/i,
    );

    harness.input("#maxOutputTokens", "64000");
    harness.click("#setDefaultModelButton");
    harness.click("#saveProfileButton");
    await harness.settle();

    const save = commandCalls(harness).find(
      (call) => (call.body as { kind?: string }).kind === "save_profile",
    );
    const savedProfile = (save?.body as {
      profile?: SavedProfile;
    }).profile;
    assert.equal(savedProfile?.defaultModel, "custom-unknown-model");
    assert.equal(
      savedProfile?.models.find(
        (model) => model.model === "custom-unknown-model",
      )?.parameters.maxOutputTokens,
      64_000,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("discovered model output limits still constrain the Profile input", async () => {
  const state = stateFixture();
  state.availableModels = [{
    id: "discovered-24k",
    displayName: "Discovered 24K",
    capabilities: { ...capabilities(), maxOutputTokens: 24_000 },
    capabilityEvidence: capabilityEvidence(),
  }];
  const harness = await createDialogHarness(state);
  try {
    harness.input("#manualModelId", "discovered-24k");
    harness.click("#addManualModelButton");
    assert.equal(
      harness.document.querySelector<HTMLInputElement>("#maxOutputTokens")?.max,
      "24000",
    );
    assert.equal(
      harness.document.querySelector("#maxOutputTokensHint")?.textContent,
      "Model limit: 24000.",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("capability cleanup clears stale field errors from values it removes or clamps", async () => {
  const state = stateFixture();
  state.capabilities = {
    ...capabilities(),
    reasoning: {
      supported: true,
      canDisable: true,
      efforts: ["high"],
      budgetTokens: true,
      strategy: "effort",
    },
  };
  state.capabilityEvidence = {
    ...state.capabilityEvidence,
    reasoning: "supported",
  };
  state.settings.profiles[0] = profileFixture({
    parameters: {
      maxOutputTokens: 8192,
      temperature: 0.7,
      reasoning: { mode: "enabled", effort: "high", budgetTokens: 4096 },
    },
  });
  const harness = await createDialogHarness(state);
  try {
    harness.input("#profileName", "Needs capability repair");
    harness.failNextCommand(
      "Temperature is invalid.",
      "models.0.parameters.temperature",
    );
    harness.click("#saveProfileButton");
    await harness.settle();
    const temperature = harness.document.querySelector<HTMLInputElement>("#temperature");
    assert.equal(temperature?.getAttribute("aria-invalid"), "true");

    harness.select("#overrideTemperature", "unsupported");

    assert.equal(temperature?.value, "");
    assert.equal(temperature?.hasAttribute("aria-invalid"), false);
    assert.equal(harness.document.querySelector("#temperatureError"), null);

    harness.failNextCommand(
      "Output limit is invalid.",
      "models.0.parameters.maxOutputTokens",
    );
    harness.click("#saveProfileButton");
    await harness.settle();
    const output = harness.document.querySelector<HTMLInputElement>("#maxOutputTokens");
    assert.equal(output?.getAttribute("aria-invalid"), "true");

    harness.input("#overrideMaxOutputTokens", "1024");

    assert.equal(output?.value, "1024");
    assert.equal(output?.hasAttribute("aria-invalid"), false);
    assert.equal(harness.document.querySelector("#maxOutputTokensError"), null);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

for (const [field, value, label] of [
  ["#baseUrl", "https://another-provider.example/v1", "Base URL"],
  ["#apiKey", "another-provider-key", "API key"],
] as const) {
  test(`changing the ${label} invalidates model limits from the previous connection`, async () => {
    const state = stateFixture();
    state.availableModels = [{
      id: "model-a",
      displayName: "Model A",
      capabilities: { ...capabilities(), maxOutputTokens: 8192 },
      capabilityEvidence: capabilityEvidence(),
    }];
    const harness = await createDialogHarness(state);
    try {
      const originalValue = harness.document.querySelector<HTMLInputElement>(field)?.value;
      assert.ok(originalValue);
      assert.equal(
        harness.document.querySelector<HTMLInputElement>("#maxOutputTokens")?.max,
        "8192",
      );
      harness.input(field, value);

      assert.equal(
        harness.document.querySelector<HTMLInputElement>("#maxOutputTokens")?.max,
        "1000000",
      );
      assert.match(
        harness.document.querySelector("#maxOutputTokensHint")?.textContent ?? "",
        /unknown.*validated by the provider/i,
      );
      harness.input(field, originalValue);

      assert.equal(
        harness.document.querySelector<HTMLInputElement>("#maxOutputTokens")?.max,
        "8192",
      );
      assert.deepEqual(harness.errors, []);
    } finally {
      harness.close();
    }
  });
}

for (const [field, value, label] of [
  ["#baseUrl", "https://rotated-provider.example/v1", "Base URL"],
  ["#apiKey", "rotated-provider-key", "API key"],
] as const) {
  test(`changing the ${label} preserves reasoning values while draft capabilities are unknown`, async () => {
    const state = stateFixture();
    const reasoningProfile = profileFixture({
      parameters: {
        maxOutputTokens: 8192,
        reasoning: { mode: "enabled", effort: "high", budgetTokens: 4096 },
      },
    });
    state.settings.profiles[0] = reasoningProfile;
    state.modelStateSource = modelStateSourceFixture(reasoningProfile);
    state.capabilities = {
      ...capabilities(),
      reasoning: {
        supported: true,
        canDisable: true,
        efforts: ["high"],
        budgetTokens: true,
        strategy: "budget-thinking",
      },
    };
    state.capabilityEvidence = {
      ...state.capabilityEvidence,
      reasoning: "supported",
    };
    const harness = await createDialogHarness(state);
    try {
      harness.input(field, value);

      assert.equal(
        harness.document.querySelector<HTMLSelectElement>("#reasoningMode")?.value,
        "enabled",
      );
      assert.equal(
        harness.document.querySelector<HTMLSelectElement>("#reasoningEffort")?.value,
        "high",
      );
      assert.equal(
        harness.document.querySelector<HTMLInputElement>("#reasoningBudgetTokens")?.value,
        "4096",
      );

      harness.click("#saveProfileButton");
      await harness.settle();
      const saved = commandCalls(harness).at(-1)?.body as {
        kind?: string;
        profile?: SavedProfile;
      };
      assert.equal(saved.kind, "save_profile");
      assert.deepEqual(saved.profile?.models[0]?.parameters.reasoning, {
        mode: "enabled",
        effort: "high",
        budgetTokens: 4096,
      });
      assert.deepEqual(harness.errors, []);
    } finally {
      harness.close();
    }
  });
}
