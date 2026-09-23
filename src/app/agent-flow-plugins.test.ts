import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { URL } from "node:url";

import { strToU8, zipSync } from "fflate/browser";

import type { LiveInteractionContext } from "../live/context.js";
import { createHostAbortController } from "../runtime/host.js";
import { installPlugin, listInstalledPlugins, setPluginEnabled, setPluginMcpServerApproved } from "../storage/plugins.js";
import { createSession, listSessions, updateSessionInTransaction } from "../storage/sessions.js";
import type { ChatDialogState } from "../ui/chat-state.js";
import { runAgentFlow } from "./agent-flow.js";
import { liveContextPresentationFixture } from "./live-context.test-harness.js";
import { projectKeyForContext } from "./session-context.js";
import { createRequestPluginTools } from "./request-plugin-tools.js";

function pluginBytes(version: string): Uint8Array {
  return zipSync({
    "plugin.json": strToU8(JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "music-tools",
      version,
      description: "Convert audio into MIDI",
    })),
    "mcp.json": strToU8(JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: {
        converter: { type: "stdio", command: "./bin/converter" },
        catalog: {
          type: "streamable-http",
          url: "https://plugins.example.test/private/path?token=hidden",
        },
      },
    })),
    "skills/convert/SKILL.md": strToU8(
      "---\nname: convert\ndescription: Convert Session audio to MIDI\n---\nUse the converter tool.\n",
    ),
    "bin/converter": strToU8("#!/bin/sh\n"),
  });
}

function requestBody(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

test("Plugin bridge workflow inspects, installs, grants, disables, replaces, and deletes one package", async (t) => {
  const storageDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-plugin-flow-"));
  t.after(() => fs.rm(storageDirectory, { recursive: true, force: true }));
  const interaction: LiveInteractionContext = {
    presentation: liveContextPresentationFixture("Lead"),
    summary: "Track: Lead",
    target: {},
    scope: { kind: "track", identity: "track-1", label: "Lead" },
  };
  interaction.selectionContext = { refresh: () => interaction };
  let commandSequence = 0;

  await runAgentFlow({
    application: { song: { handle: { id: 1n } } },
    environment: { storageDirectory },
    ui: {
      showModalDialog: async (url: string) => {
        const endpoint = new URL(url);
        const request = async (
          pathname: string,
          init: RequestInit = {},
        ): Promise<Response> => {
          endpoint.pathname = pathname;
          endpoint.searchParams.delete("replace");
          return fetch(endpoint, init);
        };
        const command = async (body: unknown): Promise<ChatDialogState> => {
          const response = await request("/command", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Live-Smith-Command-Id": `plugin-command-${++commandSequence}`,
            },
            body: JSON.stringify(body),
          });
          const text = await response.text();
          assert.equal(response.status, 200, text);
          return JSON.parse(text) as ChatDialogState;
        };
        const upload = async (bytes: Uint8Array, replace: boolean) => {
          endpoint.pathname = "/plugins";
          endpoint.searchParams.set("replace", String(replace));
          const response = await fetch(endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/zip",
              "X-Live-Smith-Command-Id": `plugin-upload-${++commandSequence}`,
            },
            body: requestBody(bytes),
          });
          const text = await response.text();
          assert.equal(response.status, 201, text);
          return JSON.parse(text) as {
            state: ChatDialogState;
            receipt: { id: string; sha256: string };
          };
        };

        const versionOne = pluginBytes("1.0.0");
        const inspection = await request("/plugins/inspect", {
          method: "POST",
          headers: { "Content-Type": "application/zip" },
          body: requestBody(versionOne),
        });
        assert.equal(inspection.status, 200);
        const preview = await inspection.json() as {
          preview: {
            id: string;
            sha256: string;
            byteLength: number;
            mcpServers: Array<{ id: string; target: string; approved: boolean;
              artifactInputApproved: boolean; artifactOutputApproved: boolean;
              credentialFields: Array<{ name: string; required: boolean }> }>;
          };
        };
        assert.equal(preview.preview.id, "music-tools");
        assert.match(preview.preview.sha256, /^[a-f0-9]{64}$/u);
        assert.equal(preview.preview.byteLength, versionOne.byteLength);
        assert.deepEqual(preview.preview.mcpServers, [
          { id: "converter", target: "./bin/converter", approved: false, artifactInputApproved: false,
            artifactOutputApproved: false, type: "stdio", credentialFields: [] },
          { id: "catalog", target: "https://plugins.example.test", approved: false, artifactInputApproved: false,
            artifactOutputApproved: false, type: "streamable-http", credentialFields: [] },
        ]);
        assert.doesNotMatch(JSON.stringify(preview), /private\/path|token=hidden/u);
        const stateBeforeInstall = await request("/state").then((response) => response.json() as Promise<ChatDialogState>);
        assert.deepEqual(stateBeforeInstall.plugins, []);

        const installed = await upload(versionOne, false);
        assert.equal(installed.receipt.id, "music-tools");
        assert.equal(installed.receipt.sha256, preview.preview.sha256);
        assert.equal(installed.state.plugins[0]?.enabled, false);
        assert.equal(installed.state.availableSkills.some((skill) => skill.source === "plugin"), false);

        const enabled = await command({
          kind: "set_plugin_enabled",
          pluginId: "music-tools",
          enabled: true,
        });
        assert.equal(enabled.plugins[0]?.enabled, true);
        assert.ok(enabled.availableSkills.some((skill) => skill.id === "music-tools:convert"));
        const selected = await command({
          kind: "set_session_skills",
          sessionId: enabled.activeSessionId,
          skillIds: ["music-tools:convert"],
        });
        assert.deepEqual(selected.activeSkillIds, ["music-tools:convert"]);

        const approved = await command({
          kind: "set_plugin_mcp_server_approved",
          pluginId: "music-tools",
          serverId: "converter",
          approved: true,
        });
        assert.equal(
          approved.plugins[0]?.mcpServers.find((server) => server.id === "converter")?.approved,
          true,
        );
        for (const permission of ["input", "output"] as const) {
          const granted = await command({
            kind: "set_plugin_artifact_permission",
            pluginId: "music-tools",
            serverId: "converter",
            permission,
            approved: true,
          });
          const server = granted.plugins[0]?.mcpServers.find((entry) => entry.id === "converter");
          assert.equal(permission === "input" ? server?.artifactInputApproved : server?.artifactOutputApproved, true);
        }

        const disabled = await command({
          kind: "set_plugin_enabled",
          pluginId: "music-tools",
          enabled: false,
        });
        assert.equal(disabled.plugins[0]?.enabled, false);
        assert.deepEqual(disabled.activeSkillIds, []);
        assert.equal(disabled.availableSkills.some((skill) => skill.source === "plugin"), false);

        const replaced = await upload(pluginBytes("2.0.0"), true);
        assert.equal(replaced.state.plugins[0]?.version, "2.0.0");
        assert.equal(replaced.state.plugins[0]?.enabled, false);
        assert.ok(replaced.state.plugins[0]?.mcpServers.every((server) => !server.approved &&
          !server.artifactInputApproved && !server.artifactOutputApproved));

        const deleted = await command({ kind: "delete_plugin", pluginId: "music-tools" });
        assert.deepEqual(deleted.plugins, []);
      },
    },
  } as never, interaction, { renderHtml: () => "<html></html>" });

  assert.deepEqual(await listInstalledPlugins(storageDirectory), []);
  assert.ok((await listSessions(storageDirectory)).every((session) =>
    !session.activeSkillIds?.some((skillId) => skillId.startsWith("music-tools:"))));
});

test("a failed Session cleanup cannot leave a Plugin enabled with lost Skill selections", async (t) => {
  const storageDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-plugin-disable-"));
  t.after(() => fs.rm(storageDirectory, { recursive: true, force: true }));
  const interaction: LiveInteractionContext = {
    presentation: liveContextPresentationFixture("Lead"),
    summary: "Track: Lead",
    target: {},
    scope: { kind: "track", identity: "track-1", label: "Lead" },
  };
  interaction.selectionContext = { refresh: () => interaction };
  const context = {
    application: { song: { handle: { id: 1n } } },
    environment: { storageDirectory },
    ui: { showModalDialog: async (url: string) => {
      const endpoint = new URL(url);
      endpoint.pathname = "/command";
      const command = async (id: string) => fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Live-Smith-Command-Id": id },
        body: JSON.stringify({ kind: "set_plugin_enabled", pluginId: "music-tools", enabled: false }),
      });
      const disabledResponse = await command("disable-with-session-failure");
      const disabledText = await disabledResponse.text();
      assert.equal(disabledResponse.status, 200, disabledText);
      const disabled = JSON.parse(disabledText) as ChatDialogState;
      assert.equal(disabled.plugins[0]?.enabled, false);
      assert.deepEqual(disabled.activeSkillIds, []);
      assert.deepEqual(disabled.status, {
        source: "Plugin {pluginId} disabled; Session Skill cleanup is pending.",
        values: { pluginId: "music-tools" },
      });
      assert.equal((await listInstalledPlugins(storageDirectory))[0]?.enabled, false);
      assert.equal((await listSessions(storageDirectory)).filter((session) =>
        session.activeSkillIds?.includes("music-tools:convert")).length, 1);

      const retriedResponse = await command("retry-disabled-skill-cleanup");
      assert.equal(retriedResponse.status, 200, await retriedResponse.text());
      assert.ok((await listSessions(storageDirectory)).every((session) =>
        !session.activeSkillIds?.includes("music-tools:convert")));
    } },
  };
  await installPlugin(storageDirectory, pluginBytes("1.0.0"));
  await setPluginEnabled(storageDirectory, "music-tools", true);
  const projectKey = projectKeyForContext(context as never);
  for (const title of ["First", "Second"]) {
    await createSession(storageDirectory, {
      title,
      projectKey,
      scope: interaction.scope,
      activeSkillIds: ["music-tools:convert"],
    });
  }
  let cleanupWrites = 0;
  await runAgentFlow(context as never, interaction, {
    renderHtml: () => "<html></html>",
    updateSessionInTransaction: async (...args) => {
      if (args[3].activeSkillIds !== undefined && ++cleanupWrites === 2) {
        throw new Error("Injected second Session cleanup failure");
      }
      return updateSessionInTransaction(...args);
    },
  });
});

test("revoking approval or disabling a Plugin closes its active MCP request package", async (t) => {
  const storageDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-plugin-revoke-"));
  t.after(() => fs.rm(storageDirectory, { recursive: true, force: true }));
  await installPlugin(storageDirectory, pluginBytes("1.0.0"));
  await setPluginMcpServerApproved(storageDirectory, "music-tools", "converter", true);
  await setPluginEnabled(storageDirectory, "music-tools", true);
  const interaction: LiveInteractionContext = {
    presentation: liveContextPresentationFixture("Lead"),
    summary: "Track: Lead",
    target: {},
    scope: { kind: "track", identity: "track-1", label: "Lead" },
  };
  interaction.selectionContext = { refresh: () => interaction };
  const closed: number[] = [];
  await runAgentFlow({
    application: { song: { handle: { id: 1n } } },
    environment: { storageDirectory },
    ui: { showModalDialog: async (url: string) => {
      const endpoint = new URL(url);
      endpoint.pathname = "/state";
      const initial = await fetch(endpoint).then((response) => response.json() as Promise<ChatDialogState>);
      const openRequest = (index: number) => createRequestPluginTools({
        storageDirectory,
        sessionId: initial.activeSessionId,
        signal: createHostAbortController().signal,
        withAuthorization: async (_signal, operation) => operation(),
        createPackage: (runtime) => ({
          manifest: runtime.archive.manifest,
          async tools() { return { tools: [], issues: [] }; },
          async callTool() { return { content: [] }; },
          async close() { closed.push(index); },
        }),
      });
      const command = async (id: string, body: unknown) => {
        endpoint.pathname = "/command";
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Live-Smith-Command-Id": id },
          body: JSON.stringify(body),
        });
        assert.equal(response.status, 200, await response.text());
      };
      const first = await openRequest(1);
      try {
        await command("revoke-active-server", {
          kind: "set_plugin_mcp_server_approved", pluginId: "music-tools", serverId: "converter", approved: false,
        });
        assert.deepEqual(closed, [1]);
      } finally { await first.close(); }

      await command("restore-server-approval", {
        kind: "set_plugin_mcp_server_approved", pluginId: "music-tools", serverId: "converter", approved: true,
      });
      await command("grant-artifact-input", {
        kind: "set_plugin_artifact_permission", pluginId: "music-tools", serverId: "converter",
        permission: "input", approved: true,
      });
      const second = await openRequest(2);
      try {
        await command("revoke-artifact-input", {
          kind: "set_plugin_artifact_permission", pluginId: "music-tools", serverId: "converter",
          permission: "input", approved: false,
        });
        assert.deepEqual(closed, [1, 2]);
      } finally { await second.close(); }

      const third = await openRequest(3);
      try {
        await command("disable-active-plugin", {
          kind: "set_plugin_enabled", pluginId: "music-tools", enabled: false,
        });
        assert.deepEqual(closed, [1, 2, 3]);
      } finally { await third.close(); }
    } },
  } as never, interaction, { renderHtml: () => "<html></html>" });
});
