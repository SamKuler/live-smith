import type { SavedProfile } from "./profile.js";
import type { ModelFunctionTool, ModelTool } from "./provider.js";

export const HOSTED_WEB_SEARCH_MAX_USES = 5;

export function modelToolsForProfile(
  profile: SavedProfile,
  clientTools: readonly ModelFunctionTool[],
): ModelTool[] {
  return [
    ...clientTools,
    ...(profile.advanced.hostedTools?.webSearch
      ? [{
          type: "hosted_web_search" as const,
          maxUses: HOSTED_WEB_SEARCH_MAX_USES,
        }]
      : []),
  ];
}
