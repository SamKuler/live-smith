import type { AudioOperation, AudioProvider } from "../../audio-services/contracts.js";
import type { BuiltInAudioPluginDefinition } from "./contracts.js";
import { elevenLabsPlugin } from "./elevenlabs.js";
import { googleLyriaPlugin } from "./google-lyria.js";
import { lalalPlugin } from "./lalal.js";
import { murekaPlugin } from "./mureka.js";
import { sunoPlatformPlugin } from "./suno-platform.js";
import { sunoWebsitePlugin } from "./suno-website.js";
import { sunoApiPlugin } from "./sunoapi.js";

export const BUILT_IN_AUDIO_PLUGINS: readonly BuiltInAudioPluginDefinition[] = [
  lalalPlugin,
  elevenLabsPlugin,
  googleLyriaPlugin,
  murekaPlugin,
  sunoPlatformPlugin,
  sunoWebsitePlugin,
  sunoApiPlugin,
];

const byProvider = new Map(BUILT_IN_AUDIO_PLUGINS.map((plugin) => [plugin.provider, plugin]));

export function builtInAudioPlugin(provider: AudioProvider): BuiltInAudioPluginDefinition {
  const plugin = byProvider.get(provider);
  if (!plugin) throw new Error("Built-in audio Plugin is unavailable.");
  return plugin;
}

export function builtInAudioToolIdentity(
  provider: AudioProvider,
  operation: AudioOperation,
): { pluginId: string; toolId: AudioOperation; toolVersion: string } {
  const plugin = builtInAudioPlugin(provider);
  if (!plugin.capabilities.operations.includes(operation)) {
    throw new Error("Built-in Plugin does not own this tool.");
  }
  return { pluginId: plugin.id, toolId: operation, toolVersion: plugin.version };
}
