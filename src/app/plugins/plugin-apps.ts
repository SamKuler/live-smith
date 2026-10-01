import { Buffer } from "node:buffer";
import { appResourceDocument } from "../../plugins/mcp/apps.js";
import { configRecord } from "../../plugins/user-config.js";
import { createHostAbortController, throwIfAborted } from "../../runtime/host.js";
import { appendSessionEvent, loadSessionEvents } from "../../storage/events.js";
import { inspectMidiArtifacts } from "../../storage/midi-artifacts.js";
import { MAX_PLUGIN_MCP_MESSAGE_BYTES, type PluginToolResult } from "../../plugins/contracts.js";
import { appToolResultWithArtifacts, createRequestPluginTools, type PluginExecutionAuthorization, type RequestPluginTools } from "./request-plugin-tools.js";
import { ChatBridgeConflictError, ChatBridgeRequestValidationError } from "../chat/chat-bridge-http.js";

// A page cursor may occupy its whole MCP frame; allow the instance ID and JSON envelope as well.
export const MAX_PLUGIN_APP_PAGE_REQUEST_BYTES = MAX_PLUGIN_MCP_MESSAGE_BYTES + 256;

export type PluginAppRequest =
  | { operation: "open"; id: string; sessionId: string; toolName: string; signature: string }
  | { operation: "call"; id: string; name: string; arguments: Record<string, unknown> }
  | { operation: "resource"; id: string; uri: string }
  | { operation: "resources"; id: string; cursor?: string }
  | { operation: "resource-templates"; id: string; cursor?: string }
  | { operation: "close"; id: string };

export function parsePluginAppRequest(operation: string, value: unknown): PluginAppRequest {
  const fail = () => { throw new ChatBridgeRequestValidationError("Plugin app request is invalid."); };
  if (!configRecord(value)) return fail();
  const keys = operation === "open" ? ["id", "sessionId", "toolName", "signature"] : operation === "call"
    ? ["id", "name", "arguments"] : operation === "resource" ? ["id", "uri"]
    : operation === "resources" || operation === "resource-templates" ? ["id", "cursor"] : operation === "close" ? ["id"] : undefined;
  if (!keys || Object.keys(value).some((key) => !keys.includes(key))) return fail();
  if (typeof value.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(value.id)) return fail();
  if (operation === "open") {
    if (typeof value.sessionId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(value.sessionId) ||
        typeof value.toolName !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(value.toolName) ||
        typeof value.signature !== "string" || !/^[a-f0-9]{64}$/u.test(value.signature)) return fail();
    return { operation, id: value.id, sessionId: value.sessionId, toolName: value.toolName, signature: value.signature };
  }
  if (operation === "close") return { operation, id: value.id };
  if (operation === "resources" || operation === "resource-templates") {
    if (value.cursor !== undefined && typeof value.cursor !== "string") return fail();
    return { operation, id: value.id, ...(typeof value.cursor === "string" ? { cursor: value.cursor } : {}) };
  }
  if (operation === "resource") {
    if (typeof value.uri !== "string" || !value.uri || value.uri.length > 2048 || /[\s\u0000-\u001f]/u.test(value.uri)) return fail();
    return { operation, id: value.id, uri: value.uri };
  }
  if (operation !== "call" || typeof value.name !== "string" || !value.name || value.name.length > 128 ||
      /[\u0000-\u001f]/u.test(value.name) || value.arguments !== undefined && !configRecord(value.arguments) ||
      Buffer.byteLength(JSON.stringify(value.arguments ?? {}), "utf8") > 64 * 1024) return fail();
  return { operation, id: value.id, name: value.name, arguments: (value.arguments ?? {}) as Record<string, unknown> };
}

interface AppSession {
  sessionId: string;
  toolName: string;
  tools?: RequestPluginTools;
  opening?: Promise<unknown>;
  controller: AbortController;
}

/** Retains a server connection for one open UI; every operation still rechecks admission. */
export function createPluginAppSessions(input: {
  storageDirectory: string | undefined;
  fetchImpl: typeof fetch;
  withAuthorization: PluginExecutionAuthorization;
  validateSession(sessionId: string, signal: AbortSignal): Promise<void>;
  mutateSession<T>(sessionId: string, signal: AbortSignal, operation: () => Promise<T>): Promise<T>;
  sessionChanged(sessionId: string): void;
}) {
  const sessions = new Map<string, AppSession>();
  let closed = false;
  const close = async (id: string) => {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    session.controller.abort(new Error("Plugin app closed."));
    await session.opening?.catch(() => undefined);
    await session.tools?.close();
  };
  const open = (request: Extract<PluginAppRequest, { operation: "open" }>, signal: AbortSignal) => {
    if (sessions.has(request.id)) throw new ChatBridgeConflictError("Plugin app is already open.");
    if (sessions.size >= 4) throw new ChatBridgeConflictError("Close a Plugin app before opening another.");
    const controller = createHostAbortController();
    const app: AppSession = { sessionId: request.sessionId, toolName: request.toolName, controller };
    sessions.set(request.id, app);
    const cancel = () => controller.abort(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
    app.opening = (async () => {
      let tools: RequestPluginTools | undefined;
      try {
        await input.validateSession(request.sessionId, controller.signal);
        throwIfAborted(controller.signal);
        tools = await createRequestPluginTools({ storageDirectory: input.storageDirectory, sessionId: request.sessionId,
          signal: controller.signal, fetchImpl: input.fetchImpl, withAuthorization: input.withAuthorization });
        const owner = tools.catalogTools().find((tool) => tool.app?.toolName === request.toolName);
        if (!owner?.app || owner.app.signature !== request.signature) throw new ChatBridgeConflictError("Plugin app changed. Reload tools before opening it.");
        const resource = appResourceDocument(await tools.readAppResource(request.toolName, owner.app.resourceUri, controller.signal), owner.app.resourceUri);
        const history = await recentAppToolResult(input.storageDirectory, request.sessionId, request.toolName);
        throwIfAborted(controller.signal);
        await input.validateSession(request.sessionId, controller.signal);
        throwIfAborted(controller.signal);
        if (closed) throw new ChatBridgeConflictError("Plugin apps are closed.");
        app.tools = tools;
        return { id: request.id, toolName: owner.name, resourceUri: owner.app.resourceUri, ...resource, ...history };
      } catch (error) {
        if (sessions.get(request.id) === app) sessions.delete(request.id);
        controller.abort();
        await tools?.close();
        throw error;
      } finally {
        signal.removeEventListener("abort", cancel);
        delete app.opening;
      }
    })();
    return app.opening;
  };
  return {
    async request(request: PluginAppRequest, signal: AbortSignal): Promise<unknown> {
      throwIfAborted(signal);
      if (closed) throw new ChatBridgeConflictError("Plugin apps are closed.");
      if (request.operation === "close") { await close(request.id); return {}; }
      if (request.operation === "open") return open(request, signal);
      const app = sessions.get(request.id);
      if (!app?.tools || app.opening) throw new ChatBridgeConflictError("Plugin app is no longer open.");
      const tools = app.tools;
      await input.validateSession(app.sessionId, signal);
      const controller = createHostAbortController();
      const abort = () => controller.abort(new Error("Plugin app operation stopped."));
      signal.addEventListener("abort", abort, { once: true });
      app.controller.signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted || app.controller.signal.aborted) abort();
      try {
        if (request.operation === "resource") return await tools.readAppResource(app.toolName, request.uri, controller.signal);
        if (request.operation === "resources" || request.operation === "resource-templates") {
          return await tools.listAppResources(app.toolName, request.operation === "resource-templates", request.cursor, controller.signal);
        }
        return await input.mutateSession(app.sessionId, controller.signal, async () => {
          await input.validateSession(app.sessionId, controller.signal);
          const definition = tools.appTool(app.toolName, request.name);
          throwIfAborted(controller.signal);
          await appendSessionEvent(input.storageDirectory, app.sessionId, {
            kind: "tool_call", name: definition.tool.function.name, content: JSON.stringify(request.arguments),
          });
          try {
            const result = await tools.callAppTool(app.toolName, request.name, request.arguments, controller.signal);
            if (result.history.outcomeUnknown) throw new Error("Plugin App tool outcome is unconfirmed.");
            await appendSessionEvent(input.storageDirectory, app.sessionId, {
              kind: "tool_result", name: definition.tool.function.name, content: result.history.content,
            });
            return result.result;
          } catch {
            await appendSessionEvent(input.storageDirectory, app.sessionId, {
              kind: "tool_result", name: definition.tool.function.name,
              content: "The Plugin app tool did not return a confirmed result. Check its state before retrying.",
            }).catch(() => undefined);
            throw new ChatBridgeConflictError("The Plugin app tool outcome is unconfirmed. Check its state before retrying.");
          } finally { input.sessionChanged(app.sessionId); }
        });
      } finally {
        signal.removeEventListener("abort", abort);
        app.controller.signal.removeEventListener("abort", abort);
      }
    },
    async close() {
      closed = true;
      await Promise.allSettled([...sessions.keys()].map(close));
    },
  };
}

async function recentAppToolResult(storageDirectory: string | undefined, sessionId: string, toolName: string): Promise<{
  toolInput?: Record<string, unknown>; toolResult?: PluginToolResult;
}> {
  const events = await loadSessionEvents(storageDirectory, sessionId);
  const index = events.findLastIndex((event) => event.kind === "tool_call" && event.name === toolName);
  if (index < 0) return {};
  try {
    const args: unknown = JSON.parse(events[index]!.content);
    if (!configRecord(args)) return {};
    const resultEvent = events.slice(index + 1).find((event) => event.kind === "tool_result" && event.name === toolName);
    const result: unknown = resultEvent ? JSON.parse(resultEvent.content) : undefined;
    const artifactRefs = configRecord(result) && Array.isArray(result.artifacts)
      ? new Set(result.artifacts.filter(configRecord).map((artifact) => artifact.artifactRef)) : new Set();
    const artifacts = artifactRefs.size
      ? (await inspectMidiArtifacts(storageDirectory, sessionId)).artifacts.filter((artifact) => artifactRefs.has(artifact.id)) : [];
    return { toolInput: args, ...(configRecord(result) && Array.isArray(result.content) ? { toolResult: appToolResultWithArtifacts({
      content: result.content,
      ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
      ...(typeof result.isError === "boolean" ? { isError: result.isError } : {}),
    }, artifacts) } : {}) };
  } catch { return {}; }
}
