import assert from "node:assert/strict";
import test from "node:test";
import { BUILT_IN_AUDIO_PLUGINS } from "../../../src/plugins/builtins/index.js";
import { audioParameterGroups } from "../../../src/plugins/builtins/parameter-panel.js";
import { builtInAudioToolName } from "../../../src/plugins/builtins/audio-toolsets.js";

test("every advertised built-in provider tool receives a per-connection canonical manual schema", () => {
  const services = BUILT_IN_AUDIO_PLUGINS.flatMap((plugin) => ["personal", "work"].map((suffix) => ({
    id: `${plugin.provider}-${suffix}`, name: `${plugin.provider} ${suffix}`, pluginId: plugin.id, provider: plugin.provider,
  })));
  const groups = audioParameterGroups({ services, hasJobs: false, identity: (id) => id });
  const media = groups.filter((group) => group.pluginId === "live-smith.media");
  assert.equal(media.length, 1);
  assert.deepEqual(media[0]!.tools.map((tool) => tool.name).sort(), ["list_audio_jobs", "resume_audio_job"]);
  for (const service of services) {
    const plugin = BUILT_IN_AUDIO_PLUGINS.find((plugin) => plugin.id === service.pluginId)!;
    const advertised = plugin.tools.tools([service]);
    const group = groups.find((group) => group.connectionId === service.id)!;
    assert.deepEqual(group.tools.map((tool) => tool.name), advertised.map((tool) => builtInAudioToolName(plugin, tool.function.name)));
    for (const tool of group.tools) {
      assert.ok(tool.audioPanel, `${tool.name} must expose supported bounded parameters`);
      assert.equal(tool.audioPanel.connectionId, service.id);
      assert.doesNotMatch(JSON.stringify(tool.audioPanel.schema), /request_audio_attachment/);
      assert.match(tool.audioPanel.signature, /^[a-f0-9]{64}$/);
    }
  }
  const first = groups.find((group) => group.connectionId === services[0]!.id)!.tools[0]!.audioPanel!;
  const second = groups.find((group) => group.connectionId === services[1]!.id)!.tools[0]!.audioPanel!;
  assert.notEqual(first.signature, second.signature);
});
