import type { SavedProfile } from "./profile.js";
import type { ModelFunctionTool, ModelTool } from "./provider.js";

export const HOSTED_WEB_SEARCH_REQUEST_MAX_USES = 20;
export const HOSTED_WEB_SEARCH_MAX_EVENTS_PER_SEND = 20;

export function modelToolsForProfile(
  profile: SavedProfile,
  clientTools: readonly ModelFunctionTool[],
  hostedWebSearchMaxUses = HOSTED_WEB_SEARCH_REQUEST_MAX_USES,
): ModelTool[] {
  if (
    !Number.isInteger(hostedWebSearchMaxUses) ||
    hostedWebSearchMaxUses < 0 ||
    hostedWebSearchMaxUses > HOSTED_WEB_SEARCH_REQUEST_MAX_USES
  ) {
    throw new TypeError("Hosted Web Search request limit is invalid.");
  }
  return [
    ...clientTools,
    ...(profile.advanced.hostedTools?.webSearch && hostedWebSearchMaxUses > 0
      ? [{
          type: "hosted_web_search" as const,
          maxUses: hostedWebSearchMaxUses,
        }]
      : []),
  ];
}

export function isHostedWebSearchRequestMaxUses(value: number): boolean {
  return Number.isInteger(value) &&
    value >= 1 &&
    value <= HOSTED_WEB_SEARCH_REQUEST_MAX_USES;
}
