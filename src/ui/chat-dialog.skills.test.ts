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

test("built-in and user Skills have separate controls and built-ins start disabled", async () => {
  const state = stateFixture();
  state.availableSkills = availableSkillSummaries([{
    id: "user-mix-notes",
    description: "Remember the user's mix process",
  }]);
  const harness = await createDialogHarness(state);
  try {
    const builtInList = harness.document.querySelector("#builtInSkillList");
    const userList = harness.document.querySelector("#userSkillList");
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
    assert.equal(userRow?.querySelector<HTMLButtonElement>(".skill-delete")?.textContent, "Delete");

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

test("Skill completion does not steal focus moved elsewhere while busy", async () => {
  const harness = await createDialogHarness(stateFixture());
  try {
    const toggle = harness.document.querySelector<HTMLInputElement>(
      '[data-skill-id="arranging-section-energy"] input[type="checkbox"]',
    );
    const close = harness.document.querySelector<HTMLButtonElement>("#closeButton");
    assert.ok(toggle && close);
    harness.holdNextCommand();
    toggle.focus();
    toggle.click();
    await waitForCondition(
      () => commandCalls(harness).length === 1,
      "Expected the held Skill command to start.",
    );
    close.focus();
    assert.equal(harness.document.activeElement, close);
    harness.releaseHeldCommand();
    await harness.settle();
    assert.equal(harness.document.activeElement, close);
  } finally {
    harness.close();
  }
});

test("keyboard users can paste Skill Markdown without a native file picker", async () => {
  const harness = await createDialogHarness(stateFixture());
  try {
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
        '[data-skill-id="pasted-skill"] input[type="checkbox"]',
      ),
    );

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
      "[data-skill-id='mix-review'] .skill-delete",
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
      "[data-skill-id='mix-review'] .skill-delete",
    );
    assert.equal(enabledDelete?.disabled, false);
    enabledDelete?.focus();
    enabledDelete?.click();
    await harness.acceptAppConfirmation();
    await harness.settle();
    assert.ok(harness.calls.some((call) => call.path === "/skills/mix-review"));
    assert.equal(
      harness.document.activeElement,
      harness.document.querySelector(".skill-paste > summary"),
    );
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

    const paths = harness.calls.map((call) => call.path);
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
      "[data-skill-id='mix-review'] .skill-delete",
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
      harness.calls.map((call) => call.path),
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
      `[data-skill-id='${skillId}'] .skill-delete`,
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
      harness.calls.map((call) => call.path),
      [`/skills/${skillId}`, "/state", `/skills/${skillId}`],
    );
    const builtInRow = harness.document.querySelector<HTMLElement>(
      `[data-skill-id='${skillId}']`,
    );
    assert.equal(builtInRow?.dataset.skillSource, "built-in");
    assert.equal(
      builtInRow?.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked,
      true,
    );
    assert.equal(builtInRow?.querySelector(".skill-delete"), null);
    assert.equal(
      harness.document.activeElement,
      builtInRow?.querySelector('input[type="checkbox"]'),
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
  try {
    const disable = harness.document.querySelector<HTMLButtonElement>(
      "[data-skill-id='history-guide'] .skill-delete",
    );
    assert.equal(disable?.textContent, "Disable");
    disable?.focus();
    disable?.click();
    await harness.acceptAppConfirmation();
    await harness.settle();
    assert.deepEqual(commandCalls(harness).at(-1)?.body, {
      kind: "set_session_skills",
      sessionId: "session-archived",
      skillIds: [],
    });
    const deletion = harness.document.querySelector<HTMLButtonElement>(
      "[data-skill-id='history-guide'] .skill-delete",
    );
    assert.equal(deletion?.textContent, "Delete");
    assert.equal(harness.document.activeElement, deletion);
    deletion?.click();
    await harness.acceptAppConfirmation();
    await harness.settle();
    assert.ok(harness.calls.some((call) => call.path === "/skills/history-guide"));
  } finally {
    harness.close();
  }
});
