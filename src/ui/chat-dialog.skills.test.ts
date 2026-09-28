import assert from "node:assert/strict";
import test from "node:test";

import { availableSkillSummaries } from "../skills/builtins.js";
import {
  commandCalls,
  createDialogHarness,
  jsonCalls,
  stateFixture,
  waitForCondition,
} from "./chat-dialog.test-harness.js";

test("Session Skill selection and global Skill management have separate controls", async () => {
  const state = stateFixture();
  state.availableSkills = availableSkillSummaries([{
    id: "user-mix-notes",
    description: "Remember the user's mix process",
  }]);
  const harness = await createDialogHarness(state);
  try {
    harness.click("#skillsTab");
    const builtInList = harness.document.querySelector("#builtInSkillList");
    const userList = harness.document.querySelector("#userSkillList");
    const library = harness.document.querySelector("#skillLibrary");
    const libraryList = harness.document.querySelector("#userSkillLibraryList");
    assert.ok(library && libraryList);
    assert.equal(builtInList?.getAttribute("aria-labelledby"), "builtInSkillsHeading");
    assert.equal(userList?.getAttribute("aria-labelledby"), "userSkillsHeading");
    assert.equal(builtInList?.querySelectorAll(".skill-row").length, 3);
    assert.equal(userList?.querySelectorAll(".skill-row").length, 1);

    const builtInRow = builtInList?.querySelector<HTMLElement>(
      '[data-skill-id="arranging-section-energy"]',
    );
    assert.equal(builtInRow?.dataset.skillSource, "built-in");
    assert.equal(builtInRow?.querySelector("strong")?.getAttribute("translate"), "no");
    assert.equal(
      builtInRow?.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked,
      false,
    );
    assert.equal(builtInRow?.querySelector(".skill-delete"), null);

    const userRow = userList?.querySelector<HTMLElement>(
      '[data-skill-id="user-mix-notes"]',
    );
    assert.equal(userRow?.dataset.skillSource, "user");
    assert.equal(userRow?.querySelector(".skill-delete"), null);
    const libraryRow = libraryList.querySelector<HTMLElement>(
      '[data-skill-id="user-mix-notes"]',
    );
    assert.equal(libraryList.querySelectorAll(".skill-row").length, 1);
    assert.equal(libraryRow?.dataset.skillSource, "user");
    assert.equal(libraryRow?.querySelector("strong")?.textContent, "user-mix-notes");
    assert.equal(libraryRow?.querySelector(".skill-copy span")?.textContent,
      "Remember the user's mix process");
    assert.equal(libraryRow?.querySelector("input"), null);
    assert.equal(libraryRow?.querySelector<HTMLButtonElement>(".skill-delete")?.textContent, "Delete");
    assert.equal(harness.document.querySelector("#skillManager")?.contains(
      harness.document.getElementById("skillDropZone"),
    ), false);
    assert.equal(library.contains(harness.document.getElementById("skillDropZone")), true);
    assert.equal(library.contains(harness.document.getElementById("skillPasteText")), true);

    const builtInToggle = builtInRow?.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    harness.holdNextCommand();
    builtInToggle?.focus();
    builtInToggle?.click();
    await waitForCondition(
      () => commandCalls(harness).length === 1,
      "Expected the built-in toggle command to start.",
    );
    assert.equal(
      harness.document.activeElement,
      harness.document.querySelector("#skillManager"),
    );
    assert.equal(builtInToggle?.isConnected, true);
    assert.equal(builtInToggle?.disabled, true);
    assert.equal(
      harness.document.querySelector("#skillManager")?.getAttribute("aria-busy"),
      "true",
    );
    assert.equal(library.getAttribute("aria-busy"), "true");
    assert.equal(libraryRow?.querySelector<HTMLButtonElement>(".skill-delete")?.disabled, true);
    harness.releaseHeldCommand();
    await harness.settle();
    assert.deepEqual(commandCalls(harness).at(-1)?.body, {
      kind: "set_session_skills",
      sessionId: "session-1",
      skillIds: ["arranging-section-energy"],
    });
    assert.equal(
      harness.document.activeElement,
      builtInList?.querySelector(
        '[data-skill-id="arranging-section-energy"] input[type="checkbox"]',
      ),
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("global Skill inventory includes disabled package contents without Session activation controls", async () => {
  const state = stateFixture();
  state.availableSkills = availableSkillSummaries([{ id: "user-guide", description: "Local guide" }]);
  const disabledSkill = { id: "offline-tools:convert", description: "Authored <b>conversion</b> summary" };
  const enabledSkill = { id: "active-tools:analyze", description: "Analyze notes" };
  state.availableSkills.push({ ...enabledSkill, source: "plugin", pluginId: "active-tools" });
  state.plugins = [
    { id: "offline-tools", sha256: "a".repeat(64), sourceFormat: "codex", enabled: false,
      skillCount: 1, skills: [disabledSkill], mcpServers: [], unsupportedComponents: [], issues: [] },
    { id: "active-tools", sha256: "b".repeat(64), sourceFormat: "codex", enabled: true,
      skillCount: 1, mcpServers: [], unsupportedComponents: [], issues: [] },
    { id: "older-tools", sha256: "c".repeat(64), sourceFormat: "codex", enabled: false,
      skillCount: 1, mcpServers: [], unsupportedComponents: [], issues: [] },
  ];
  const harness = await createDialogHarness(state);
  try {
    harness.click("#extensionsTab");
    harness.click("#skillsExtensionTab");
    const library = harness.document.querySelector("#skillLibrary");
    assert.equal(library?.querySelectorAll('input[type="checkbox"]').length, 0);
    assert.equal(library?.querySelectorAll("#builtInSkillLibraryList .skill-view").length, 3);
    assert.equal(library?.querySelectorAll("#userSkillLibraryList .skill-delete").length, 1);
    assert.equal(library?.querySelector("#userSkillLibraryList .skill-view"), null);
    assert.equal(library?.querySelector("#pluginSkillLibraryList .skill-view"), null);
    assert.equal(library?.querySelector("#pluginSkillLibraryList .skill-delete"), null);
    const disabled = harness.document.getElementById("pluginSkillSource-offline-tools");
    assert.match(disabled?.textContent ?? "", /Plugin offline-tools.*Disabled/u);
    assert.equal(disabled?.querySelector(".skill-copy strong")?.textContent, disabledSkill.id);
    assert.equal(disabled?.querySelector(".skill-copy span")?.textContent, disabledSkill.description);
    assert.equal(disabled?.querySelector(".skill-copy span")?.children.length, 0);
    assert.equal(disabled?.querySelectorAll(".skill-plugin-link").length, 1);
    assert.equal(disabled?.querySelector(".skill-row button"), null);
    assert.equal(harness.document.querySelector("#pluginSkillSource-active-tools .skill-copy strong")?.textContent, enabledSkill.id);
    assert.match(harness.document.querySelector("#pluginSkillSource-older-tools")?.textContent ?? "", /Skill metadata is unavailable/u);
    assert.equal(harness.document.querySelector("#pluginSkillList [data-skill-id='offline-tools:convert']"), null);
    assert.equal(harness.document.querySelectorAll("#pluginSkillList .skill-row").length, 1);
    assert.deepEqual(commandCalls(harness), []);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("built-in Skills participate in prompt autocomplete", async () => {
  const state = stateFixture();
  state.availableSkills = availableSkillSummaries([]);
  const harness = await createDialogHarness(state);
  try {
    const prompt = harness.document.querySelector<HTMLTextAreaElement>("#prompt");
    const listbox = harness.document.querySelector<HTMLElement>("#composerAutocomplete");
    assert.ok(prompt && listbox);
    prompt.focus();
    harness.input("#prompt", "$arr");
    assert.equal(listbox.hidden, false);
    assert.deepEqual(
      [...listbox.querySelectorAll("[role='option'] strong")]
        .map((option) => option.textContent),
      ["$arranging-section-energy"],
    );
    assert.equal(
      listbox.querySelector("[role='option'] strong")?.getAttribute("translate"),
      "no",
    );
  } finally {
    harness.close();
  }
});

test("the Built-in group explains when legacy User Skills replace every built-in", async () => {
  const state = stateFixture();
  state.availableSkills = availableSkillSummaries([
    { id: "arranging-section-energy", description: "Legacy section guidance" },
    { id: "developing-musical-variation", description: "Legacy variation guidance" },
    { id: "organizing-instrument-roles", description: "Legacy role guidance" },
  ]);
  const harness = await createDialogHarness(state);
  try {
    assert.equal(
      harness.document.querySelectorAll("#builtInSkillList .skill-row").length,
      0,
    );
    const empty = harness.document.querySelector<HTMLElement>(
      "#builtInSkillEmptyState",
    );
    assert.equal(empty?.hidden, false);
    assert.match(empty?.textContent ?? "", /same-ID User Skills.*below/i);
    assert.equal(
      harness.document.querySelectorAll("#userSkillList .skill-row").length,
      3,
    );
  } finally {
    harness.close();
  }
});

test("importing a built-in Skill ID fails without offering replacement", async () => {
  const state = stateFixture();
  state.availableSkills = availableSkillSummaries([]);
  const harness = await createDialogHarness(state);
  try {
    const file = new harness.window.File([
      "---\nname: arranging-section-energy\ndescription: User replacement\n---\nReplacement body\n",
    ], "SKILL.md", { type: "text/markdown" });
    harness.dropSkillFile(file);
    await waitForCondition(
      () => harness.calls.some((call) => call.path === "/skills"),
      "Expected built-in Skill import request.",
    );
    await harness.settle();

    const uploads = harness.calls.filter((call) => call.path === "/skills");
    assert.equal(uploads.length, 1);
    assert.match(uploads[0]!.url, /replace=false/);
    assert.equal(
      harness.document.querySelector<HTMLDivElement>("#appConfirmation")?.hidden,
      true,
    );
    assert.match(
      harness.document.querySelector("#status")?.textContent ?? "",
      /built-in.*read-only/i,
    );
  } finally {
    harness.close();
  }
});

test("the initial-state decoder requires a recognized Skill source", async () => {
  for (const availableSkills of [
    [{ id: "mix-review", description: "Review balance" }],
    [{ id: "mix-review", description: "Review balance", source: "remote" }],
  ]) {
    const malformed = {
      ...stateFixture(),
      availableSkills,
    } as unknown as Parameters<typeof createDialogHarness>[0];
    const harness = await createDialogHarness(malformed);
    try {
      assert.match(
        harness.document.querySelector("#status")?.textContent ?? "",
        /invalid initial state/i,
      );
      assert.equal("LiveSmithUI" in harness.window, false);
      assert.deepEqual(harness.errors, []);
    } finally {
      harness.close();
    }
  }
});

test("enabled Plugin Skills render in their own group and toggle by namespaced ID", async () => {
  const state = stateFixture();
  state.availableSkills = [{
    id: "music-tools:audio-to-midi",
    description: "Convert audio into MIDI",
    source: "plugin",
    pluginId: "music-tools",
  }];
  const harness = await createDialogHarness(state);
  try {
    const row = harness.document.querySelector<HTMLElement>("#pluginSkillList .skill-row");
    assert.equal(row?.dataset.skillId, "music-tools:audio-to-midi");
    assert.equal(row?.querySelector(".skill-delete"), null);
    const toggle = row?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    assert.ok(toggle);
    toggle.click();
    await harness.settle();
    assert.deepEqual(jsonCalls(harness, "/command").at(-1)?.body, {
      kind: "set_session_skills",
      sessionId: state.activeSessionId,
      skillIds: ["music-tools:audio-to-midi"],
    });
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("Skill toggle focus survives command failure and the four-Skill limit", async () => {
  const activeSkillIds = [
    "arranging-section-energy",
    "developing-musical-variation",
    "organizing-instrument-roles",
    "user-fourth",
  ];
  const state = stateFixture();
  state.availableSkills = availableSkillSummaries([
    { id: "user-fourth", description: "Fourth workflow" },
    { id: "user-fifth", description: "Fifth workflow" },
  ]);
  state.sessions[0]!.activeSkillIds = [...activeSkillIds];
  state.activeSkillIds = [...activeSkillIds];
  const harness = await createDialogHarness(state);
  try {
    const fifth = harness.document.querySelector<HTMLInputElement>(
      '[data-skill-id="user-fifth"] input[type="checkbox"]',
    );
    assert.ok(fifth);
    fifth.focus();
    fifth.click();
    await harness.settle();
    const restoredFifth = harness.document.querySelector<HTMLInputElement>(
      '[data-skill-id="user-fifth"] input[type="checkbox"]',
    );
    assert.equal(harness.document.activeElement, restoredFifth);
    assert.equal(restoredFifth?.checked, false);
    assert.match(
      harness.document.querySelector("#status")?.textContent ?? "",
      /at most 4 Skills/i,
    );

    const active = harness.document.querySelector<HTMLInputElement>(
      '[data-skill-id="arranging-section-energy"] input[type="checkbox"]',
    );
    assert.ok(active);
    harness.failNextCommand("Session Skill update failed.");
    active.focus();
    active.click();
    await harness.settle();
    assert.equal(
      harness.document.activeElement,
      harness.document.querySelector(
        '[data-skill-id="arranging-section-energy"] input[type="checkbox"]',
      ),
    );
  } finally {
    harness.close();
  }
});

for (const surface of ["Session", "library"] as const) {
  test(`${surface} Skill completion does not steal focus moved elsewhere while busy`, async () => {
    const state = stateFixture();
    state.availableSkills = availableSkillSummaries([
      { id: "user-notes", description: "Session notes" },
    ]);
    state.activeSkillIds = ["user-notes"];
    state.sessions[0]!.activeSkillIds = ["user-notes"];
    const harness = await createDialogHarness(state);
    let commandHeld = false;
    try {
      harness.click(surface === "Session" ? "#skillsTab" : "#extensionsTab");
      const control = harness.document.querySelector<HTMLInputElement | HTMLButtonElement>(
        surface === "Session"
          ? '#userSkillList [data-skill-id="user-notes"] input'
          : '#userSkillLibraryList [data-skill-id="user-notes"] .skill-delete',
      );
      const close = harness.document.querySelector<HTMLButtonElement>("#closeButton");
      assert.ok(control && close);
      harness.holdNextCommand();
      commandHeld = true;
      control.focus();
      control.click();
      if (surface === "library") await harness.acceptAppConfirmation();
      await waitForCondition(
        () => commandCalls(harness).length === 1,
        "Expected the held Skill command to start.",
      );
      close.focus();
      assert.equal(harness.document.activeElement, close);
      harness.releaseHeldCommand();
      commandHeld = false;
      await harness.settle();
      assert.equal(harness.document.activeElement, close);
    } finally {
      if (commandHeld) harness.releaseHeldCommand();
      harness.close();
    }
  });
}

test("keyboard users can paste Skill Markdown without a native file picker", async () => {
  const harness = await createDialogHarness(stateFixture());
  try {
    harness.click("#extensionsTab");
    const install = harness.document.querySelector<HTMLButtonElement>(
      "#installPastedSkillButton",
    );
    assert.equal(
      harness.document.querySelector("#skillPasteText")?.getAttribute("name"),
      "skillMarkdown",
    );
    assert.equal(install?.disabled, true);
    harness.input("#skillPasteText", [
      "---",
      "name: pasted-skill",
      "description: Imported from pasted Markdown",
      "---",
      "Pasted Skill body",
      "",
    ].join("\n"));
    assert.equal(install?.disabled, false);
    install?.focus();
    harness.click("#installPastedSkillButton");
    await waitForCondition(
      () => harness.calls.some((call) => call.path === "/skills"),
      "Expected pasted Skill install request.",
    );
    await harness.settle();

    const upload = harness.calls.find((call) => call.path === "/skills");
    assert.ok(upload?.body instanceof harness.window.File);
    assert.match(
      harness.document.querySelector("[data-skill-id='pasted-skill']")?.textContent ?? "",
      /Imported from pasted Markdown/,
    );
    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#skillPasteText")?.value,
      "",
    );
    assert.equal(
      harness.document.activeElement,
      harness.document.querySelector(
        '#userSkillLibraryList [data-skill-id="pasted-skill"] .skill-delete',
      ),
    );
    assert.equal(
      harness.document.querySelector<HTMLInputElement>(
        '#userSkillList [data-skill-id="pasted-skill"] input',
      )?.checked,
      false,
    );
    assert.equal(harness.document.querySelector("#userSkillLibraryEmptyState")?.hasAttribute("hidden"), true);
    assert.deepEqual(commandCalls(harness), []);

    harness.input("#skillPasteText", [
      "---",
      "name: arranging-section-energy",
      "description: Cannot replace a built-in",
      "---",
      "Replacement body",
      "",
    ].join("\n"));
    install?.focus();
    harness.click("#installPastedSkillButton");
    await waitForCondition(
      () => harness.calls.filter((call) => call.path === "/skills").length === 2,
      "Expected the rejected pasted built-in request.",
    );
    await harness.settle();
    assert.equal(harness.document.activeElement, install);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("Skill import, activation, and deletion keep bodies off JSON command paths", async () => {
  const harness = await createDialogHarness(stateFixture());
  try {
    const markdown = [
      "---",
      "name: mix-review",
      "description: Review balance and space",
      "---",
      "PRIVATE SKILL BODY",
      "",
    ].join("\n");
    const file = new harness.window.File(
      [markdown],
      "PRIVATE-local-path-name.md",
      { type: "text/markdown" },
    );
    harness.dropSkillFile(file);
    await waitForCondition(
      () => harness.calls.some((call) => call.path === "/skills"),
      "Expected Skill import request.",
    );
    await harness.settle();

    const upload = harness.calls.find((call) => call.path === "/skills");
    assert.ok(upload);
    assert.equal(upload.body, file);
    assert.equal(upload.url.includes("PRIVATE-local-path-name"), false);
    assert.equal(
      (upload.headers as Record<string, string>)["Content-Type"],
      "text/markdown; charset=utf-8",
    );
    assert.match(
      (upload.headers as Record<string, string>)["X-Live-Smith-Command-Id"] ?? "",
      /^[A-Za-z0-9._:-]+$/,
    );
    assert.match(
      harness.document.querySelector("[data-skill-id='mix-review']")?.textContent ?? "",
      /Review balance and space/,
    );
    assert.doesNotMatch(harness.document.body.textContent ?? "", /PRIVATE SKILL BODY/);

    const toggle = harness.document.querySelector<HTMLInputElement>(
      "[data-skill-id='mix-review'] input[type='checkbox']",
    );
    assert.ok(toggle);
    toggle.click();
    await harness.settle();
    assert.deepEqual(commandCalls(harness).at(-1)?.body, {
      kind: "set_session_skills",
      sessionId: "session-1",
      skillIds: ["mix-review"],
    });
    const deleteButton = harness.document.querySelector<HTMLButtonElement>(
      "#userSkillLibraryList [data-skill-id='mix-review'] .skill-delete",
    );
    assert.equal(deleteButton?.disabled, false);
    assert.equal(deleteButton?.textContent, "Disable");
    deleteButton?.focus();
    deleteButton?.click();
    await harness.acceptAppConfirmation();
    await harness.settle();
    assert.deepEqual(commandCalls(harness).at(-1)?.body, {
      kind: "set_session_skills",
      sessionId: "session-1",
      skillIds: [],
    });
    const enabledDelete = harness.document.querySelector<HTMLButtonElement>(
      "#userSkillLibraryList [data-skill-id='mix-review'] .skill-delete",
    );
    assert.equal(enabledDelete?.disabled, false);
    enabledDelete?.focus();
    enabledDelete?.click();
    await harness.acceptAppConfirmation();
    await harness.settle();
    assert.ok(harness.calls.some((call) => call.path === "/skills/mix-review"));
    assert.equal(
      harness.document.activeElement,
      harness.document.querySelector("#skillLibrary .skill-paste > summary"),
    );
    assert.equal(harness.document.querySelector("#userSkillList .skill-row"), null);
    assert.equal(harness.document.querySelector("#userSkillLibraryList .skill-row"), null);
    assert.equal(harness.document.querySelector<HTMLElement>("#userSkillEmptyState")?.hidden, false);
    assert.equal(harness.document.querySelector<HTMLElement>("#userSkillLibraryEmptyState")?.hidden, false);
    assert.equal(
      harness.calls.filter((call) => call.jsonBody !== undefined)
        .some((call) => JSON.stringify(call.jsonBody).includes("PRIVATE SKILL BODY")),
      false,
    );
  } finally {
    harness.close();
  }
});

test("Skill replacement requires confirmation and retries the same raw file explicitly", async () => {
  const state = stateFixture();
  state.availableSkills = [{
    id: "mix-review",
    description: "Old guidance",
    source: "user",
  }];
  const harness = await createDialogHarness(state);
  try {
    const file = new harness.window.File([
      "---\nname: mix-review\ndescription: New guidance\n---\nNew private body.\n",
    ], "replacement.md", { type: "text/markdown" });
    harness.dropSkillFile(file);
    await harness.acceptAppConfirmation();
    await waitForCondition(
      () => harness.calls.filter((call) => call.path === "/skills").length === 2,
      "Expected confirmed Skill replacement request.",
    );
    await harness.settle();

    const uploads = harness.calls.filter((call) => call.path === "/skills");
    assert.equal(uploads.length, 2);
    assert.match(uploads[0]!.url, /replace=false/);
    assert.match(uploads[1]!.url, /replace=true/);
    assert.equal(uploads[0]!.body, file);
    assert.equal(uploads[1]!.body, file);
    assert.match(
      harness.document.querySelector("[data-skill-id='mix-review']")?.textContent ?? "",
      /New guidance/,
    );
  } finally {
    harness.close();
  }
});

test("a response-lost Skill replacement crosses the state barrier before a new-ID receipt retry", async () => {
  const state = stateFixture();
  state.availableSkills = [{
    id: "mix-review",
    description: "Same summary",
    source: "user",
  }];
  const harness = await createDialogHarness(state);
  try {
    const file = new harness.window.File([
      "---\nname: mix-review\ndescription: Same summary\n---\nReplacement body that differs from the installed Skill.\n",
    ], "replacement.md", { type: "text/markdown" });
    harness.rejectNextSkillResponseAfterCommit("Bridge response was lost.");
    harness.dropSkillFile(file);
    await harness.acceptAppConfirmation();

    await waitForCondition(
      () => harness.calls.filter((call) => call.path === "/skills").length === 3,
      "Expected the interrupted replacement to make one reconciled retry.",
    );
    await harness.settle();

    const paths = harness.calls.filter((call) => call.path !== "/session-tools").map((call) => call.path);
    assert.deepEqual(paths, ["/skills", "/skills", "/state", "/skills"]);
    const replacementCalls = harness.calls.filter(
      (call) => call.path === "/skills" && call.url.includes("replace=true"),
    );
    assert.equal(replacementCalls.length, 2);
    assert.equal(replacementCalls[0]?.body, file);
    assert.equal(replacementCalls[1]?.body, file);
    const firstId = (replacementCalls[0]?.headers as Record<string, string>)[
      "X-Live-Smith-Command-Id"
    ];
    const retryId = (replacementCalls[1]?.headers as Record<string, string>)[
      "X-Live-Smith-Command-Id"
    ];
    assert.match(firstId ?? "", /^[A-Za-z0-9._:-]+$/);
    assert.match(retryId ?? "", /^[A-Za-z0-9._:-]+$/);
    assert.notEqual(retryId, firstId);
    assert.equal(
      harness.document.querySelector<HTMLButtonElement>("#sendButton")?.disabled,
      false,
    );
    assert.match(
      harness.document.querySelector("[data-skill-id='mix-review']")?.textContent ?? "",
      /Same summary/,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("an interrupted Skill retry that cannot confirm a receipt blocks later mutations", async () => {
  const state = stateFixture();
  state.availableSkills = [{
    id: "mix-review",
    description: "Same summary",
    source: "user",
  }];
  const harness = await createDialogHarness(state);
  try {
    const file = new harness.window.File([
      "---\nname: mix-review\ndescription: Same summary\n---\nReplacement body that must be confirmed.\n",
    ], "replacement.md", { type: "text/markdown" });
    harness.rejectNextSkillResponseAfterCommit("Bridge response was lost.");
    harness.rejectNextSkillResponseAfterCommit("Bridge response was lost again.");
    harness.dropSkillFile(file);
    await harness.acceptAppConfirmation();

    await waitForCondition(
      () => harness.calls.filter((call) => call.path === "/skills").length === 3,
      "Expected the unconfirmed replacement to make one reconciled retry.",
    );
    await harness.settle();

    assert.equal(
      harness.calls.filter((call) => call.path === "/skills").length,
      3,
    );
    assert.equal(
      harness.calls.filter((call) => call.path === "/state").length,
      1,
    );
    assert.equal(
      harness.document.querySelector<HTMLButtonElement>("#sendButton")?.disabled,
      true,
    );
    assert.equal(
      harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.disabled,
      true,
    );
    assert.match(
      harness.document.querySelector("#status")?.textContent ?? "",
      /Skill result is unconfirmed/i,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a committed Skill delete with truncated JSON reconciles before an idempotent retry", async () => {
  const state = stateFixture();
  state.availableSkills = [{
    id: "mix-review",
    description: "Review balance",
    source: "user",
  }];
  const harness = await createDialogHarness(state);
  try {
    harness.truncateNextSkillResponseAfterCommit();
    const deleteButton = harness.document.querySelector<HTMLButtonElement>(
      "#userSkillLibraryList [data-skill-id='mix-review'] .skill-delete",
    );
    assert.equal(deleteButton?.disabled, false);
    deleteButton?.click();
    await harness.acceptAppConfirmation();

    await waitForCondition(
      () => harness.calls.filter(
        (call) => call.path === "/skills/mix-review",
      ).length === 2,
      "Expected the truncated delete response to cross state reconciliation before retrying.",
    );
    await harness.settle();

    assert.deepEqual(
      harness.calls.filter((call) => call.path !== "/session-tools").map((call) => call.path),
      ["/skills/mix-review", "/state", "/skills/mix-review"],
    );
    const deletes = harness.calls.filter(
      (call) => call.path === "/skills/mix-review",
    );
    const firstId = (deletes[0]?.headers as Record<string, string>)[
      "X-Live-Smith-Command-Id"
    ];
    const retryId = (deletes[1]?.headers as Record<string, string>)[
      "X-Live-Smith-Command-Id"
    ];
    assert.match(firstId ?? "", /^[A-Za-z0-9._:-]+$/);
    assert.match(retryId ?? "", /^[A-Za-z0-9._:-]+$/);
    assert.notEqual(retryId, firstId);
    assert.equal(
      harness.document.querySelector("[data-skill-id='mix-review']"),
      null,
    );
    assert.equal(
      harness.document.querySelector<HTMLButtonElement>("#sendButton")?.disabled,
      false,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("a response-lost legacy override delete stays idempotent after its built-in becomes active", async () => {
  const skillId = "arranging-section-energy";
  const state = stateFixture();
  state.availableSkills = availableSkillSummaries([{
    id: skillId,
    description: "Legacy user guidance",
  }]);
  const harness = await createDialogHarness(state);
  try {
    harness.truncateNextSkillResponseAfterCommit();
    harness.holdNextState();
    assert.equal(
      harness.document.querySelector(
        `#builtInSkillList [data-skill-id='${skillId}']`,
      ),
      null,
    );
    const deleteButton = harness.document.querySelector<HTMLButtonElement>(
      `#userSkillLibraryList [data-skill-id='${skillId}'] .skill-delete`,
    );
    assert.equal(
      deleteButton?.closest<HTMLElement>(".skill-row")?.dataset.skillSource,
      "user",
    );
    deleteButton?.focus();
    deleteButton?.click();
    await harness.acceptAppConfirmation();
    await waitForCondition(
      () => harness.calls.some((call) => call.path === "/state"),
      "Expected the response-lost override deletion to refresh state.",
    );

    const peerState = stateFixture();
    peerState.sessions[0]!.activeSkillIds = [skillId];
    peerState.activeSkillIds = [skillId];
    harness.setServerState(peerState);
    harness.releaseHeldState();
    await waitForCondition(
      () => harness.calls.filter(
        (call) => call.path === `/skills/${skillId}`,
      ).length === 2,
      "Expected an idempotent delete retry after the built-in became active.",
    );
    await harness.settle();

    assert.deepEqual(
      harness.calls.filter((call) => call.path !== "/session-tools").map((call) => call.path),
      [`/skills/${skillId}`, "/state", `/skills/${skillId}`],
    );
    const builtInRow = harness.document.querySelector<HTMLElement>(
      `#skillManager [data-skill-id='${skillId}']`,
    );
    assert.equal(builtInRow?.dataset.skillSource, "built-in");
    assert.equal(
      builtInRow?.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked,
      true,
    );
    assert.equal(builtInRow?.querySelector(".skill-delete"), null);
    assert.equal(
      harness.document.activeElement,
      harness.document.querySelector("#skillLibrary .skill-paste > summary"),
    );
    assert.match(
      harness.document.querySelector("#status")?.textContent ?? "",
      /User Skill arranging-section-energy deleted.*built-in Skill is available again/i,
    );
    assert.equal(
      harness.document.querySelector<HTMLButtonElement>("#sendButton")?.disabled,
      false,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("Skill autocomplete is accessible and skips numeric IDs and Markdown code", async () => {
  const state = stateFixture();
  state.availableSkills = [
    { id: "mix-review", description: "Review balance", source: "user" },
    { id: "midi-editor", description: "Edit notes", source: "user" },
    { id: "4-on-floor", description: "Numeric ID", source: "user" },
  ];
  const harness = await createDialogHarness(state);
  try {
    const prompt = harness.document.querySelector<HTMLTextAreaElement>("#prompt");
    const listbox = harness.document.querySelector<HTMLElement>("#composerAutocomplete");
    assert.ok(prompt && listbox);
    prompt.focus();
    harness.input("#prompt", "$mi");
    assert.equal(listbox.hidden, false);
    assert.equal(prompt.getAttribute("aria-expanded"), "true");
    assert.deepEqual(
      [...listbox.querySelectorAll("[role='option'] strong")]
        .map((option) => option.textContent),
      ["$midi-editor", "$mix-review"],
    );
    prompt.dispatchEvent(new harness.window.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Enter",
    }));
    assert.equal(prompt.value, "$midi-editor ");
    assert.equal(listbox.hidden, true);

    for (const value of [
      "$4",
      "`$mix`",
      "```\n$mix\n```",
      "~~~\n$mix\n~~~",
      "mail $mix@example.com",
      "path $mix/review",
    ]) {
      harness.input("#prompt", value);
      assert.equal(listbox.hidden, true, `Expected no suggestion for ${value}`);
    }

    prompt.value = "$mix-review@example.com";
    prompt.setSelectionRange("$mix-review".length, "$mix-review".length);
    prompt.dispatchEvent(new harness.window.Event("input", { bubbles: true }));
    assert.equal(listbox.hidden, true);

    harness.input("#prompt", "` unmatched $mi");
    assert.equal(listbox.hidden, false);
  } finally {
    harness.close();
  }
});

test("Cmd or Ctrl Enter sends the unchanged prompt instead of accepting a Skill suggestion", async () => {
  const state = stateFixture();
  state.availableSkills = [
    { id: "midi-editor", description: "Edit notes", source: "user" },
    { id: "mix-review", description: "Review balance", source: "user" },
  ];
  const harness = await createDialogHarness(state);
  try {
    const prompt = harness.document.querySelector<HTMLTextAreaElement>("#prompt");
    const listbox = harness.document.querySelector<HTMLElement>("#composerAutocomplete");
    assert.ok(prompt && listbox);
    prompt.focus();
    harness.input("#prompt", "$mi");
    assert.equal(listbox.hidden, false);

    prompt.dispatchEvent(new harness.window.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Enter",
      metaKey: true,
    }));
    await harness.settle();

    assert.deepEqual(jsonCalls(harness, "/send"), [{
      path: "/send",
      body: { prompt: "$mi", sessionId: state.activeSessionId },
    }]);
  } finally {
    harness.close();
  }
});

test("a Skill can be disabled from archived history before deletion", async () => {
  const state = stateFixture();
  state.availableSkills = [{
    id: "history-guide",
    description: "Historical guidance",
    source: "user",
  }];
  state.archivedSessions = [{
    id: "session-archived",
    title: "Archived mix",
    projectKey: "previous-project",
    scope: { kind: "track", identity: "old-track", label: "Old Track" },
    archivedAt: "2026-08-09T00:00:00.000Z",
    activeSkillIds: ["history-guide"],
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:00.000Z",
  }];
  const harness = await createDialogHarness(state);
  let commandHeld = false;
  try {
    harness.click("#extensionsTab");
    const disable = harness.document.querySelector<HTMLButtonElement>(
      "#userSkillLibraryList [data-skill-id='history-guide'] .skill-delete",
    );
    assert.equal(disable?.textContent, "Disable");
    disable?.focus();
    harness.holdNextCommand();
    commandHeld = true;
    disable?.click();
    await harness.acceptAppConfirmation();
    await waitForCondition(
      () => commandCalls(harness).length === 1,
      "Expected the global disable command to start.",
    );
    assert.equal(harness.document.activeElement, harness.document.getElementById("skillLibrary"));
    assert.equal(harness.document.getElementById("skillLibrary")?.getAttribute("aria-busy"), "true");
    assert.equal(disable?.disabled, true);
    assert.equal(harness.document.querySelector<HTMLInputElement>("#userSkillList input")?.disabled, true);
    harness.releaseHeldCommand();
    commandHeld = false;
    await harness.settle();
    assert.deepEqual(commandCalls(harness).at(-1)?.body, {
      kind: "set_session_skills",
      sessionId: "session-archived",
      skillIds: [],
    });
    const deletion = harness.document.querySelector<HTMLButtonElement>(
      "#userSkillLibraryList [data-skill-id='history-guide'] .skill-delete",
    );
    assert.equal(deletion?.textContent, "Delete");
    assert.equal(harness.document.activeElement, deletion);
    deletion?.click();
    await harness.acceptAppConfirmation();
    await harness.settle();
    assert.ok(harness.calls.some((call) => call.path === "/skills/history-guide"));
  } finally {
    if (commandHeld) harness.releaseHeldCommand();
    harness.close();
  }
});
