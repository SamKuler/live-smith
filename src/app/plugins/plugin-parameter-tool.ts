import { createRequestPluginTools, type PluginExecutionAuthorization } from "./request-plugin-tools.js";
import { validatePluginParameters } from "../../plugins/parameter-panel.js";
import { appendSessionEvent } from "../../storage/events.js";
import { throwIfAborted } from "../../runtime/host.js";
import { ChatBridgeConflictError, ChatBridgeRequestValidationError } from "../chat/chat-bridge-http.js";
import { ChatBridgeCommandOutcomeUnknownError } from "../chat/chat-bridge.js";

export async function runPluginParameterTool(input: {
  storageDirectory: string | undefined;
  sessionId: string;
  toolName: string;
  signature: string;
  arguments: Record<string, unknown>;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
  withPluginAuthorization: PluginExecutionAuthorization;
}): Promise<{ failed: boolean }> {
  const tools = await createRequestPluginTools({
    storageDirectory: input.storageDirectory,
    sessionId: input.sessionId,
    signal: input.signal,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    withAuthorization: input.withPluginAuthorization,
  });
  try {
    const tool = tools.catalogTools().find((entry) => entry.panel?.toolName === input.toolName);
    if (!tool?.panel || tool.panel.signature !== input.signature) {
      throw new ChatBridgeConflictError("This tool's parameters or connection changed. Reload tools and open its parameters again.");
    }
    let args;
    try { args = validatePluginParameters(tool.panel, input.arguments); }
    catch (error) {
      throw new ChatBridgeRequestValidationError(error instanceof Error ? error.message : "Invalid Plugin parameters.");
    }
    throwIfAborted(input.signal);
    await appendSessionEvent(input.storageDirectory, input.sessionId, {
      kind: "tool_call", name: input.toolName, content: JSON.stringify(args),
    });
    let result;
    try {
      result = await tools.callTool({ id: "parameter-panel", name: input.toolName, arguments: JSON.stringify(args) });
    } catch (error) {
      await appendSessionEvent(input.storageDirectory, input.sessionId, {
        kind: "tool_result", name: input.toolName,
        content: "The tool did not return a confirmed result. Check the server's state before running it again.",
      }).catch(() => undefined);
      throw new ChatBridgeCommandOutcomeUnknownError(
        "The tool did not return a confirmed result. Check the server's state and Session artifacts before running it again.",
        { cause: error },
      );
    }
    try {
      await appendSessionEvent(input.storageDirectory, input.sessionId, {
        kind: "tool_result", name: input.toolName, content: result.content,
              ...(result.artifacts ? { artifacts: result.artifacts } : {}),
      });
    } catch (cause) {
      throw new ChatBridgeCommandOutcomeUnknownError(
        "The tool returned, but its result could not be saved. Check the server and Session artifacts before running it again.",
        { cause },
      );
    }
    if (result.outcomeUnknown) {
      throw new ChatBridgeCommandOutcomeUnknownError(
        "The tool did not return a confirmed result. Check the server's state and Session artifacts before running it again.",
      );
    }
    return { failed: result.failed === true };
  } finally {
    await tools.close();
  }
}
