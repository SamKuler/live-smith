import type { PersistedSessionAttachmentRef } from "../../storage/attachments.js";
import type { ChatBridgeState } from "../chat-state.js";
import { createLocaleBindings } from "./locale-bindings.js";

interface Dependencies {
  getState(): Pick<ChatBridgeState, "activeSessionId" | "events" | "pendingAttachments">;
  attachmentViewer: {
    open(sessionId: string, attachment: PersistedSessionAttachmentRef): Promise<void>;
    reuse(sessionId: string, attachment: PersistedSessionAttachmentRef): Promise<void>;
  };
  isReuseBlocked(): boolean;
}

interface Entry {
  attachment: PersistedSessionAttachmentRef;
  pending: boolean;
}

function attachmentKey(attachment: PersistedSessionAttachmentRef): string {
  const provenance = attachment.provenance;
  return JSON.stringify([
    attachment.sha256, attachment.fileName, attachment.kind, attachment.mediaType,
    ...(provenance?.startSeconds === undefined
      ? []
      : [provenance.sourceId, provenance.startSeconds, provenance.endSeconds]),
  ]);
}

export function createSessionAttachments({ getState, attachmentViewer, isReuseBlocked }: Dependencies) {
  const rows = new Map<string, {
    element: HTMLLIElement;
    update(entry: Entry, blocked: boolean): void;
  }>();
  let owner: string | undefined;
  let snapshot: ReturnType<Dependencies["getState"]> | undefined;
  let entries = new Map<string, Entry>();
  const bindings = createLocaleBindings();
  const t = (text: string) => window.LiveSmithI18n?.t(text) ?? text;

  function createRow(sessionId: string) {
    const element = document.createElement("li");
    element.className = "context-attachment-row";
    const open = document.createElement("button");
    open.type = "button";
    open.className = "attachment-chip-label context-attachment-open";
    open.setAttribute("translate", "no");
    const status = document.createElement("span");
    status.className = "context-attachment-status";
    const reuse = document.createElement("button");
    reuse.type = "button";
    reuse.className = "secondary context-attachment-reuse";
    bindings.text(status, () => t("Pending send"));
    bindings.text(reuse, () => t("Attach again"));
    element.append(open, status, reuse);
    let entry: Entry;
    open.addEventListener("click", () => {
      if (getState().activeSessionId === sessionId) void attachmentViewer.open(sessionId, entry.attachment);
    });
    reuse.addEventListener("click", () => {
      if (getState().activeSessionId === sessionId && !entry.pending && !isReuseBlocked()) {
        void attachmentViewer.reuse(sessionId, entry.attachment);
      }
    });
    return {
      element,
      update(value: Entry, blocked: boolean) {
        entry = value;
        const { attachment, pending } = entry;
        const name = attachment.fileName;
        if (open.textContent !== name) open.textContent = name;
        if (status.hidden !== !pending) status.hidden = !pending;
        if (reuse.hidden !== pending) {
          if (pending && document.activeElement === reuse) open.focus({ preventScroll: true });
          reuse.hidden = pending;
        }
        if (reuse.disabled !== blocked) reuse.disabled = blocked;
      },
    };
  }

  function render() {
    const list = document.getElementById("contextAttachmentList")!;
    const empty = document.getElementById("contextAttachmentEmpty")!;
    const state = getState();
    const sessionId = state.activeSessionId;
    if (owner !== sessionId) {
      owner = sessionId;
      rows.clear();
      list.replaceChildren();
    }
    if (snapshot?.activeSessionId !== sessionId || snapshot.events !== state.events ||
        snapshot.pendingAttachments !== state.pendingAttachments) {
      snapshot = { activeSessionId: sessionId, events: state.events, pendingAttachments: state.pendingAttachments };
      entries = new Map();
      const add = (attachment: PersistedSessionAttachmentRef, pending: boolean) => {
        const key = attachmentKey(attachment);
        if (!entries.has(key)) entries.set(key, { attachment, pending });
      };
      if (sessionId) {
        for (const attachment of state.pendingAttachments) add(attachment, true);
        for (let index = state.events.length - 1; index >= 0; index--) {
          for (const attachment of state.events[index]?.attachments ?? []) add(attachment, false);
        }
      }
    }
    const isEmpty = entries.size === 0;
    if (empty.hidden !== !isEmpty) empty.hidden = !isEmpty;
    for (const [key, row] of rows) {
      if (entries.has(key)) continue;
      row.element.remove();
      rows.delete(key);
    }
    const blocked = isReuseBlocked();
    let position = list.firstElementChild;
    for (const [key, entry] of entries) {
      let row = rows.get(key);
      if (!row) {
        row = createRow(sessionId);
        rows.set(key, row);
      }
      row.update(entry, blocked);
      if (row.element !== position) list.insertBefore(row.element, position);
      position = row.element.nextElementSibling;
    }
    bindings.refresh(list);
  }

  return { render };
}
