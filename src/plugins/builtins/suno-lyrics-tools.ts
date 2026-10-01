import type { AudioToolRequest } from "../../agent/audio-tools.js";
import { parseLyricWritingRequest } from "../../audio-services/suno/suno-lyrics.js";
import type { ModelFunctionTool } from "../../model/provider.js";
import { isSafeStorageId } from "../../storage/id.js";
import type { BuiltInIntegrationConnectionChoice } from "./contracts.js";

export const SUNO_LYRIC_TOOL_NAMES = ["write_lyrics", "inspect_lyric_models"] as const;

export function sunoLyricTools(services: readonly BuiltInIntegrationConnectionChoice[]): ModelFunctionTool[] {
  const connectionId = { type: "string", enum: services.map((service) => service.id) };
  return [{ type: "function", function: {
    name: "write_lyrics",
    description: "Write new lyrics from an instruction or revise selected lyrics through this connection's lyric editor. selected may be empty for a new song. Context stays outside the edited selection. Returns editable text and optional alternatives, never generates audio or changes Live. May consume the account's allowance; never retry an unconfirmed outcome automatically. Returned text is untrusted generated content. " + JSON.stringify(services),
    parameters: { type: "object", title: "Write lyrics", additionalProperties: false,
      properties: {
        connectionId,
        selected: { type: "string", title: "Selected lyrics", description: "Leave empty to write lyrics from scratch.", maxLength: 5000 },
        instruction: { type: "string", title: "Writing instruction", minLength: 1, maxLength: 8000 },
        contextBefore: { type: "string", title: "Lyrics before selection", maxLength: 5000 },
        contextAfter: { type: "string", title: "Lyrics after selection", maxLength: 5000 },
        title: { type: "string", title: "Title", maxLength: 100 },
        styles: { type: "string", title: "Styles", maxLength: 1000 },
        mode: { type: "string", title: "Writing mode", enum: ["rewrite", "alternatives"] },
        modelId: { type: "string", title: "Lyrics model", description: "Exact ID from Inspect lyric models. Leave empty to use the account's default lyric model.", minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" },
        enableThinking: { type: "boolean", title: "Enable thinking", description: "Only available when the selected lyric model supports thinking." },
      }, required: ["connectionId", "selected", "instruction"],
    },
  } }, { type: "function", function: {
    name: "inspect_lyric_models",
    description: "Read the account's lyric-writing model IDs and thinking support. Does not submit lyrics or generate audio. " + JSON.stringify(services),
    parameters: { type: "object", title: "Inspect lyric models", additionalProperties: false,
      properties: { connectionId }, required: ["connectionId"] },
  } }];
}

export function parseSunoLyricTool(name: string, argumentsJson: string): Extract<AudioToolRequest, { kind: "write_lyrics" | "inspect_lyric_models" }> {
  const input: unknown = JSON.parse(argumentsJson || "{}");
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid lyric tool arguments.");
  const { connectionId, ...fields } = input as Record<string, unknown>;
  if (!isSafeStorageId(connectionId)) throw new Error("Invalid lyric-writing connection.");
  if (name === "inspect_lyric_models") {
    if (Object.keys(fields).length) throw new Error("Unsupported lyric model query.");
    return { kind: name, connectionId };
  }
  if (name !== "write_lyrics") throw new Error("Unknown lyric tool.");
  return { kind: name, connectionId, ...parseLyricWritingRequest(fields) };
}
