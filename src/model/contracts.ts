export type ModelInputPart =
  | { type: "text"; text: string }
  | {
      type: "image";
      fileName: string;
      mediaType: "image/png" | "image/jpeg" | "image/webp";
      base64: string;
    }
  | {
      type: "document";
      fileName: string;
      mediaType: "application/pdf";
      base64: string;
    }
  | {
      type: "audio";
      fileName: string;
      mediaType: "audio/wav" | "audio/mpeg";
      /** Owned original bytes; each transport chooses its wire encoding. */
      bytes: Uint8Array;
    };

export type ModelToolInputPart = Extract<ModelInputPart, { type: "audio" }>;

export type ConversationMessage =
  | { role: "user"; content: ModelInputPart[] }
  | { role: "assistant"; content: string };

export type ConversationScope =
  | { kind: "track"; identity: string; label: string }
  | { kind: "clip"; identity: string; label: string }
  | { kind: "object"; identity: string; label: string }
  | { kind: "selection"; identity: string; label: string };

export interface ModelToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ModelCitation {
  url: string;
  title: string;
}

export type ModelHostedWebSearchAction =
  | "search"
  | "open_page"
  | "find_in_page";

export interface ModelHostedWebSearch {
  /** Provider call identity, bounded before it leaves the transport. */
  id: string;
  status: "searching" | "completed" | "failed";
  action: ModelHostedWebSearchAction;
  /** Provider-confirmed user-facing queries; internal call metadata is removed. */
  queries: string[];
  /** Pages returned or opened by this search action; always empty when failed. */
  sources: ModelCitation[];
}

export interface ModelContextUsage {
  usedTokens: number;
  contextWindowTokens: number;
}

/** Provider-returned reasoning that is explicitly safe to display. */
export interface ModelReasoning {
  /** Empty when the provider exposed only a reasoning-stage signal. */
  content: string;
}

export type ModelReasoningStreamUpdate =
  /** Begins one provider request's visible-reasoning segment. */
  | { type: "start" }
  | { type: "delta"; delta: string }
  /** Replaces only the content produced since the most recent start. */
  | { type: "replace"; content: string };

export function requireModelContextUsage(
  usedTokens: unknown,
  contextWindowTokens: unknown,
): ModelContextUsage {
  if (
    !Number.isSafeInteger(usedTokens) ||
    (usedTokens as number) < 0 ||
    !Number.isSafeInteger(contextWindowTokens) ||
    (contextWindowTokens as number) <= 0
  ) {
    throw new TypeError("Model context usage is invalid.");
  }
  return {
    usedTokens: usedTokens as number,
    contextWindowTokens: contextWindowTokens as number,
  };
}

export interface ModelTurn {
  content: string | null;
  toolCalls: ModelToolCall[];
  /** Visible provider reasoning only; opaque continuation state stays provider-owned. */
  reasoning?: ModelReasoning;
  /** Exact provider usage for this turn when an authoritative context window is known. */
  contextUsage?: ModelContextUsage;
  /** The provider returned replayable state but needs another model turn to finish. */
  continuation?: { reason: "output_limit" };
  /** The provider returned a valid partial turn that cannot safely continue. */
  termination?: { reason: "context_limit" | "output_limit" };
  citations?: ModelCitation[];
  /** Terminal provider-hosted Web Search actions in this model turn. */
  hostedWebSearches?: ModelHostedWebSearch[];
  providerState?: unknown;
}

export type ModelConversationMessage =
  | { role: "user"; content: string | ModelInputPart[] }
  | {
      role: "assistant";
      content: string | null;
      toolCalls: ModelToolCall[];
      providerState?: unknown;
    }
  | {
      role: "tool";
      toolCallId: string;
      content: string;
      /** Ephemeral audio produced by this tool; never persisted in trace text. */
      modelInputPart?: ModelToolInputPart;
    };
