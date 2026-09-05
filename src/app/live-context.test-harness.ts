import type { LiveContextPresentation } from "../live/context.js";

/** Presentation for app fixtures that supply an interaction without SDK objects. */
export function liveContextPresentationFixture(
  title: string,
  objectKind: LiveContextPresentation["objectKind"] = "track",
): LiveContextPresentation {
  return { origin: "object", objectKind, title, details: [] };
}
