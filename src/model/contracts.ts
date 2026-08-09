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
      base64: string;
    };

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
