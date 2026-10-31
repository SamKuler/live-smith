import type { SessionArtifact, SessionArtifacts } from "../../app/session/session-artifacts.js";
import type { ChatSessionEvent } from "../chat-state.js";
import { isSessionArtifacts } from "./wire-contracts/artifacts.js";
import { createLocaleBindings } from "./locale-bindings.js";

interface Dependencies {
  getState(): { activeSessionId?: string; events?: ChatSessionEvent[] };
  read(input: { sessionId: string; offset: number }, signal?: AbortSignal): Promise<unknown>;
  openArtifact(artifact: SessionArtifact): void;
}

/** Metadata-only Session entry; the main artifact page owns previews and actions. */
export function createArtifactSummary(deps: Dependencies) {
  let root: HTMLElement | undefined;
  let status: HTMLParagraphElement;
  let count: HTMLParagraphElement;
  let list: HTMLDivElement;
  let retry: HTMLButtonElement;
  let sessionId: string | undefined;
  let visible = false, suspended = false;
  let reading: AbortController | undefined;
  let snapshot: SessionArtifacts | undefined;
  let artifactEventsKey = "";
  const bindings = createLocaleBindings();
  const t = (text: string, params?: Record<string, string>) => window.LiveSmithI18n?.t(text, params) ?? text;
  const rows = new Map<string, { element: HTMLButtonElement; update(artifact: SessionArtifact): void }>();
  const current = (owner = sessionId) => visible && !suspended && Boolean(owner) && owner === deps.getState().activeSessionId;
  function initialize() {
    if (root) return;
    root = document.getElementById("artifactSummary")!;
    count = document.createElement("p"); count.className = "field-hint"; count.hidden = true;
    status = document.createElement("p"); status.className = "field-hint"; status.setAttribute("role", "status"); status.hidden = true;
    retry = document.createElement("button"); retry.type = "button"; retry.className = "secondary"; retry.hidden = true;
    bindings.text(retry, () => t("Refresh")); retry.addEventListener("click", () => { void read(); });
    list = document.createElement("div"); list.className = "artifact-summary-list";
    root.append(count, status, retry, list);
  }
  function cancelRead() { reading?.abort(); reading = undefined; }
  function syncSession() {
    initialize();
    const next = deps.getState().activeSessionId;
    (document.getElementById("openArtifactsButton") as HTMLButtonElement).disabled = !next;
    if (sessionId === next) return false;
    cancelRead(); sessionId = next; snapshot = undefined; rows.clear(); list.replaceChildren();
    count.hidden = status.hidden = retry.hidden = true;
    return true;
  }
  function syncArtifactEvents() {
    const events = deps.getState().events ?? [];
    const imports = new Set(events.flatMap(event => event.kind === "apply_requested" && event.applyOperation && (
      event.applyOperation.artifacts?.length || event.applyOperation.plan?.actions.some(action => "source" in action && action.source?.kind === "audio_asset")
    ) ? [event.applyOperation.id] : []));
    const next = JSON.stringify(events.flatMap(event => {
      if (event.artifacts || event.candidateSelection?.action === "primary") return [[event.id, event.artifacts, event.candidateSelection]];
      if (event.applyOperation && imports.has(event.applyOperation.id) && (event.kind === "apply_requested" || event.kind === "apply_result")) {
        return [[event.id, event.applyOperation.id, event.applyOperation.status]];
      }
      return [];
    }));
    const changed = next !== artifactEventsKey; artifactEventsKey = next; return changed;
  }
  function renderRows() {
    const owner = sessionId;
    const present = new Set<string>();
    const focused = document.activeElement;
    let position = list.firstElementChild;
    for (const artifact of snapshot?.artifacts ?? []) {
      const key = `${artifact.ref.kind}:${artifact.version?.groupId ?? artifact.ref.id}`; present.add(key);
      let row = rows.get(key);
      if (!row) {
        const element = document.createElement("button"); element.type = "button"; element.className = "artifact-summary-row";
        const name = document.createElement("strong"), metadata = document.createElement("span"), outcome = document.createElement("span");
        metadata.className = "artifact-summary-metadata"; outcome.className = "artifact-summary-outcome"; element.append(name, metadata, outcome);
        let selected = artifact;
        element.addEventListener("click", () => { if (current(owner)) deps.openArtifact(selected); });
        row = { element, update(value) {
          selected = value; element.dataset.artifactRef = value.ref.id;
          bindings.text(name, value.version?.groupLabel ?? value.label);
          bindings.text(metadata, () => `${t(value.ref.kind === "device-parameters" ? "Parameters" : value.ref.kind === "midi" ? "MIDI" : "Audio")}${value.version ? ` · v${value.version.number}` : ""}`);
          const record = value.history?.[0];
          outcome.hidden = !record;
          bindings.text(outcome, () => {
            if (!record) return "";
            const version = value.versions?.find(entry => entry.id === record.artifact.id);
            return `${t(record.action === "parameters" ? "Last application" : "Last import")}${version ? ` · v${version.number}` : ""} · ${t(record.status)}`;
          });
        } }; rows.set(key, row);
      }
      row.update(artifact);
      if (row.element !== position) list.insertBefore(row.element, position);
      position = row.element.nextElementSibling;
    }
    for (const [key, row] of rows) if (!present.has(key)) { row.element.remove(); rows.delete(key); }
    if (focused instanceof HTMLElement && !focused.isConnected && current()) document.getElementById("openArtifactsButton")!.focus({ preventScroll: true });
    count.hidden = !snapshot?.total;
    bindings.text(count, () => snapshot ? t("{shown} of {total} works", { shown: String(snapshot.artifacts.length), total: String(snapshot.total) }) : "");
  }
  async function read() {
    if (!current()) return;
    cancelRead();
    const owner = sessionId!; const controller = new window.AbortController(); reading = controller;
    status.hidden = false; retry.hidden = true; bindings.text(status, () => t("Loading saved artifacts…"));
    const active = () => current(owner) && reading === controller;
    try {
      const result = await deps.read({ sessionId: owner, offset: 0 }, controller.signal);
      if (!active()) return;
      if (!isSessionArtifacts(result) || result.sessionId !== owner || result.offset !== 0 || result.query !== undefined || result.kind !== undefined) throw new Error(t("Saved artifacts are unavailable."));
      snapshot = result; renderRows();
      status.hidden = result.total > 0 && !result.unavailableCount;
      bindings.text(status, () => t(result.unavailableCount ? "Some saved artifacts are unavailable." : "No saved artifacts yet."));
    } catch (error) {
      if (!active()) return;
      status.hidden = false; retry.hidden = false;
      bindings.text(status, () => error instanceof Error ? error.message : t("Saved artifacts are unavailable."));
    } finally { if (reading === controller) reading = undefined; }
  }
  window.addEventListener("pagehide", () => { suspended = true; cancelRead(); });
  window.addEventListener("pageshow", (event) => { suspended = false; if (event.persisted && visible) { syncSession(); void read(); } });
  return {
    render() {
      const changed = syncSession(); const artifactsChanged = syncArtifactEvents();
      bindings.refresh(root!); if ((changed || artifactsChanged) && visible) void read();
    },
    setVisible(value: boolean) {
      const changed = syncSession(); const artifactsChanged = syncArtifactEvents(); const opening = value && !visible; visible = value;
      if (!value) cancelRead(); else if (opening || changed || artifactsChanged) void read();
    },
    invalidate(owner: string) { if (owner === sessionId && current(owner)) void read(); },
  };
}
