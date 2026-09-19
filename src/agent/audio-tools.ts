import type { BuiltInIntegrationConnectionChoice } from "../plugins/builtins/contracts.js";
import { builtInAudioPluginById } from "../plugins/builtins/index.js";
import { validateBuiltInAudioToolRequest } from "../plugins/builtins/provider-tools.js";
import type { AudioToolRequest } from "./audio-tool-parser.js";

export {
  parseAudioToolRequest,
  type AudioProcessingSource,
  type AudioToolRequest,
} from "./audio-tool-parser.js";

/** Compatibility entry point for callers that validate an already parsed request. */
export function validateAudioServiceRequest(
  request: AudioToolRequest,
  services: readonly BuiltInIntegrationConnectionChoice[],
): void {
  if (
    request.kind === "list_audio_jobs" ||
    request.kind === "resume_audio_job" ||
    request.kind === "listen_to_audio_asset"
  ) return;
  const service = services.find((entry) => entry.id === request.connectionId);
  const plugin = service && builtInAudioPluginById(service.pluginId);
  if (!service || !plugin || plugin.provider !== service.provider) {
    throw new Error("Unavailable Integration Connection or tool.");
  }
  validateBuiltInAudioToolRequest(
    request,
    plugin.audio,
    [service],
    plugin.tools.localToolNames,
  );
}
