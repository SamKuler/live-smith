import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { zipSync } from "fflate/browser";

import { resolveSkillContext } from "../app/skill-context.js";
import { createRequestPluginTools } from "../app/request-plugin-tools.js";
import { createHostAbortController } from "../runtime/host.js";
import { pluginSkillsFromPackages } from "../skills/plugin-package.js";
import {
  deletePlugin,
  installPlugin,
  listInstalledPlugins,
  readEnabledPluginPackagesInTransaction,
  setPluginEnabled,
  setPluginMcpServerApproved,
} from "../storage/plugins.js";
import { withStorageTransaction } from "../storage/persistence.js";
import { createSession } from "../storage/sessions.js";
import { openPluginArchive } from "./archive.js";
import type { PluginSourceFormat } from "./contracts.js";

const fixtureRoot = fileURLToPath(
  new URL("../../test-fixtures/plugins/", import.meta.url),
);

const cases: readonly {
  directory: string;
  pluginId: string;
  sourceFormat: PluginSourceFormat;
  unsupportedComponents: readonly string[];
}[] = [
  {
    directory: "portable-skill-mcp",
    pluginId: "fixture.portable",
    sourceFormat: "agent-plugins-1.0",
    unsupportedComponents: [],
  },
  {
    directory: "codex-compatible",
    pluginId: "fixture.codex",
    sourceFormat: "codex",
    unsupportedComponents: ["commands"],
  },
  {
    directory: "claude-compatible",
    pluginId: "fixture.claude",
    sourceFormat: "claude",
    unsupportedComponents: ["hooks"],
  },
];

test("portable, Codex, and Claude Plugin fixtures share one bounded lifecycle", async (t) => {
  for (const fixture of cases) {
    await t.test(fixture.sourceFormat, async (t) => {
      const storage = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-plugin-compat-"));
      t.after(() => fs.rm(storage, { recursive: true, force: true }));
      const bytes = await fixtureArchive(fixture.directory);
      const archive = await openPluginArchive(bytes);
      assert.equal(archive.manifest.id, fixture.pluginId);
      assert.equal(archive.manifest.sourceFormat, fixture.sourceFormat);
      assert.deepEqual(
        archive.manifest.unsupportedComponents ?? [],
        fixture.unsupportedComponents,
      );
      assert.equal(archive.manifest.components.skillsDirectory, "skills");
      assert.ok(
        archive.manifest.components.mcpConfigPath ||
          archive.manifest.components.mcpManifestPath,
      );

      const installed = await installPlugin(storage, bytes);
      assert.equal(installed.enabled, false);
      assert.deepEqual(installed.approvedMcpServerIds, []);
      await setPluginMcpServerApproved(
        storage,
        fixture.pluginId,
        "fixture",
        true,
      );
      await setPluginEnabled(storage, fixture.pluginId, true);

      const packages = await withStorageTransaction(storage, (transaction) =>
        readEnabledPluginPackagesInTransaction(transaction, storage));
      const skills = await pluginSkillsFromPackages(packages);
      assert.deepEqual(skills.map((skill) => skill.id), [
        `${fixture.pluginId}:review`,
      ]);
      const skillContext = await resolveSkillContext({
        storageDirectory: storage,
        sessionSkillIds: [`${fixture.pluginId}:review`],
        prompt: "Review this fixture.",
      });
      assert.deepEqual(skillContext.activeSkillIds, [
        `${fixture.pluginId}:review`,
      ]);

      const session = await createSession(storage, {
        title: "Plugin compatibility",
        projectKey: "fixture-project",
        scope: { kind: "selection", identity: "selection", label: "Fixture" },
      });
      const request = await createRequestPluginTools({
        storageDirectory: storage,
        sessionId: session.id,
        signal: createHostAbortController().signal,
        withAuthorization: async (_signal, operation) => operation(),
      });
      t.after(() => request.close());
      const tool = request.tools().find((entry) =>
        entry.function.description === "Echo fixture text");
      assert.ok(tool);
      const result = await request.callTool({
        id: "fixture-call",
        name: tool.function.name,
        arguments: JSON.stringify({ text: fixture.sourceFormat }),
      });
      assert.equal(result.failed, undefined);
      assert.deepEqual(JSON.parse(result.content), {
        notice: "Untrusted Plugin tool result.",
        content: [{ type: "text", text: fixture.sourceFormat }],
        structuredContent: { echoed: fixture.sourceFormat },
      });
      await request.close();

      await setPluginEnabled(storage, fixture.pluginId, false);
      const disabled = await createRequestPluginTools({
        storageDirectory: storage,
        sessionId: session.id,
        signal: createHostAbortController().signal,
        withAuthorization: async (_signal, operation) => operation(),
      });
      assert.equal(disabled.tools().some((entry) =>
        entry.function.description === "Echo fixture text"), false);
      await disabled.close();

      await deletePlugin(storage, fixture.pluginId);
      assert.deepEqual(await listInstalledPlugins(storage), []);
    });
  }
});

async function fixtureArchive(directory: string): Promise<Uint8Array> {
  const root = path.join(fixtureRoot, directory);
  const files = new Map<string, Uint8Array>();
  await collectFiles(root, root, files);
  return zipSync(Object.fromEntries(files));
}

async function collectFiles(
  root: string,
  directory: string,
  output: Map<string, Uint8Array>,
): Promise<void> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(root, target, output);
      continue;
    }
    if (!entry.isFile()) throw new Error("Plugin compatibility fixtures must contain regular files only.");
    output.set(path.relative(root, target).split(path.sep).join("/"), await fs.readFile(target));
  }
}
