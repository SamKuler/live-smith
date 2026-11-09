import { randomUUID } from "node:crypto";
import type { AgentLoopTraceEvent } from "../../agent/tool-execution.js";
import { toolOperationFinished, type ExternalToolActor, type ToolOperationOutput, type ToolOperationSnapshot } from "../../agent/tool-operation.js";
import { cloneJsonValue } from "../../model/json-clone.js";
import { createHostAbortController, throwIfAborted, waitForPromiseWithSignal } from "../../runtime/host.js";
import { appendSessionEvent, loadSessionOperationSnapshots, loadSessionOperationSnapshot } from "../../storage/events.js";
import type { ChatBridgeConfirmationRequest } from "../chat/chat-bridge.js";
import { invalidateSessionState } from "../session/session-state-events.js";
import { appendAgentLoopTraceEvent } from "./tool-events.js";
import { formatUiMessage, uiMessage, type UiMessage } from "../../i18n/ui-message.js";

export interface ToolOperationContext {
  operationId: string;
  signal: AbortSignal;
  onProgress(message: UiMessage): void;
  onEvent(event: AgentLoopTraceEvent): Promise<void>;
  requestApproval(request: ChatBridgeConfirmationRequest): Promise<boolean>;
}
interface ActiveOperation {
  sessionId: string;
  snapshot: ToolOperationSnapshot;
  controller: AbortController;
  completion: Promise<void>;
  approval?: { request: ChatBridgeConfirmationRequest; resolve(approved: boolean): void };
}

/** Accepted work belongs to the Session, independently of an HTTP connection or window. */
export class ToolOperations {
  private readonly active = new Map<string, ActiveOperation>();
  private readonly source = Symbol("external-tool-operations");
  private closed = false;
  constructor(private readonly storageDirectory: string, private readonly onApproval?: (sessionId: string) => Promise<void>) {}

  async start(sessionId: string, actor: ExternalToolActor, toolName: string,
    execute: (context: ToolOperationContext) => Promise<ToolOperationOutput>): Promise<ToolOperationSnapshot> {
    if (this.closed) throw new Error("MCP service is closed.");
    if (this.active.size >= 64) throw new Error("Too many external operations are pending. Finish or cancel existing work.");
    let finish!: () => void;
    const completion = new Promise<void>(resolve => { finish = resolve; });
    const operation: ActiveOperation = { sessionId, controller: createHostAbortController(), completion,
      snapshot: { id: randomUUID(), actor: { ...actor }, toolName, status: "running", progress: uiMessage("Starting tool") } };
    this.active.set(operation.snapshot.id, operation);
    try { await this.persist(operation); }
    catch (error) { this.active.delete(operation.snapshot.id); finish(); throw error; }
    const { signal } = operation.controller;
    void Promise.resolve().then(async () => {
      try {
        throwIfAborted(signal);
        const result = await execute({ operationId: operation.snapshot.id, signal,
          onProgress: message => {
            const text = formatUiMessage(message);
            operation.snapshot.progress = text.length > 4096 ? text.slice(0, 4096) : cloneJsonValue(message);
            this.notify(sessionId);
          },
          onEvent: async event => { await appendAgentLoopTraceEvent(this.storageDirectory, sessionId, event,
            (directory, id, input) => appendSessionEvent(directory, id, { ...input, toolActor: actor, toolOperationId: operation.snapshot.id }));
            this.notify(sessionId); },
          requestApproval: async request => {
            throwIfAborted(signal);
            const decision = new Promise<boolean>(resolve => { operation.approval = { request: cloneJsonValue(request), resolve }; });
            operation.snapshot.status = "awaiting_approval";
            operation.snapshot.progress = uiMessage("Waiting for confirmation in Live Smith");
            await this.persist(operation);
            if (this.onApproval) void this.onApproval(sessionId).catch(() => {
              operation.snapshot.progress = uiMessage("Open this Session in Live Smith to review the pending operation."); this.notify(sessionId);
            });
            try {
              const approved = await waitForPromiseWithSignal(decision, signal);
              delete operation.approval;
              operation.snapshot.status = "running";
              await this.persist(operation);
              return approved;
            } finally { delete operation.approval; }
          },
        });
        operation.snapshot.result = result;
        operation.snapshot.status = result.failed ? "failed" : signal.aborted || result.cancelled ? "cancelled" : "completed";
      } catch {
        operation.snapshot.status = signal.aborted ? "cancelled" : "failed";
        operation.snapshot.result = { failed: true,
          content: signal.aborted ? "Operation stopped. Review recorded results before retrying." : "Tool execution could not be confirmed. Review this Session's results before retrying.",
          outcomeUnknown: true };
      } finally {
        delete operation.approval;
        operation.snapshot.progress = uiMessage(operation.snapshot.status === "completed" ? "Completed" : operation.snapshot.status === "cancelled" ? "Stopped" : "Failed");
        try { await this.persist(operation); this.active.delete(operation.snapshot.id); }
        catch { operation.snapshot.status = "interrupted"; this.notify(sessionId); }
      }
    }).finally(finish);
    return cloneJsonValue(operation.snapshot);
  }

  async list(sessionId: string): Promise<ToolOperationSnapshot[]> {
    const snapshots = new Map<string, ToolOperationSnapshot>();
    const activeIds = [...this.active.values()].filter(operation => operation.sessionId === sessionId).map(operation => operation.snapshot.id);
    for (const snapshot of await loadSessionOperationSnapshots(this.storageDirectory, sessionId, 20, activeIds)) snapshots.set(snapshot.id, snapshot);
    for (const operation of this.active.values()) if (operation.sessionId === sessionId) snapshots.set(operation.snapshot.id, operation.snapshot);
    return [...snapshots.values()].reverse().slice(0, 20).map(snapshot => {
      const copy = cloneJsonValue(snapshot);
      if (!this.active.has(copy.id) && !toolOperationFinished(copy.status)) interruptSnapshot(copy);
      return copy;
    });
  }
  async read(sessionId: string, id: string): Promise<ToolOperationSnapshot> {
    const active = this.active.get(id);
    if (active?.sessionId === sessionId) return cloneJsonValue(active.snapshot);
    const snapshot = await loadSessionOperationSnapshot(this.storageDirectory, sessionId, id);
    if (!snapshot) throw new Error("Operation is unavailable in this Session.");
    const copy = cloneJsonValue(snapshot);
    if (!toolOperationFinished(copy.status)) interruptSnapshot(copy);
    return copy;
  }
  approvals(sessionId: string) {
    return [...this.active.values()].filter(entry => entry.sessionId === sessionId && entry.approval).map(entry => ({
      operationId: entry.snapshot.id, actor: { ...entry.snapshot.actor }, request: cloneJsonValue(entry.approval!.request),
    }));
  }
  resolveApproval(sessionId: string, id: string, approved: boolean): void {
    const active = this.active.get(id);
    if (!active || active.sessionId !== sessionId || !active.approval) throw new Error("This approval is no longer pending.");
    const { resolve } = active.approval; delete active.approval; resolve(approved);
  }
  async cancel(sessionId: string, id: string): Promise<ToolOperationSnapshot> {
    const active = this.active.get(id);
    if (active?.sessionId === sessionId && !toolOperationFinished(active.snapshot.status)) active.controller.abort();
    return this.read(sessionId, id);
  }
  async cancelActor(clientId: string): Promise<void> {
    const entries = [...this.active.values()].filter(entry => entry.snapshot.actor.clientId === clientId);
    for (const entry of entries) entry.controller.abort();
    await Promise.all(entries.map(entry => entry.completion));
  }
  async wait(id: string): Promise<void> { await this.active.get(id)?.completion; }
  async close(): Promise<void> {
    this.closed = true;
    for (const entry of this.active.values()) entry.controller.abort();
    await Promise.all([...this.active.values()].map(entry => entry.completion));
  }
  private notify(sessionId: string) { invalidateSessionState(this.storageDirectory, { sessionId, source: this.source }); }
  private async persist(operation: ActiveOperation) {
    await appendSessionEvent(this.storageDirectory, operation.sessionId, { kind: "operation", content: formatUiMessage(operation.snapshot.progress),
      operation: cloneJsonValue(operation.snapshot) });
    this.notify(operation.sessionId);
  }
}

function interruptSnapshot(snapshot: ToolOperationSnapshot): void {
  snapshot.status = "interrupted";
  snapshot.progress = uiMessage("Host restarted before completion was confirmed.");
  snapshot.result = { content: formatUiMessage(snapshot.progress), failed: true, outcomeUnknown: true };
}
