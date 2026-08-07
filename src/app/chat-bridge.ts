import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { URL } from "node:url";

import type { SessionEvent } from "../storage/events.js";
import { isStorageCommitOutcomeUnknownError } from "../storage/persistence.js";
import {
  ProfileValidationError,
  type DraftProfile,
} from "../model/profile.js";
import { createHostAbortController } from "../runtime/host.js";
import type { ActionDiffGroup } from "../ui/action-diff.js";
import type {
  ChatDialogState,
  ChatSessionActivity,
  ChatSessionActivityStatus,
} from "../ui/chat-state.js";

const sensitiveResponseHeaders = {
  "Cache-Control": "no-store, private, max-age=0",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
} as const;
const maxRequestBodyBytes = 1024 * 1024;

export interface ChatBridgeSendInput {
  prompt: string;
  sessionId: string;
}

export type PromptPersistence = "persisted" | "not_persisted" | "unknown";

export class ChatBridgePromptPersistenceUnknownError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ChatBridgePromptPersistenceUnknownError";
  }
}

export class ChatBridgeCommandOutcomeUnknownError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ChatBridgeCommandOutcomeUnknownError";
  }
}

class ChatBridgeRequestValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ChatBridgeRequestValidationError";
  }
}

export type ChatBridgeCommandInput =
  | { kind: "save_profile"; profile: DraftProfile }
  | { kind: "delete_profile"; profileId: string }
  | { kind: "activate_profile"; profileId: string }
  | { kind: "save_global_settings"; autoApprove: boolean }
  | { kind: "new_session" }
  | { kind: "select_session"; sessionId: string }
  | { kind: "restore_session"; sessionId: string }
  | { kind: "delete_session"; sessionId: string }
  | { kind: "rename_session"; sessionId: string; title: string }
  | { kind: "discover_models"; profile: DraftProfile };

export interface ChatBridgeConfirmationRequest {
  message: string;
  groups: ActionDiffGroup[];
}

export interface ChatBridgeStream {
  assistantDelta(delta: string): Promise<void>;
  sessionEvent(event: SessionEvent): Promise<void>;
  progress(message: string): Promise<void>;
  requestConfirmation(request: ChatBridgeConfirmationRequest): Promise<boolean>;
}

export interface ChatBridge {
  url: string;
  close(): Promise<void>;
}

interface ChatBridgeOptions {
  buildState(): Promise<ChatDialogState>;
  renderHtml(state: ChatDialogState, bridge: { baseUrl: string; token: string }): string;
  handleCommand(
    input: ChatBridgeCommandInput,
    signal: AbortSignal,
  ): Promise<ChatDialogState>;
  handleSend(
    input: ChatBridgeSendInput,
    stream: ChatBridgeStream,
    signal: AbortSignal,
  ): Promise<void>;
}

interface PendingConfirmation {
  sendId: string;
  sessionId: string;
  request: ChatBridgeConfirmationRequest;
  resolve(apply: boolean): void;
}

interface ActiveSend {
  sendId: string;
  sessionId: string;
  controller: AbortController;
}

type SsePayload =
  | { type: "assistant_delta"; sendId: string; sessionId: string; delta: string }
  | { type: "session_event"; sendId: string; sessionId: string; event: SessionEvent }
  | { type: "progress"; sendId: string; sessionId: string; message: string }
  | { type: "confirm_request"; sendId: string; sessionId: string; id: string; message: string; groups: ActionDiffGroup[] }
  | { type: "confirm_resolved"; sendId: string; sessionId: string; id: string }
  | { type: "state"; commandId: string; state: ChatDialogState }
  | { type: "done"; sendId: string; sessionId: string; state: ChatDialogState }
  | {
      type: "error";
      sendId?: string;
      sessionId?: string;
      commandId?: string;
      message: string;
      field?: string;
      promptPersistence?: PromptPersistence;
      commandOutcome?: "unknown";
      state?: ChatDialogState;
      reconciliationRequired?: boolean;
    };

export async function createChatBridge(
  options: ChatBridgeOptions,
): Promise<ChatBridge> {
  const token = randomUUID();
  const clients = new Set<ServerResponse>();
  const pendingConfirmations = new Map<string, PendingConfirmation>();
  const pendingRequestBodies = new Set<IncomingMessage>();
  const inFlightMutationHandlers = new Set<Promise<void>>();
  const readOnlyResponses = new Set<ServerResponse>();
  const activeSendsById = new Map<string, ActiveSend>();
  const activeSendsBySession = new Map<string, ActiveSend>();
  const sessionActivities = new Map<string, ChatSessionActivity>();
  let activeCommandAbort: AbortController | null = null;
  let activeCommandTerminal: Promise<void> | null = null;
  let closing = false;
  let closePromise: Promise<void> | null = null;

  const broadcast = (payload: SsePayload) => {
    if (closing) return;
    for (const client of clients) {
      if (client.writableEnded || client.destroyed) {
        clients.delete(client);
      } else {
        writeSse(client, payload);
      }
    }
  };

  const resolveAllConfirmations = (apply: boolean) => {
    for (const [id, pending] of pendingConfirmations) {
      pending.resolve(apply);
      broadcast({
        type: "confirm_resolved",
        sendId: pending.sendId,
        sessionId: pending.sessionId,
        id,
      });
    }
    pendingConfirmations.clear();
  };

  const resolveConfirmationsForSend = (sendId: string, apply: boolean) => {
    for (const [id, pending] of pendingConfirmations) {
      if (pending.sendId !== sendId) continue;
      pendingConfirmations.delete(id);
      pending.resolve(apply);
      broadcast({
        type: "confirm_resolved",
        sendId,
        sessionId: pending.sessionId,
        id,
      });
    }
  };

  const readRequestBody = async <T>(request: IncomingMessage): Promise<T> => {
    pendingRequestBodies.add(request);
    try {
      return await readJsonBody<T>(request);
    } finally {
      pendingRequestBodies.delete(request);
    }
  };

  const stateWithActivities = (state: ChatDialogState): ChatDialogState => {
    const activities = (state.sessions ?? [])
      .map((session) => sessionActivities.get(session.id))
      .filter((activity): activity is ChatSessionActivity => activity !== undefined);
    return activities.length || state.sessionActivities !== undefined
      ? { ...state, sessionActivities: activities }
      : state;
  };

  const buildBridgeState = async (): Promise<ChatDialogState> =>
    stateWithActivities(await options.buildState());

  const updateActivity = (
    sessionId: string,
    sendId: string,
    status: ChatSessionActivityStatus,
    update: { message?: string; unread?: boolean } = {},
  ) => {
    const current = sessionActivities.get(sessionId);
    const message = update.message ?? current?.message;
    sessionActivities.set(sessionId, {
      sessionId,
      sendId,
      status,
      ...(message === undefined ? {} : { message }),
      unread: update.unread ?? current?.unread ?? false,
    });
  };

  const createStream = (
    sendId: string,
    sessionId: string,
    onSessionEvent: (event: SessionEvent) => void,
  ): ChatBridgeStream => ({
    assistantDelta: async (delta) => {
      broadcast({ type: "assistant_delta", sendId, sessionId, delta });
    },
    sessionEvent: async (event) => {
      onSessionEvent(event);
      broadcast({ type: "session_event", sendId, sessionId, event });
    },
    progress: async (message) => {
      updateActivity(sessionId, sendId, "running", { message });
      broadcast({ type: "progress", sendId, sessionId, message });
    },
    requestConfirmation: (request) => {
      if (closing) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        const id = randomUUID();
        pendingConfirmations.set(id, { sendId, sessionId, request, resolve });
        updateActivity(sessionId, sendId, "waiting_confirmation", {
          message: "Waiting for confirmation",
        });
        broadcast({
          type: "confirm_request",
          sendId,
          sessionId,
          id,
          message: request.message,
          groups: request.groups,
        });
      });
    },
  });

  const server = createServer(async (request, response) => {
    let resolveHandlerTerminal!: () => void;
    const handlerTerminal = new Promise<void>((resolve) => {
      resolveHandlerTerminal = resolve;
    });
    let requestPath = "";
    let sendId: string | undefined;
    let sendSessionId: string | undefined;
    let commandId: string | undefined;
    let sendPromptPersistence: PromptPersistence | undefined;
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      requestPath = url.pathname;
      if (request.method === "POST" && requestPath === "/send") {
        sendPromptPersistence = "not_persisted";
      }
      if (closing) {
        sendJson(response, {
          error: "Live Smith bridge is closing.",
          ...(sendPromptPersistence ? { promptPersistence: sendPromptPersistence } : {}),
        }, 503);
        return;
      }

      if (url.searchParams.get("token") !== token) {
        if (sendPromptPersistence) {
          sendJson(response, {
            error: "Forbidden",
            promptPersistence: sendPromptPersistence,
          }, 403);
        } else {
          response.writeHead(403).end("Forbidden");
        }
        return;
      }

      if (request.method === "GET" && url.pathname === "/chat") {
        readOnlyResponses.add(response);
        const state = await buildBridgeState();
        if (closing || response.destroyed) return;
        sendHtml(
          response,
          options.renderHtml(state, { baseUrl: bridgeBaseUrl(server), token }),
        );
        return;
      }

      if (request.method === "GET" && url.pathname === "/state") {
        readOnlyResponses.add(response);
        while (activeCommandTerminal) await activeCommandTerminal;
        if (closing || response.destroyed) return;
        sendJson(response, await buildBridgeState());
        return;
      }

      if (request.method === "GET" && url.pathname === "/events") {
        response.writeHead(200, {
          ...sensitiveResponseHeaders,
          Connection: "keep-alive",
          "Content-Type": "text/event-stream",
        });
        response.write("\n");
        clients.add(response);
        for (const [id, pending] of pendingConfirmations) {
          writeSse(response, {
            type: "confirm_request",
            sendId: pending.sendId,
            sessionId: pending.sessionId,
            id,
            message: pending.request.message,
            groups: pending.request.groups,
          });
        }
        request.on("close", () => clients.delete(response));
        return;
      }

      if (request.method === "POST" && url.pathname === "/command") {
        commandId = commandIdForRequest(request);
        response.setHeader("X-Live-Smith-Command-Id", commandId);
        if (activeCommandTerminal) {
          sendJson(response, { error: "Another Live Smith operation is already in progress." }, 409);
          return;
        }
        inFlightMutationHandlers.add(handlerTerminal);
        activeCommandTerminal = handlerTerminal;
        const input = parseCommandInput(await readRequestBody<unknown>(request));
        if (closing) {
          sendJson(response, { error: "Live Smith bridge is closing." }, 503);
          return;
        }
        if (activeCommandTerminal !== handlerTerminal) {
          sendJson(response, { error: "Another Live Smith operation is already in progress." }, 409);
          return;
        }
        if (activeSendsBySession.size > 0 && !isCommandAllowedDuringSend(input)) {
          sendJson(response, {
            error: "Profile settings cannot change while an agent request is active.",
          }, 409);
          return;
        }
        if (
          input.kind === "delete_session" &&
          activeSendsBySession.has(input.sessionId)
        ) {
          sendJson(response, {
            error: "Stop this Session's active request before deleting it.",
          }, 409);
          return;
        }
        const controller = createHostAbortController();
        activeCommandAbort = controller;
        try {
          const commandState = await options.handleCommand(input, controller.signal);
          if (input.kind === "select_session") {
            const activity = sessionActivities.get(input.sessionId);
            if (activity) activity.unread = false;
          } else if (input.kind === "delete_session") {
            sessionActivities.delete(input.sessionId);
          }
          const state = stateWithActivities(commandState);
          broadcast({ type: "state", commandId, state });
          sendJson(response, state);
        } finally {
          if (activeCommandAbort === controller) activeCommandAbort = null;
        }
        return;
      }

      if (request.method === "POST" && url.pathname === "/send") {
        sendId = sendIdForRequest(request);
        if (activeCommandTerminal) {
          sendJson(response, {
            error: "Another Live Smith operation is already in progress.",
            promptPersistence: "not_persisted",
          }, 409);
          return;
        }
        const input = parseSendInput(await readRequestBody<unknown>(request));
        sendSessionId = input.sessionId;
        if (closing) {
          sendJson(response, {
            error: "Live Smith bridge is closing.",
            promptPersistence: "not_persisted",
          }, 503);
          return;
        }
        if (activeCommandTerminal) {
          sendJson(response, {
            error: "Another Live Smith operation is already in progress.",
            promptPersistence: "not_persisted",
          }, 409);
          return;
        }
        if (
          activeSendsBySession.has(input.sessionId) ||
          activeSendsById.has(sendId)
        ) {
          sendJson(response, {
            error: activeSendsBySession.has(input.sessionId)
              ? "This Session already has an active agent request."
              : "That send correlation ID is already active.",
            promptPersistence: "not_persisted",
          }, 409);
          return;
        }
        inFlightMutationHandlers.add(handlerTerminal);
        const controller = createHostAbortController();
        const activeSend = {
          sendId,
          sessionId: input.sessionId,
          controller,
        };
        activeSendsById.set(sendId, activeSend);
        activeSendsBySession.set(input.sessionId, activeSend);
        updateActivity(input.sessionId, sendId, "running", {
          message: "Starting agent loop",
          unread: false,
        });
        try {
          const stream = createStream(sendId, input.sessionId, (event) => {
            if (event.kind === "user") sendPromptPersistence = "persisted";
          });
          await options.handleSend(input, stream, controller.signal);
          const baseState = await options.buildState();
          updateActivity(input.sessionId, sendId, "completed", {
            message: "Completed",
            unread: baseState.activeSessionId !== input.sessionId,
          });
          const state = stateWithActivities(baseState);
          broadcast({
            type: "done",
            sendId,
            sessionId: input.sessionId,
            state,
          });
          sendJson(response, { ok: true });
        } finally {
          if (activeSendsById.get(sendId) === activeSend) {
            activeSendsById.delete(sendId);
          }
          if (activeSendsBySession.get(input.sessionId) === activeSend) {
            activeSendsBySession.delete(input.sessionId);
          }
        }
        return;
      }

      if (request.method === "POST" && url.pathname === "/confirm") {
        const input = parseConfirmationInput(
          await readRequestBody<unknown>(request),
        );
        if (closing) {
          sendJson(response, { error: "Live Smith bridge is closing." }, 503);
          return;
        }
        const pending = pendingConfirmations.get(input.id);
        if (pending) {
          pendingConfirmations.delete(input.id);
          const apply = input.apply === true;
          pending.resolve(apply);
          updateActivity(pending.sessionId, pending.sendId, "running", {
            message: apply ? "Applying confirmed changes" : "Continuing after cancellation",
          });
          broadcast({
            type: "confirm_resolved",
            sendId: pending.sendId,
            sessionId: pending.sessionId,
            id: input.id,
          });
        }
        sendJson(response, { ok: true });
        return;
      }

      if (request.method === "POST" && url.pathname === "/stop") {
        const stoppedSendId = stopSendIdForRequest(request);
        assertOnlyInputKeys(
          inputRecord(await readRequestBody<unknown>(request)),
          [],
          "Stop request",
        );
        const activeSend = activeSendsById.get(stoppedSendId);
        if (activeSend) {
          resolveConfirmationsForSend(stoppedSendId, false);
          updateActivity(activeSend.sessionId, stoppedSendId, "stopped", {
            message: "Stopped",
          });
          activeSend.controller.abort(new Error("Stopped by user."));
        }
        sendJson(response, {
          ok: true,
          terminal: !activeSendsById.has(stoppedSendId),
          sendId: stoppedSendId,
        });
        return;
      }

      response.writeHead(404).end("Not found");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const field = error instanceof ProfileValidationError
        ? error.field
        : undefined;
      const promptPersistence = requestPath === "/send"
        ? sendPromptPersistence === "persisted"
          ? "persisted"
          : error instanceof ChatBridgePromptPersistenceUnknownError
            ? "unknown"
            : sendPromptPersistence ?? "not_persisted"
        : undefined;
      const commandOutcome = requestPath === "/command" &&
          (
            isStorageCommitOutcomeUnknownError(error) ||
            error instanceof ChatBridgeCommandOutcomeUnknownError
          )
        ? "unknown" as const
        : undefined;
      let commandState: ChatDialogState | undefined;
      let sendErrorState: ChatDialogState | undefined;
      let reconciliationRequired: true | undefined;
      if (commandOutcome === "unknown") {
        try {
          commandState = await buildBridgeState();
        } catch {
          reconciliationRequired = true;
        }
      }
      if (requestPath === "/send" && sendId && sendSessionId) {
        const activity = sessionActivities.get(sendSessionId);
        if (activity?.status !== "stopped") {
          updateActivity(sendSessionId, sendId, "failed", { message });
        }
        try {
          const baseState = await options.buildState();
          const failedActivity = sessionActivities.get(sendSessionId);
          if (failedActivity) {
            failedActivity.unread = baseState.activeSessionId !== sendSessionId;
          }
          sendErrorState = stateWithActivities(baseState);
        } catch {
          // Preserve the original send error if state cannot also be refreshed.
        }
      }
      if (requestPath !== "/send" || sendId !== undefined) {
        broadcast({
          type: "error",
          ...(sendId === undefined ? {} : { sendId }),
          ...(sendSessionId === undefined ? {} : { sessionId: sendSessionId }),
          ...(commandId === undefined ? {} : { commandId }),
          message,
          ...(field === undefined ? {} : { field }),
          ...(promptPersistence === undefined ? {} : { promptPersistence }),
          ...(commandOutcome === undefined ? {} : { commandOutcome }),
          ...(sendErrorState !== undefined
            ? { state: sendErrorState }
            : commandState === undefined
              ? {}
              : { state: commandState }),
          ...(reconciliationRequired === undefined
            ? {}
            : { reconciliationRequired }),
        });
      }
      sendJson(
        response,
        {
          error: message,
          ...(commandId === undefined ? {} : { commandId }),
          ...(field === undefined ? {} : { field }),
          ...(promptPersistence === undefined ? {} : { promptPersistence }),
          ...(commandOutcome === undefined ? {} : { commandOutcome }),
          ...(commandState === undefined ? {} : { state: commandState }),
          ...(reconciliationRequired === undefined
            ? {}
            : { reconciliationRequired }),
        },
        field !== undefined || error instanceof ChatBridgeRequestValidationError
          ? 400
          : 500,
      );
    } finally {
      if (activeCommandTerminal === handlerTerminal) activeCommandTerminal = null;
      inFlightMutationHandlers.delete(handlerTerminal);
      readOnlyResponses.delete(response);
      resolveHandlerTerminal();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    url: `${bridgeBaseUrl(server)}/chat?token=${token}`,
    close: () => {
      if (closePromise) return closePromise;
      closing = true;
      const mutationTerminals = [...inFlightMutationHandlers];
      const pendingReads = [...readOnlyResponses];
      const connectedClients = [...clients];
      clients.clear();
      readOnlyResponses.clear();
      for (const request of pendingRequestBodies) request.destroy();
      pendingRequestBodies.clear();
      resolveAllConfirmations(false);
      for (const activeSend of activeSendsById.values()) {
        activeSend.controller.abort(new Error("Live Smith window closed."));
      }
      activeCommandAbort?.abort(new Error("Live Smith window closed."));
      for (const response of pendingReads) response.destroy();
      for (const client of connectedClients) client.end();

      closePromise = (async () => {
        await Promise.allSettled(mutationTerminals);
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) reject(error);
            else resolve();
          });
          server.closeAllConnections();
        });
      })();
      return closePromise;
    },
  };
}

function sendIdForRequest(request: IncomingMessage): string {
  const raw = request.headers["x-live-smith-send-id"];
  if (raw === undefined) return randomUUID();
  if (
    typeof raw !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(raw)
  ) {
    throw new ChatBridgeRequestValidationError(
      "X-Live-Smith-Send-Id must be a valid correlation ID.",
    );
  }
  return raw;
}

function stopSendIdForRequest(request: IncomingMessage): string {
  const raw = request.headers["x-live-smith-send-id"];
  if (
    typeof raw !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(raw)
  ) {
    throw new ChatBridgeRequestValidationError(
      "X-Live-Smith-Send-Id must identify the send to stop.",
    );
  }
  return raw;
}

function commandIdForRequest(request: IncomingMessage): string {
  const raw = request.headers["x-live-smith-command-id"];
  if (raw === undefined) return randomUUID();
  if (
    typeof raw !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(raw)
  ) {
    throw new ChatBridgeRequestValidationError(
      "X-Live-Smith-Command-Id must be a valid correlation ID.",
    );
  }
  return raw;
}

function writeSse(response: ServerResponse, payload: SsePayload): void {
  if (response.writableEnded || response.destroyed) return;
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function bridgeBaseUrl(server: ReturnType<typeof createServer>): string {
  const address = server.address() as AddressInfo | null;
  if (!address) {
    throw new Error("Chat bridge has not started.");
  }
  return `http://127.0.0.1:${address.port}`;
}

function sendHtml(response: ServerResponse, html: string): void {
  if (response.writableEnded || response.destroyed) return;
  response.writeHead(200, {
    ...sensitiveResponseHeaders,
    "Content-Type": "text/html; charset=utf-8",
  });
  response.end(html);
}

function sendJson(
  response: ServerResponse,
  payload: unknown,
  status = 200,
): void {
  if (response.writableEnded || response.destroyed) return;
  response.writeHead(status, {
    ...sensitiveResponseHeaders,
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}

export async function readJsonBody<T>(
  request: AsyncIterable<string | Uint8Array>,
): Promise<T> {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += buffer.byteLength;
    if (byteLength > maxRequestBodyBytes) {
      throw new ChatBridgeRequestValidationError(
        `Request body exceeds ${maxRequestBodyBytes} bytes.`,
      );
    }
    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return (raw ? JSON.parse(raw) : {}) as T;
  } catch (cause) {
    throw new ChatBridgeRequestValidationError(
      "Request body must contain valid JSON.",
      { cause },
    );
  }
}

function parseSendInput(value: unknown): ChatBridgeSendInput {
  const input = inputRecord(value);
  assertOnlyInputKeys(input, ["prompt", "sessionId"], "Send request");
  return {
    prompt: inputString(input, "prompt"),
    sessionId: inputString(input, "sessionId"),
  };
}

function parseCommandInput(value: unknown): ChatBridgeCommandInput {
  const input = inputRecord(value);
  const kind = inputString(input, "kind");
  if (kind === "save_profile" || kind === "discover_models") {
    assertOnlyInputKeys(input, ["kind", "profile"], `${kind} command`);
    if (!isRecord(input.profile)) {
      throw new ChatBridgeRequestValidationError("profile must be an object.");
    }
    return { kind, profile: input.profile as unknown as DraftProfile };
  }
  if (kind === "delete_profile" || kind === "activate_profile") {
    assertOnlyInputKeys(input, ["kind", "profileId"], `${kind} command`);
    return { kind, profileId: inputString(input, "profileId") };
  }
  if (kind === "save_global_settings") {
    assertOnlyInputKeys(input, ["kind", "autoApprove"], `${kind} command`);
    if (typeof input.autoApprove !== "boolean") {
      throw new ChatBridgeRequestValidationError("autoApprove must be a boolean.");
    }
    return { kind, autoApprove: input.autoApprove };
  }
  if (kind === "new_session") {
    assertOnlyInputKeys(input, ["kind"], `${kind} command`);
    return { kind };
  }
  if (
    kind === "select_session" ||
    kind === "restore_session" ||
    kind === "delete_session"
  ) {
    assertOnlyInputKeys(input, ["kind", "sessionId"], `${kind} command`);
    return { kind, sessionId: inputString(input, "sessionId") };
  }
  if (kind === "rename_session") {
    assertOnlyInputKeys(
      input,
      ["kind", "sessionId", "title"],
      `${kind} command`,
    );
    return {
      kind,
      sessionId: inputString(input, "sessionId"),
      title: inputString(input, "title"),
    };
  }
  throw new ChatBridgeRequestValidationError(`Unsupported command ${kind}.`);
}

function parseConfirmationInput(
  value: unknown,
): { id: string; apply: boolean } {
  const input = inputRecord(value);
  assertOnlyInputKeys(input, ["id", "apply"], "Confirmation request");
  const id = inputString(input, "id");
  if (!id.trim()) {
    throw new ChatBridgeRequestValidationError("id must be a non-empty string.");
  }
  if (typeof input.apply !== "boolean") {
    throw new ChatBridgeRequestValidationError("apply must be a boolean.");
  }
  return { id, apply: input.apply };
}

function isSessionCommand(input: ChatBridgeCommandInput): boolean {
  return input.kind === "new_session" ||
    input.kind === "select_session" ||
    input.kind === "restore_session" ||
    input.kind === "delete_session" ||
    input.kind === "rename_session";
}

function isCommandAllowedDuringSend(input: ChatBridgeCommandInput): boolean {
  return isSessionCommand(input) || input.kind === "save_global_settings";
}

function inputRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ChatBridgeRequestValidationError("Request body must be an object.");
  }
  return value;
}

function inputString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new ChatBridgeRequestValidationError(`${key} must be a string.`);
  }
  return value;
}

function assertOnlyInputKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(record).find((key) => !allowedKeys.has(key));
  if (unknown) {
    throw new ChatBridgeRequestValidationError(
      `${label} does not support property ${unknown}.`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
