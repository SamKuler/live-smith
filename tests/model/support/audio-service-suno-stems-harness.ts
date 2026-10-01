import { SUNO_STEM_BASE_ROLES } from "../../../src/audio-services/contracts.js";
import { accountId, C, catalog, clip, gateStep, type Step } from "./audio-service-suno-harness.js";

export const stemGroups = ["Vocals", "Backing_Vocals", "Drums", "Bass", "Guitar", "Keyboard", "Percussion", "Strings", "Synth", "FX", "Brass", "Woodwinds"];
export const stemIds = Array.from({ length: 24 }, (_, index) => `00000000-0000-4000-8000-${(100 + index).toString().padStart(12, "0")}`);
export const stemClips = (count = 12) => stemIds.slice(0, count).map((id, index) => clip(id, "complete", {
  metadata: { type: "stem", task: "gen_stem", stem_task: "twelve", stem_type_group_name: stemGroups[index % 12],
    stem_from_id: C, history: [{ id: `m_${C}`, type: "generate" }, { id, type: "stem", stem_task: "twelve" }],
    is_loudness_under_threshold: index % 12 === 9, duration: 30 },
}));
export const stemManifest = (count = 12) => stemIds.slice(0, count).map((key, index) => ({ key,
  role: index < 12 ? SUNO_STEM_BASE_ROLES[index]! : `${SUNO_STEM_BASE_ROLES[index - 12]!}_alternative` as const,
}));
export const stemPreparation = (options: { features?: unknown[]; account?: object; source?: object; models?: unknown[] } = {}): Step[] => [
  { path: "/api/billing/info/", value: catalog(options.models, { accessible_features: options.features ?? [{ name: "get_stems" }] }) },
  { path: "/api/session/", value: { user: { clerk_id: accountId, id: "owner" }, ...options.account } },
  { path: `/api/feed/?ids=${C}`, value: [clip(C, "complete", { user_id: "owner", ...options.source })] },
  gateStep(),
];
