import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";

import {
  availableSkillSummaries,
  builtInSkillDefinition,
} from "../skills/builtins.js";
import type { SkillDefinition } from "../skills/format.js";
import {
  composeChatDocument,
  injectBuiltInSkillDefinitions,
  type ChatClientScripts,
} from "./chat-document.js";
import { MAX_RECOVERY_ACTION_DIGESTS } from "../agent/recovery-contract.js";
import { stateFixture } from "./chat-dialog.test-harness.js";

const scripts: ChatClientScripts = {
  attachments: "",
  bootstrap: "",
  bridgeClient: "",
  composerInput: "",
  hostAdapter: "",
  markdownRenderer: "",
  profileEditor: "",
  sessionTimeline: "",
  skillManager: "",
};

test("chat document projects complete canonical built-ins only into the Skill client", () => {
  const state = stateFixture();
  state.availableSkills = availableSkillSummaries([{
    id: "arranging-section-energy",
    description: "Historical user override",
  }, {
    id: "private-user-workflow",
    description: "User workflow summary",
  }]);
  const html = composeChatDocument(
    `<script>
      window.projectedState = JSON.parse(__STATE__);
      __PROFILE_EDITOR_SCRIPT__
      __SKILL_MANAGER_SCRIPT__
    </script>`,
    state,
    { baseUrl: "http://127.0.0.1:12345", token: "test-token" },
    {
      ...scripts,
      profileEditor: 'window.otherClientToken = "__BUILT_IN_SKILL_DEFINITIONS__";',
      skillManager: "window.skillDefinitions = __BUILT_IN_SKILL_DEFINITIONS__;",
    },
  );
  const dom = new JSDOM(html, { runScripts: "dangerously" });
  try {
    const expected = availableSkillSummaries([]).map(({ id }) =>
      builtInSkillDefinition(id)
    );
    assert.deepEqual(
      JSON.parse(JSON.stringify(Reflect.get(dom.window, "skillDefinitions"))),
      expected,
    );
    assert.equal(
      Reflect.get(dom.window, "otherClientToken"),
      "__BUILT_IN_SKILL_DEFINITIONS__",
    );
    const projectedState = Reflect.get(dom.window, "projectedState");
    assert.deepEqual(
      JSON.parse(JSON.stringify(projectedState)),
      state,
    );
  } finally {
    dom.window.close();
  }
});

test("built-in definition injection preserves Markdown while escaping the script boundary", () => {
  const definitions: SkillDefinition[] = [{
    id: "script-boundary-skill",
    description: "Literal <>&\u2028\u2029 description",
    body: [
      "# Complete body",
      "</script><script>window.skillScriptExecuted = true;</script>",
      "Literal <>&\u2028\u2029 and replacement tokens $& $' $` $$ ${unchanged}",
      "__MAX_ACTIVE_SKILL_COUNT__ stays unchanged in the body.",
      "",
    ].join("\n"),
  }];
  const script = injectBuiltInSkillDefinitions(
    "window.skillDefinitions = __BUILT_IN_SKILL_DEFINITIONS__;",
    definitions,
  );
  assert.doesNotMatch(script, /[<>&\u2028\u2029]/u);
  const dom = new JSDOM(`<script>${script}</script>`, {
    runScripts: "dangerously",
  });
  try {
    assert.equal(Reflect.get(dom.window, "skillScriptExecuted"), undefined);
    assert.deepEqual(
      JSON.parse(JSON.stringify(Reflect.get(dom.window, "skillDefinitions"))),
      definitions,
    );
    assert.equal(dom.window.document.querySelectorAll("script").length, 1);
  } finally {
    dom.window.close();
  }
});

test("chat document injects the canonical recovery ledger bound", () => {
  const html = composeChatDocument(
    "<script>__BRIDGE_CLIENT_SCRIPT__</script>",
    stateFixture(),
    { baseUrl: "http://127.0.0.1:12345", token: "test-token" },
    {
      ...scripts,
      bridgeClient:
        "window.recoveryDigestLimit = __MAX_RECOVERY_ACTION_DIGESTS__;",
    },
  );
  const dom = new JSDOM(html, { runScripts: "dangerously" });
  try {
    assert.equal(
      Reflect.get(dom.window, "recoveryDigestLimit"),
      MAX_RECOVERY_ACTION_DIGESTS,
    );
  } finally {
    dom.window.close();
  }
});
