/** Durable tool execution facts; loop continuation is a separate decision. */
export type ToolResultOutcome = "success" | "failed" | "unknown" | "stopped";

export function isToolResultOutcome(value: unknown): value is ToolResultOutcome {
  return value === "success" || value === "failed" || value === "unknown" || value === "stopped";
}

export function externalToolOutcome(result: { failed?: boolean; outcomeUnknown?: boolean }): ToolResultOutcome {
  return result.outcomeUnknown ? "unknown" : result.failed ? "failed" : "success";
}
