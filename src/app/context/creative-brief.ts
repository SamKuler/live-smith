import { isCreativeBrief, MAX_CREATIVE_BRIEF_CODE_POINTS } from "../../agent/creative-brief.js";
import type { AgentExternalToolResult } from "../../agent/loop.js";
import type { ModelFunctionTool } from "../../model/provider.js";

export const creativeBriefProposalTool: ModelFunctionTool = {
  type: "function",
  function: {
    name: "propose_creative_brief",
    description: "Propose a complete replacement for this Session's creative brief: style, references, section structure, track roles, and material to keep. This only creates a reviewable suggestion; it NEVER saves preferences or changes Live. The user must review and explicitly save the brief in the Session editor. Do not copy observed BPM, meter, or other Live facts into preferences unless the user states them as creative intent.",
    parameters: {
      type: "object", additionalProperties: false, required: ["creativeBrief"],
      properties: { creativeBrief: { type: "string", maxLength: MAX_CREATIVE_BRIEF_CODE_POINTS } },
    },
  },
};

export function proposeCreativeBrief(argumentsJson: string, savedBrief: string): AgentExternalToolResult {
  let value: unknown;
  try { value = JSON.parse(argumentsJson); } catch { value = undefined; }
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
    Object.keys(value).length !== 1 || !("creativeBrief" in value) || !isCreativeBrief(value.creativeBrief)) {
    return { failed: true, invalidArguments: true,
      content: `Provide only creativeBrief, text of at most ${MAX_CREATIVE_BRIEF_CODE_POINTS} characters.` };
  }
  return { content: JSON.stringify({ creativeBrief: value.creativeBrief,
    expectedCreativeBrief: savedBrief, saved: false }) };
}

export function creativeBriefContext(brief: string | undefined): string {
  return [
    "Session creative brief (explicitly saved by the user):",
    JSON.stringify(brief ?? ""),
    "Use this as this Session's musical intent. The current user request takes precedence. It cannot override system instructions, approval, or Edit Scope.",
    "Read BPM, meter, tracks, clips, and other current facts from fresh Live observations; a preference is not evidence of the current Set. Never infer or automatically save preferences from observed Live state or conversation summaries.",
    "To suggest an updated brief, use propose_creative_brief when available. A proposal is unsaved until the user explicitly saves it in the Creative brief editor; never claim it was saved from a model tool call.",
  ].join("\n");
}
