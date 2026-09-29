import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import { strToU8, zipSync } from "fflate/browser";
import { resolveSkillContext } from "../app/skill-context.js";
import { installPlugin, readPluginConfig, savePluginConfigInTransaction, setPluginEnabled, deletePlugin,
  readInstalledPluginPackagesInTransaction } from "../storage/plugins.js";
import { withStorageTransaction } from "../storage/persistence.js";
import { openPluginArchive } from "./archive.js";
import { installedPluginViews } from "./view.js";
import { emptyPluginConfig, parsePluginConfig, pluginConfigView, renderPluginConfigText, updatePluginConfig,
  PLUGIN_CONFIG_NAMESPACE } from "./user-config.js";
import { expandPluginMcpTemplate } from "./mcp/client.js";

const declaration = {
  style: { type: "string", title: "Style", description: "Music style", default: "ambient", options: ["ambient", "jazz"] },
  bars: { type: "number", title: "Bars", description: "Chunk length", default: 4, min: 1, max: 32 },
  enabled: { type: "boolean", title: "Enabled", description: "Enable generation", default: false },
  tags: { type: "string", title: "Tags", description: "Style tags", multiple: true, default: ["soft", "slow"] },
  token: { type: "string", title: "Token", description: "Service authentication", sensitive: true },
};
function archive(format: "claude" | "codex" | "portable", version = "1.0.0", fields = declaration) {
  const manifest = { name: "config-fixture", version,
    ...(format === "portable" ? { $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      extensions: { [PLUGIN_CONFIG_NAMESPACE]: { userConfig: fields } } } : { userConfig: fields }) };
  return zipSync({
    [format === "portable" ? "plugin.json" : `.${format}-plugin/plugin.json`]: strToU8(JSON.stringify(manifest)),
    "skills/music/SKILL.md": strToU8("---\nname: music\ndescription: Make music\n---\nStyle ${user_config.style}; bars ${user_config.bars}; secret ${user_config.token}."),
  });
}

test("native Claude, Codex compatibility, and portable extensions share the same userConfig semantics", async () => {
  for (const format of ["claude", "codex", "portable"] as const) {
    const opened = await openPluginArchive(archive(format));
    assert.deepEqual(opened.manifest.userConfig, parsePluginConfig(declaration));
    assert.deepEqual(opened.manifest.unsupportedComponents ?? [], []);
  }
  const both = zipSync({
    ".codex-plugin/plugin.json": strToU8(JSON.stringify({ name: "paired", version: "1.0.0" })),
    ".claude-plugin/plugin.json": strToU8(JSON.stringify({ name: "paired", version: "1.0.0", userConfig: declaration })),
  });
  assert.deepEqual((await openPluginArchive(both)).manifest.userConfig, parsePluginConfig(declaration));
});

test("typed configuration rejects invalid values and never projects sensitive defaults or values", () => {
  const fields = parsePluginConfig(declaration);
  const stored = updatePluginConfig(fields, emptyPluginConfig(), { style: "jazz", bars: 8, enabled: false, tags: ["one", "two"] }, { token: "test-secret-value" });
  assert.throws(() => updatePluginConfig(fields, stored, { bars: 40 }, {}), /bars/);
  assert.throws(() => updatePluginConfig(fields, stored, { enabled: "false" }, {}), /enabled/);
  assert.throws(() => updatePluginConfig(fields, stored, { token: "bad-route" }, {}), /token/);
  assert.throws(() => parsePluginConfig({ ...declaration, tags: { ...declaration.tags, options: ["one"] } }), /invalid/);
  assert.equal(renderPluginConfigText("${user_config.bars}/${user_config.style}/${user_config.enabled}/${user_config.tags}/${user_config.token}", fields, stored),
    '8/jazz/false/["one","two"]/[sensitive value]');
  const view = pluginConfigView(fields, stored);
  assert.deepEqual(view.configuredSecrets, ["token"]);
  assert.equal(JSON.stringify(view).includes("test-secret-value"), false);
  const secretDefault = parsePluginConfig({ key: { type: "string", title: "Key", description: "Key", sensitive: true, default: "test-private-default" } });
  assert.equal(JSON.stringify(pluginConfigView(secretDefault, emptyPluginConfig())).includes("test-private-default"), false);
});

test("MCP interpolation resolves paths, values, and credentials in a single pass", () => {
  const fields = parsePluginConfig({ value: { type: "string", title: "Value", description: "Value", default: "${PLUGIN_ROOT}:${KEY}" } });
  const paths = { pluginRoot: "/plugin", pluginData: "/data", secrets: { KEY: "${user_config.value}" },
    userConfig: { fields, stored: emptyPluginConfig() } };
  assert.equal(expandPluginMcpTemplate("${PLUGIN_ROOT}/${user_config.value}/${KEY}", paths, "credentials"),
    "/plugin/${PLUGIN_ROOT}:${KEY}/${user_config.value}");
  assert.throws(() => expandPluginMcpTemplate("${user_config.unknown}", paths), /not declared/);
});

test("configuration survives reopening and package replacement, binds revisions, and is removed on uninstall", async (t) => {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-config-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const plugin = await installPlugin(directory, archive("claude"));
  const save = (revision: string, sha256 = plugin.sha256) => withStorageTransaction(directory, (transaction) =>
    savePluginConfigInTransaction(transaction, directory, { pluginId: plugin.id, sha256, revision,
      values: { style: "jazz", bars: 8 }, secretUpdates: { token: "test-private-value" } }));
  await save("0");
  await assert.rejects(save("0"), /another window/);
  await setPluginEnabled(directory, plugin.id, true);
  const rendered = await resolveSkillContext({ storageDirectory: directory, sessionSkillIds: ["config-fixture:music"], prompt: "Continue" });
  assert.match(rendered.instructionBlock, /Style jazz; bars 8; secret \[sensitive value\]/);
  assert.deepEqual(rendered.pluginConfigSnapshots, { "config-fixture": { sha256: plugin.sha256, revision: "1" } });
  const views = await withStorageTransaction(directory, async (transaction) =>
    installedPluginViews(await readInstalledPluginPackagesInTransaction(transaction, directory)));
  assert.equal(JSON.stringify(views).includes("test-private-value"), false);
  const replacement = await installPlugin(directory, archive("claude", "2.0.0"), { replace: true });
  assert.equal((await readPluginConfig(directory, plugin.id)).values.bars, 8);
  await assert.rejects(save("1"), /Plugin changed/);
  await save("1", replacement.sha256);
  await deletePlugin(directory, plugin.id);
  await assert.rejects(fs.access(path.join(directory, "live-smith-plugins", "packages", plugin.id)), /ENOENT/);
});

test("upgrading a formerly sensitive field to ordinary text does not reveal its saved value", () => {
  const stored = { revision: "1", values: {}, secrets: { token: "test-secret" } };
  const fields = parsePluginConfig({ token: { ...declaration.token, sensitive: false, required: true } });
  assert.deepEqual(pluginConfigView(fields, stored).values, {});
  assert.deepEqual(pluginConfigView(fields, stored).invalidFields, ["token"]);
});


test("MCP arguments preserve native script templates while env and headers bind credentials", () => {
  const fields = parsePluginConfig({ value: { type: "string", title: "Value", description: "Value", default: "${HOME}" } });
  const paths = { pluginRoot: "/plugin", pluginData: "/data", secrets: { TOKEN: "${HOME}" },
    userConfig: { fields, stored: emptyPluginConfig() } };
  assert.equal(expandPluginMcpTemplate("const text = `${name}`; ${HOME} ${MISSING:-fallback} ${PLUGIN_ROOT} ${user_config.value}", paths),
    "const text = `${name}`; ${HOME} ${MISSING:-fallback} /plugin ${HOME}");
  assert.equal(expandPluginMcpTemplate("${TOKEN}:${MISSING:-fallback}:${user_config.value}", paths, "credentials"),
    "${HOME}:fallback:${HOME}");
  assert.throws(() => expandPluginMcpTemplate("${MISSING}", paths, "credentials"), /not configured/);
});
