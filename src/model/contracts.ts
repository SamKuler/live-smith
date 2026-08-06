export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

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

export interface ModelTurn {
  content: string | null;
  toolCalls: ModelToolCall[];
  providerState?: unknown;
}

export type ModelConversationMessage =
  | {
      role: "assistant";
      content: string | null;
      toolCalls: ModelToolCall[];
      providerState?: unknown;
    }
  | { role: "tool"; toolCallId: string; content: string };
