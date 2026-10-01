import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { strToU8, zipSync } from "fflate/browser";

import {
  commandCalls,
  createDialogHarness,
  stateFixture,
  waitForCondition,
} from "./support/chat-dialog.test-harness.js";

function pluginArchive(description = "Convert audio into MIDI"): Uint8Array {
  return zipSync({
    "plugin.json": strToU8(JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "music-tools",
      version: "1.2.0",
      description,
    })),
    "mcp.json": strToU8(JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: {
        converter: { type: "stdio", command: "./bin/converter" },
        catalog: {
          type: "streamable-http",
          url: "https://plugins.example.test/private/catalog?token=hidden",
        },
        legacy: { type: "sse", url: "https://legacy.example.test/sse" },
      },
    })),
    "skills/convert/SKILL.md": strToU8(
      "---\nname: convert\ndescription: Convert Session audio to MIDI\n---\nUse the converter tool.\n",
    ),
    "bin/converter": strToU8("#!/bin/sh\n"),
    "hooks/hooks.json": strToU8(JSON.stringify({ hooks: {} })),
  });
}

function pluginFile(
  harness: Awaited<ReturnType<typeof createDialogHarness>>,
  bytes = pluginArchive(),
): File {
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  return new harness.window.File([owned.buffer], "music-tools.zip", {
    type: "application/zip",
  });
}

async function waitForPluginIdle(
  harness: Awaited<ReturnType<typeof createDialogHarness>>,
): Promise<void> {
  await waitForCondition(
    () => harness.document.querySelector("#pluginManager")?.getAttribute("aria-busy") === "false",
    "Expected the Plugin operation to finish.",
  );
  await harness.settle();
}

function installedPlugin(enabled = false) {
  return {
    id: "music-tools",
    sha256: "a".repeat(64),
    version: "1.2.0",
    description: "Convert audio into MIDI",
    sourceFormat: "agent-plugins-1.0" as const,
    enabled,
    skillCount: 1,
    skills: [{ id: "music-tools:convert", description: "Convert Session audio to MIDI" }],
    mcpServers: [
      {
        id: "converter",
        type: "stdio" as const,
        approved: false,
        artifactInputApproved: false,
        artifactOutputApproved: false,
        target: "./bin/converter",
        args: [],
        envNames: [],
        credentialFields: [],
      },
      {
        id: "catalog",
        type: "streamable-http" as const,
        approved: false,
        artifactInputApproved: false,
        artifactOutputApproved: false,
        target: "https://plugins.example.test",
        credentialFields: [],
      },
    ],
    unsupportedComponents: ["hooks"],
    issues: ["unsupported_mcp_transport" as const],
  };
}

test("Plugin cards link to capabilities while MCP sources retain declared servers and launch details", async () => {
  const state = stateFixture();
  state.plugins = [installedPlugin()];
  const harness = await createDialogHarness(state);
  try {
    const card = harness.document.querySelector<HTMLElement>('#installedPlugin-music-tools');
    const mcpSource = harness.document.querySelector<HTMLElement>('#pluginMcpSource-music-tools');
    assert.ok(card);
    assert.ok(mcpSource);
    assert.match(card.textContent ?? "", /1\.2\.0.*Agent Plugin/s);
    assert.match(card.querySelector(".plugin-capability-links")?.textContent ?? "", /Skills · 1.*MCP servers · 2/s);
    assert.equal(card.querySelector(".plugin-server-row"), null);
    assert.equal(card.querySelector(".plugin-server-approval"), null);
    assert.match(mcpSource.textContent ?? "", /music-tools.*Disabled/s);
    assert.match(mcpSource.textContent ?? "", /converter.*Local process.*\.\/bin\/converter/s);
    assert.match(mcpSource.textContent ?? "", /catalog.*Remote MCP.*https:\/\/plugins\.example\.test/s);
    assert.equal(mcpSource.querySelectorAll(".plugin-connection-unbound").length, 2);
    assert.equal(mcpSource.querySelectorAll(".plugin-manage-connections").length, 0);
    assert.match(card.textContent ?? "", /Not used by Live Smith: hooks/);
    assert.doesNotMatch(card.textContent ?? "", /private\/catalog|token=hidden/u);
    assert.equal(card.querySelector<HTMLButtonElement>(".danger-action")?.disabled, false);
    assert.equal(harness.document.querySelector<HTMLElement>("#pluginDropZone")?.hidden, true);
    const details = mcpSource.querySelector<HTMLDetailsElement>('.plugin-server-details[data-server-id="converter"]');
    assert.equal(details?.open, false);
    harness.click('.plugin-server-details[data-server-id="converter"] > summary');
    assert.equal(details?.open, true);
    assert.match(details?.textContent ?? "", /Command.*\.\/bin\/converter.*Arguments.*Working directory/s);
    assert.equal(commandCalls(harness).length, 0, "reading launch details does not grant permission or start a server");
    harness.select("#uiLanguage", "zh-CN");
    await harness.settle();
    assert.equal(harness.document.querySelector<HTMLDetailsElement>('.plugin-server-details[data-server-id="converter"]')?.open, true);
    assert.equal(harness.document.querySelector('.plugin-server-details[data-server-id="converter"] > summary')?.textContent, "启动详情");
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("Plugin capability links open their source page and return to the installed package", async () => {
  const state = stateFixture();
  state.plugins = [installedPlugin(false)];
  const harness = await createDialogHarness(state);
  try {
    harness.click("#extensionsTab");
    harness.click("#pluginsExtensionTab");
    harness.click("#installedPlugin-music-tools .plugin-open-mcp");
    assert.equal(harness.document.querySelector<HTMLElement>("#mcpSettings")?.hidden, false);
    assert.equal(harness.document.querySelector<HTMLElement>("#pluginManager")?.hidden, true);
    assert.equal(harness.document.activeElement?.id, "pluginMcpSource-music-tools");
    harness.click("#pluginMcpSource-music-tools .plugin-source-link");
    assert.equal(harness.document.querySelector<HTMLElement>("#pluginManager")?.hidden, false);
    assert.equal(harness.document.activeElement?.id, "installedPlugin-music-tools");
    harness.click("#installedPlugin-music-tools .plugin-open-skills");
    assert.equal(harness.document.querySelector<HTMLElement>("#skillLibrary")?.hidden, false);
    assert.equal(harness.document.activeElement?.id, "pluginSkillSource-music-tools");
    harness.click("#builtInSkillLibraryList .skill-view");
    assert.equal(harness.document.querySelector<HTMLElement>("#skillLibraryContent")?.hidden, true);
    harness.click("#pluginsExtensionTab");
    harness.click("#installedPlugin-music-tools .plugin-open-skills");
    assert.equal(harness.document.querySelector<HTMLElement>("#skillLibraryContent")?.hidden, false);
    assert.equal(harness.document.querySelector<HTMLElement>("#skillViewer")?.hidden, true);
    assert.equal(harness.document.activeElement?.id, "pluginSkillSource-music-tools");
    harness.click("#pluginSkillSource-music-tools .skill-plugin-link");
    assert.equal(harness.document.querySelector<HTMLElement>("#pluginManager")?.hidden, false);
    assert.equal(harness.document.activeElement?.id, "installedPlugin-music-tools");
    assert.deepEqual(commandCalls(harness), []);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("MCP server permission focus returns to the same control after the state update", async () => {
  const state = stateFixture();
  const plugin = installedPlugin(true);
  plugin.mcpServers[0]!.approved = true;
  state.plugins = [plugin];
  const harness = await createDialogHarness(state);
  let commandHeld = false;
  try {
    harness.click("#extensionsTab");
    harness.click("#mcpExtensionTab");
    const selector = '#pluginMcpSource-music-tools .plugin-server-group[data-server-id="converter"] .plugin-server-approval';
    const approval = harness.document.querySelector<HTMLButtonElement>(selector);
    assert.ok(approval);
    approval.focus();
    harness.holdNextCommand();
    commandHeld = true;
    approval.click();
    await waitForCondition(() => commandCalls(harness).length === 1, "Expected a revoke command.");
    assert.equal(harness.document.activeElement?.id, "pluginMcpSource-music-tools");
    harness.releaseHeldCommand();
    commandHeld = false;
    await harness.settle();
    assert.equal(harness.document.activeElement, harness.document.querySelector(selector));
    assert.equal(harness.document.querySelector(selector)?.textContent, "Approve");
    assert.deepEqual(harness.errors, []);
  } finally {
    if (commandHeld) harness.releaseHeldCommand();
    harness.close();
  }
});

test("Plugin Skill summary wire data rejects private fields and inconsistent contents", async () => {
  const state = stateFixture();
  state.plugins = [installedPlugin(false)];
  const harness = await createDialogHarness(state);
  let sendHeld = false;
  try {
    harness.holdNextSend();
    sendHeld = true;
    harness.input("#prompt", "Read the current Session");
    harness.click("#sendButton");
    await waitForCondition(() => harness.sendIds.length === 1, "Expected a held send.");
    const summary = state.plugins[0]!.skills![0]!;
    const invalidContents = [
      { skills: [{ ...summary, body: "private-body" }] },
      { skills: [{ ...summary, id: "another-plugin:convert" }] },
      { skills: [{ ...summary, id: "music-tools:" + "a".repeat(65) }] },
      { skills: [{ ...summary, description: "a".repeat(241) }] },
      { skills: [{ ...summary, description: " " }] },
      { skills: [] },
      { skillCount: 2, skills: [summary, summary] },
      { skillCount: 2049, skills: Array.from({ length: 2049 }, (_, index) => ({ ...summary, id: `music-tools:skill-${index}` })) },
    ];
    for (const contents of invalidContents) {
      harness.emitServerEvent({
        type: "done", sendId: harness.sendIds[0], sessionId: state.activeSessionId,
        state: { ...state, plugins: [{ ...state.plugins[0], description: "Rejected package state", ...contents }] },
      });
      await harness.settle();
      assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Stop");
      assert.doesNotMatch(harness.document.querySelector("#installedPlugin-music-tools")?.textContent ?? "", /Rejected package state/u);
    }
    harness.emitServerEvent({
      type: "done", sendId: harness.sendIds[0], sessionId: state.activeSessionId,
      state: { ...state, plugins: [{ ...state.plugins[0], description: "Accepted package state" }] },
    });
    await harness.settle();
    assert.equal(harness.document.querySelector("#sendButton")?.textContent, "Send");
    assert.match(harness.document.querySelector("#installedPlugin-music-tools")?.textContent ?? "", /Accepted package state/u);
    harness.releaseHeldSend();
    sendHeld = false;
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally {
    if (sendHeld) harness.releaseHeldSend();
    harness.close();
  }
});

test("the empty Plugin section retains ZIP drop while blocked deletion explains its reason", async () => {
  const empty = await createDialogHarness(stateFixture());
  try {
    assert.equal(empty.document.querySelector<HTMLElement>("#pluginDropZone")?.hidden, false);
  } finally { empty.close(); }
  const state = stateFixture();
  state.plugins = [installedPlugin(true)];
  const harness = await createDialogHarness(state);
  try {
    const actions = harness.document.querySelector(".plugin-card-actions");
    assert.equal(actions?.querySelector<HTMLButtonElement>("button")?.disabled, true);
    assert.match(actions?.textContent ?? "", /Disable this Plugin before deleting it/u);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("an installed Plugin still accepts ZIP replacement drops without a persistent drop zone", async () => {
  const state = stateFixture();
  state.plugins = [installedPlugin(false)];
  const harness = await createDialogHarness(state);
  try {
    assert.equal(harness.document.querySelector<HTMLElement>("#pluginDropZone")?.hidden, true);
    const event = new harness.window.Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: { files: [pluginFile(harness)], types: ["Files"] } });
    harness.document.querySelector('#installedPlugin-music-tools')?.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
    await waitForCondition(() => harness.calls.some((call) => call.path === "/plugins/inspect"),
      "Expected a replacement ZIP to be inspected.");
    await waitForCondition(() => harness.document.querySelector<HTMLElement>("#appConfirmation")?.hidden === false,
      "Expected a replacement review.");
    await harness.cancelAppConfirmation();
    await harness.settle();
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("Plugin permission errors are announced inside the Inspector", async () => {
  const state = stateFixture();
  state.plugins = [installedPlugin(false)];
  const harness = await createDialogHarness(state);
  try {
    harness.failNextCommand("Unable to approve this server", "plugins");
    harness.click('[data-plugin-id="music-tools"] .plugin-server-approval');
    await harness.acceptAppConfirmation();
    await harness.settle();
    assert.match(harness.document.querySelector("#pluginMcpStatus")?.textContent ?? "", /Unable to approve this server/u);
    assert.doesNotMatch(harness.document.querySelector("#pluginStatus")?.textContent ?? "", /Unable to approve this server/u);
    assert.equal(harness.document.querySelector("#pluginMcpStatus")?.getAttribute("role"), "status");
    assert.doesNotMatch(harness.document.querySelector("#status")?.textContent ?? "", /Unable to approve this server/u);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("Plugin enable, disable, server approval, and deletion use explicit commands", async () => {
  const state = stateFixture();
  state.plugins = [installedPlugin(false)];
  state.availableSkills = [{
    id: "music-tools:convert",
    description: "Convert Session audio to MIDI",
    source: "plugin",
    pluginId: "music-tools",
  }];
  const harness = await createDialogHarness(state);
  try {
    harness.click('[data-plugin-id="music-tools"] .plugin-enabled-toggle input');
    await harness.settle();
    assert.deepEqual(commandCalls(harness).at(-1)?.body, {
      kind: "set_plugin_enabled",
      pluginId: "music-tools",
      enabled: true,
    });

    const localApprove = harness.document.querySelector<HTMLButtonElement>(
      '[data-plugin-id="music-tools"] .plugin-server-row:first-child .plugin-server-approval',
    );
    assert.ok(localApprove);
    localApprove.click();
    await waitForCondition(
      () => harness.document.querySelector<HTMLElement>("#appConfirmation")?.hidden === false,
      "Expected local process permission confirmation.",
    );
    assert.match(
      harness.document.querySelector("#appConfirmationMessage")?.textContent ?? "",
      /operating-system user.*not sandboxed/i,
    );
    assert.equal(commandCalls(harness).filter((call) =>
      (call.body as { kind?: string }).kind === "set_plugin_mcp_server_approved").length, 0);
    await harness.acceptAppConfirmation();
    await waitForPluginIdle(harness);
    assert.deepEqual(commandCalls(harness).at(-1)?.body, {
      kind: "set_plugin_mcp_server_approved",
      pluginId: "music-tools",
      serverId: "converter",
      approved: true,
    });

    const artifactPermissions = () => [...harness.document.querySelectorAll<HTMLButtonElement>(
      '[data-plugin-id="music-tools"] .plugin-server-row:first-child .plugin-artifact-permission',
    )];
    assert.equal(artifactPermissions().length, 2);
    artifactPermissions()[0]!.click();
    await waitForCondition(
      () => harness.document.querySelector<HTMLElement>("#appConfirmation")?.hidden === false,
      "Expected artifact input confirmation.",
    );
    assert.match(harness.document.querySelector("#appConfirmationMessage")?.textContent ?? "", /read-only temporary copies.*not sandboxed/is);
    await harness.acceptAppConfirmation();
    await waitForPluginIdle(harness);
    assert.deepEqual(commandCalls(harness).at(-1)?.body, {
      kind: "set_plugin_artifact_permission",
      pluginId: "music-tools",
      serverId: "converter",
      permission: "input",
      approved: true,
    });
    artifactPermissions()[1]!.click();
    await harness.acceptAppConfirmation();
    await waitForPluginIdle(harness);
    assert.deepEqual(commandCalls(harness).at(-1)?.body, {
      kind: "set_plugin_artifact_permission",
      pluginId: "music-tools",
      serverId: "converter",
      permission: "output",
      approved: true,
    });
    assert.ok(artifactPermissions().every((button) => button.getAttribute("aria-pressed") === "true"));

    harness.click('[data-plugin-id="music-tools"] .plugin-enabled-toggle input');
    await harness.acceptAppConfirmation();
    await waitForPluginIdle(harness);
    assert.deepEqual(commandCalls(harness).at(-1)?.body, {
      kind: "set_plugin_enabled",
      pluginId: "music-tools",
      enabled: false,
    });
    assert.equal(
      harness.document.querySelector('#pluginSkillList [data-skill-id="music-tools:convert"]'),
      null,
    );
    assert.match(harness.document.querySelector('#pluginSkillSource-music-tools')?.textContent ?? "", /Disabled.*music-tools:convert/s);

    harness.click('[data-plugin-id="music-tools"] .danger-action');
    await harness.acceptAppConfirmation();
    await waitForPluginIdle(harness);
    assert.deepEqual(commandCalls(harness).at(-1)?.body, {
      kind: "delete_plugin",
      pluginId: "music-tools",
    });
    assert.equal(harness.document.querySelector('[data-plugin-id="music-tools"]'), null);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("Plugin ZIP is inspected and reviewed before installation writes anything", async () => {
  const state = stateFixture();
  const bytes = pluginArchive();
  const digest = createHash("sha256").update(bytes).digest("hex");
  const harness = await createDialogHarness(state);
  try {
    assert.equal(harness.dropPluginFile(pluginFile(harness, bytes)), true);
    await waitForCondition(
      () => harness.calls.some((call) => call.path === "/plugins/inspect"),
      "Expected Plugin inspection request.",
    );
    await waitForCondition(
      () => harness.document.querySelector<HTMLElement>("#appConfirmation")?.hidden === false,
      "Expected Plugin install review.",
    );
    assert.equal(harness.calls.some((call) => call.path === "/plugins"), false);
    const review = harness.document.querySelector("#appConfirmationMessage")?.textContent ?? "";
    assert.match(review, /Install music-tools 1\.2\.0/);
    assert.match(review, new RegExp(digest));
    assert.match(review, /converter.*\.\/bin\/converter/s);
    assert.match(review, /catalog.*https:\/\/plugins\.example\.test/s);
    assert.match(review, /not enable the Plugin, approve any MCP server, or grant artifact access/i);
    assert.match(review, /Not used by Live Smith: hooks/);
    assert.doesNotMatch(review, /private\/catalog|token=hidden/u);

    await harness.acceptAppConfirmation();
    await waitForCondition(
      () => harness.calls.some((call) => call.path === "/plugins"),
      "Expected confirmed Plugin install request.",
    );
    await waitForPluginIdle(harness);
    const install = harness.calls.find((call) => call.path === "/plugins");
    assert.match(install?.url ?? "", /replace=false/u);
    assert.equal(new Headers(install?.headers).get("Content-Type"), "application/zip");
    assert.equal(
      harness.document.querySelector<HTMLInputElement>(
        '[data-plugin-id="music-tools"] .plugin-enabled-toggle input',
      )?.checked,
      false,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("compatible local MCP launch is visible at install and approval review without environment values", async () => {
  const bytes = zipSync({
    ".codex-plugin/plugin.json": strToU8(JSON.stringify({
      name: "launch-review", version: "1.0.0", mcpServers: "./.mcp.json",
    })),
    ".mcp.json": strToU8(JSON.stringify({ mcpServers: {
      local: { command: "/opt/tools/node", args: ["--no-warnings", "/opt/plugin/server.mjs"],
        cwd: "/opt/plugin", env: { ACCESS_TOKEN: "private-access-value", MODE: "production" } },
    } })),
  });
  const harness = await createDialogHarness(stateFixture());
  try {
    harness.dropPluginFile(pluginFile(harness, bytes));
    await waitForCondition(() => harness.document.querySelector<HTMLElement>("#appConfirmation")?.hidden === false,
      "Expected installation review.");
    const review = harness.document.querySelector("#appConfirmationMessage")?.textContent ?? "";
    for (const detail of ["/opt/tools/node", "--no-warnings", "/opt/plugin/server.mjs", "/opt/plugin", "ACCESS_TOKEN", "MODE"]) {
      assert.ok(review.includes(detail), `Install review omitted ${detail}`);
    }
    assert.doesNotMatch(review, /private-access-value/u);
    await harness.acceptAppConfirmation();
    await waitForPluginIdle(harness);
    harness.click('[data-plugin-id="launch-review"] .plugin-server-approval');
    await waitForCondition(() => harness.document.querySelector<HTMLElement>("#appConfirmation")?.hidden === false,
      "Expected process approval review.");
    const approval = harness.document.querySelector("#appConfirmationMessage")?.textContent ?? "";
    for (const detail of ["/opt/tools/node", "--no-warnings", "/opt/plugin/server.mjs", "/opt/plugin", "ACCESS_TOKEN", "MODE"]) {
      assert.ok(approval.includes(detail), `Approval review omitted ${detail}`);
    }
    assert.doesNotMatch(approval, /private-access-value/u);
    await harness.cancelAppConfirmation();
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("Plugin replacement is reviewed, disabled, and reconciled after a lost response", async () => {
  const state = stateFixture();
  state.plugins = [installedPlugin(false)];
  const bytes = pluginArchive("Updated converter");
  const harness = await createDialogHarness(state);
  try {
    harness.rejectNextPluginResponseAfterCommit("connection closed");
    harness.dropPluginFile(pluginFile(harness, bytes));
    await waitForCondition(
      () => harness.document.querySelector<HTMLElement>("#appConfirmation")?.hidden === false,
      "Expected Plugin replacement review.",
    );
    assert.equal(
      harness.document.querySelector("#appConfirmationTitle")?.textContent,
      "Replace installed Plugin?",
    );
    await harness.acceptAppConfirmation();
    await waitForCondition(
      () => harness.calls.filter((call) => call.path === "/plugins").length === 2,
      "Expected response-loss retry after authoritative state refresh.",
    );
    await waitForPluginIdle(harness);
    assert.ok(harness.calls.filter((call) => call.path === "/plugins")
      .every((call) => /replace=true/u.test(call.url)));
    assert.equal(harness.document.querySelectorAll('#pluginList [data-plugin-id="music-tools"]').length, 1);
    assert.equal(
      harness.document.querySelector<HTMLInputElement>(
        '[data-plugin-id="music-tools"] .plugin-enabled-toggle input',
      )?.checked,
      false,
    );
    assert.doesNotMatch(harness.document.querySelector("#status")?.textContent ?? "", /Lost the Plugin response/u);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});

test("Plugin controls and review copy follow the selected UI language", async () => {
  const state = stateFixture();
  state.settings.uiLanguage = "zh-CN";
  state.plugins = [installedPlugin(false)];
  const harness = await createDialogHarness(state, undefined, {
    navigatorLanguages: ["zh-CN"],
  });
  try {
    assert.match(
      harness.document.querySelector('#pluginMcpSource-music-tools')?.textContent ?? "",
      /已禁用.*本地进程.*远程 MCP/s,
    );
    harness.dropPluginFile(pluginFile(harness, pluginArchive("更新版本")));
    await harness.settle();
    await waitForCondition(
      () => harness.document.querySelector<HTMLElement>("#appConfirmation")?.hidden === false,
      `Expected translated replacement review; status=${harness.document.querySelector("#status")?.textContent ?? ""}; calls=${harness.calls.map((call) => call.path).join(",")}`,
    );
    assert.equal(
      harness.document.querySelector("#appConfirmationTitle")?.textContent,
      "替换已安装的插件？",
    );
    assert.match(
      harness.document.querySelector("#appConfirmationMessage")?.textContent ?? "",
      /替换 music-tools 1\.2\.0.*格式：Agent Plugin.*内容：1 个技能/s,
    );
    await harness.cancelAppConfirmation();
    await waitForPluginIdle(harness);
    assert.equal(harness.calls.some((call) => call.path === "/plugins"), false);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
});
