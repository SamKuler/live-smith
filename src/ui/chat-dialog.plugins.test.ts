import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { strToU8, zipSync } from "fflate/browser";

import {
  commandCalls,
  createDialogHarness,
  stateFixture,
  waitForCondition,
} from "./chat-dialog.test-harness.js";

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
    mcpServers: [
      {
        id: "converter",
        type: "stdio" as const,
        approved: false,
        artifactInputApproved: false,
        artifactOutputApproved: false,
        target: "./bin/converter",
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

test("Plugin cards expose bounded capabilities and compact management actions", async () => {
  const state = stateFixture();
  state.plugins = [installedPlugin()];
  const harness = await createDialogHarness(state);
  try {
    const card = harness.document.querySelector<HTMLElement>('[data-plugin-id="music-tools"]');
    assert.ok(card);
    assert.match(card.textContent ?? "", /1\.2\.0.*Agent Plugin/s);
    assert.match(card.textContent ?? "", /1 Skills.*2 MCP servers/s);
    assert.match(card.textContent ?? "", /converter.*Local process.*\.\/bin\/converter/s);
    assert.match(card.textContent ?? "", /catalog.*Remote MCP.*https:\/\/plugins\.example\.test/s);
    assert.match(card.textContent ?? "", /Not used by Live Smith: hooks/);
    assert.doesNotMatch(card.textContent ?? "", /private\/catalog|token=hidden/u);
    assert.equal(card.querySelector<HTMLButtonElement>(".danger-action")?.disabled, false);
    assert.deepEqual(harness.errors, []);
  } finally {
    harness.close();
  }
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
      harness.document.querySelector('[data-skill-id="music-tools:convert"]'),
      null,
    );

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
    assert.equal(harness.document.querySelectorAll('[data-plugin-id="music-tools"]').length, 1);
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

test("Plugin controls and review copy follow the selected UI language", async () => {
  const state = stateFixture();
  state.settings.uiLanguage = "zh-CN";
  state.plugins = [installedPlugin(false)];
  const harness = await createDialogHarness(state, undefined, {
    navigatorLanguages: ["zh-CN"],
  });
  try {
    assert.match(
      harness.document.querySelector('[data-plugin-id="music-tools"]')?.textContent ?? "",
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
