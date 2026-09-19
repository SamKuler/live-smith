import type { AudioOperation, AudioProvider } from "./contracts.js";
import { BUILT_IN_AUDIO_PLUGINS } from "../plugins/builtins/index.js";
import type { BuiltInAudioCapabilities } from "../plugins/builtins/contracts.js";

export {
  DEFAULT_GOOGLE_LYRIA_MUSIC_MODEL,
  GOOGLE_LYRIA_MUSIC_MODELS,
} from "../plugins/builtins/google-lyria.js";
export {
  DEFAULT_MUREKA_MUSIC_MODEL,
  MUREKA_MUSIC_MODELS,
} from "../plugins/builtins/mureka.js";
export {
  DEFAULT_SUNOAPI_MUSIC_MODEL,
  SUNOAPI_MUSIC_MODELS,
} from "../plugins/builtins/sunoapi.js";

/** Protocol capabilities owned by each built-in Plugin package. */
export const AUDIO_SERVICE_CAPABILITIES = Object.fromEntries(
  BUILT_IN_AUDIO_PLUGINS.map((plugin) => [plugin.provider, plugin.capabilities]),
) as Record<AudioProvider, BuiltInAudioCapabilities>;

export function audioServiceSupports(provider: AudioProvider, operation: AudioOperation): boolean {
  return AUDIO_SERVICE_CAPABILITIES[provider].operations.includes(operation);
}

export interface AudioServiceChoice {
  id: string;
  name: string;
  provider: AudioProvider;
  modelId?: string;
}
