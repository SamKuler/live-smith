import assert from "node:assert/strict";
import test from "node:test";

import {
  availableSkillSummaries,
  builtInSkillDefinition,
} from "../skills/builtins.js";
import {
  createDialogHarness,
  stateFixture,
  waitForCondition,
} from "./chat-dialog.test-harness.js";

const skillId = "arranging-section-energy";
const viewSelector = `[data-skill-id="${skillId}"] .skill-view`;
type Harness = Awaited<ReturnType<typeof createDialogHarness>>;

function readerElements(harness: Harness) {
  const manager = harness.document.querySelector<HTMLElement>("#skillManager");
  const viewer = harness.document.querySelector<HTMLElement>("#skillViewer");
  const back = harness.document.querySelector<HTMLButtonElement>("#closeSkillViewer");
  const body = harness.document.querySelector<HTMLElement>("#skillViewerBody");
  assert.ok(manager && viewer && back && body);
  return { manager, viewer, back, body };
}

test("Skills keeps one compact Session-level help affordance", async () => {
  const harness = await createDialogHarness();
  try {
    harness.click("#agentTab");
    const heading = harness.document.getElementById("skillsHeading");
    const help = heading?.parentElement?.querySelector<HTMLElement>(".inline-help");
    assert.ok(help);
    assert.equal(heading?.nextElementSibling, help);
    assert.equal(help.textContent, "?");
    assert.equal(help.getAttribute("role"), "note");
    assert.equal(help.getAttribute("tabindex"), "0");
    assert.equal(
      help.dataset.tooltip,
      "Enable for this Session, or use $skill-id for one turn.",
    );
    assert.equal(help.getAttribute("aria-label"), help.dataset.tooltip);
    assert.equal(
      harness.document.getElementById("builtInSkillsHeading")?.parentElement
        ?.querySelector(".inline-help"),
      null,
    );
    assert.equal(heading?.closest(".inspector-scope-header") !== null, true);
    assert.equal(harness.document.getElementById("builtInSkillsHeading")?.tagName, "H3");
    assert.equal(harness.document.getElementById("userSkillsHeading")?.tagName, "H3");
    assert.equal(
      harness.document.querySelector(".skill-paste > summary")?.textContent,
      "Import Skill",
    );
    assert.equal(
      harness.document.querySelector("#skillDropZone strong")?.textContent,
      "Drop SKILL.md",
    );
    assert.equal(harness.document.querySelector("#skillDropZone span"), null);
    assert.equal(
      harness.document.querySelector('label[for="skillPasteText"]')?.textContent,
      "Paste SKILL.md",
    );
    assert.equal(harness.document.querySelectorAll("#skillManager p.skill-note").length, 0);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("every built-in opens its full canonical Markdown without enabling it or calling the bridge", async () => {
  const harness = await createDialogHarness();
  try {
    harness.click("#agentTab");
    harness.input("#prompt", "Keep this draft");
    const { manager, viewer, back, body } = readerElements(harness);
    assert.equal(viewer.hidden, true);
    const renderer = harness.window.LiveSmithMarkdown;
    assert.ok(renderer);
    const renderInto = renderer.renderInto;
    const rendered: string[] = [];
    renderer.renderInto = (target: HTMLElement, source: string) => {
      if (target === body) rendered.push(source);
      renderInto(target, source);
    };
    const callsBefore = harness.calls.length;
    for (const skill of availableSkillSummaries([])) {
      const row = harness.document.querySelector(`[data-skill-id="${skill.id}"]`);
      const view = row?.querySelector<HTMLButtonElement>(".skill-view");
      const toggle = row?.querySelector<HTMLInputElement>('input[type="checkbox"]');
      const definition = builtInSkillDefinition(skill.id);
      assert.ok(view && toggle && definition);
      assert.equal(view.closest("label"), null);
      assert.equal(view.getAttribute("aria-label"), `View Skill ${skill.id}`);
      view.focus();
      view.click();

      assert.equal(manager.hidden, true);
      assert.equal(viewer.hidden, false);
      assert.equal(harness.document.activeElement, back);
      assert.equal(harness.document.querySelector("#skillViewerId")?.textContent, skill.id);
      assert.equal(
        harness.document.querySelector("#skillViewerDescription")?.textContent,
        definition.description,
      );
      assert.equal(rendered.at(-1), definition.body);
      assert.ok(body.querySelector("h1"));
      assert.ok(body.querySelector("li"));
      assert.equal(toggle.checked, false);
      back.click();
      assert.equal(viewer.hidden, true);
      assert.equal(manager.hidden, false);
      assert.equal(harness.document.activeElement, view);
    }
    await harness.settle();
    assert.equal(harness.calls.length, callsBefore);
    assert.equal(harness.document.querySelector<HTMLTextAreaElement>("#prompt")?.value, "Keep this draft");
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("Escape returns from Skill details to its View button", async () => {
  const harness = await createDialogHarness();
  try {
    harness.click("#agentTab");
    harness.click(viewSelector);
    const { viewer, back } = readerElements(harness);
    const escape = new harness.window.KeyboardEvent("keydown", {
      key: "Escape", bubbles: true, cancelable: true,
    });
    back.dispatchEvent(escape);
    assert.equal(escape.defaultPrevented, true);
    assert.equal(viewer.hidden, true);
    assert.equal(harness.document.activeElement, harness.document.querySelector(viewSelector));
    assert.equal(harness.document.querySelector<HTMLElement>("#agentPanel")?.hidden, false);
  } finally {
    harness.close();
  }
});

test("Skill details remain mounted across Session changes and busy operations", async () => {
  const state = stateFixture();
  state.sessions[1]!.activeSkillIds = [skillId];
  const harness = await createDialogHarness(state);
  let sendHeld = false;
  try {
    harness.click("#agentTab");
    harness.click(viewSelector);
    const { viewer, back, body } = readerElements(harness);
    const content = body.firstChild;
    const panel = harness.document.querySelector<HTMLElement>("#agentPanel");
    assert.ok(panel);
    panel.scrollTop = 120;
    await harness.window.LiveSmithUI.runCommand("select_session", { sessionId: "session-2" });
    assert.equal(viewer.hidden, false);
    assert.equal(body.firstChild, content);
    assert.equal(panel.scrollTop, 120);
    assert.equal(harness.document.activeElement, back);

    harness.holdNextSend();
    sendHeld = true;
    harness.input("#prompt", "Start a response");
    harness.click("#sendButton");
    await waitForCondition(() => harness.sendIds.length === 1, "Expected a held send.");
    assert.equal(back.disabled, false);
    assert.equal(body.firstChild, content);
    back.click();
    const view = harness.document.querySelector<HTMLButtonElement>(viewSelector);
    const toggle = harness.document.querySelector<HTMLInputElement>(
      `[data-skill-id="${skillId}"] input[type="checkbox"]`,
    );
    assert.equal(toggle?.checked, true);
    assert.equal(toggle?.disabled, true);
    assert.equal(view?.disabled, false);
    assert.equal(harness.document.activeElement, view);
    view?.click();
    assert.equal(viewer.hidden, false);
    assert.equal(harness.document.activeElement, back);
    harness.releaseHeldSend();
    sendHeld = false;
    await harness.settle();
    assert.equal(viewer.hidden, false);
    assert.equal(harness.document.activeElement, back);
    assert.deepEqual(harness.errors, []);
  } finally {
    if (sendHeld) harness.releaseHeldSend();
    await harness.settle();
    harness.close();
  }
});

test("read-only Skill controls keep focus while a pending operation completes", async () => {
  const harness = await createDialogHarness();
  let commandHeld = false;
  try {
    harness.click("#agentTab");
    const view = harness.document.querySelector<HTMLButtonElement>(viewSelector);
    assert.ok(view);
    view.focus();
    harness.holdNextCommand();
    commandHeld = true;
    const pending = harness.window.LiveSmithUI.runCommand("select_session", { sessionId: "session-2" });
    assert.equal(view.disabled, false);
    assert.equal(harness.document.activeElement, view);
    harness.releaseHeldCommand();
    commandHeld = false;
    await pending;
    assert.equal(harness.document.activeElement, view);
  } finally {
    if (commandHeld) harness.releaseHeldCommand();
    await harness.settle();
    harness.close();
  }
});

test("Skill details close when the available entry disappears or becomes a User Skill", async () => {
  for (const replacement of ["removed", "user"] as const) {
    for (const moveFocusAway of [false, true]) {
      const harness = await createDialogHarness();
      try {
        harness.click("#agentTab");
        harness.click(viewSelector);
        const { viewer, body } = readerElements(harness);
        const prompt = harness.document.querySelector<HTMLTextAreaElement>("#prompt");
        if (moveFocusAway) prompt?.focus();
        const next = stateFixture();
        next.availableSkills = replacement === "removed"
          ? next.availableSkills.filter((skill) => skill.id !== skillId)
          : availableSkillSummaries([{ id: skillId, description: "Legacy user guidance" }]);
        harness.setServerState(next);
        await harness.window.LiveSmithUI.runCommand("select_session", { sessionId: "session-1" });
        assert.equal(viewer.hidden, true);
        assert.equal(body.textContent, "");
        assert.equal(harness.document.querySelector(viewSelector), null);
        assert.equal(harness.document.querySelector("#userSkillList .skill-view"), null);
        if (moveFocusAway) {
          assert.equal(harness.document.activeElement, prompt);
        } else {
          assert.equal(viewer.contains(harness.document.activeElement), false);
          assert.notEqual(harness.document.activeElement, harness.document.body);
        }
        assert.deepEqual(harness.errors, []);
      } finally {
        harness.close();
      }
    }
  }
});

test("Skill Markdown falls back to readable text if the renderer fails", async () => {
  const harness = await createDialogHarness();
  try {
    harness.click("#agentTab");
    const renderer = harness.window.LiveSmithMarkdown;
    assert.ok(renderer);
    renderer.renderInto = () => { throw new Error("Renderer unavailable"); };
    harness.click(viewSelector);
    const { viewer, body } = readerElements(harness);
    assert.equal(viewer.hidden, false);
    assert.equal(body.textContent, builtInSkillDefinition(skillId)?.body);
    assert.equal(body.children.length, 0);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});
