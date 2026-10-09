import { artifactKey, type ArtifactRef } from "../../agent/artifact-contracts.js";
import type { SessionArtifact } from "../../app/session/session-artifacts.js";
import { createLocaleBindings, type LocalizedText } from "./locale-bindings.js";
import { createMidiPianoRoll } from "./midi-piano-roll.js";
import type { PluginResultActions } from "./plugin-results.js";
import { isSessionArtifactDetail } from "./wire-contracts/artifacts.js";

interface Dependencies {
  getState(): { activeSessionId?: string };
  readArtifact(input: { sessionId: string; artifact: ArtifactRef }, signal?: AbortSignal): Promise<unknown>;
  transfer(kind: "export_artifact", input: { sessionId: string; artifact: ArtifactRef }): Promise<boolean>;
  openArtifact(artifact: SessionArtifact): void;
  resultActions: PluginResultActions;
}

/** Owns read-only chat views of saved files; import and export stay with their existing workflows. */
export function createChatArtifactPreviews(deps: Dependencies) {
  const rows = new Map<string, ReturnType<typeof createRow>>();
  let sessionId: string | undefined;
  let busy = false;
  const t = (text: string, values?: Record<string, string>) => window.LiveSmithI18n?.t(text, values) ?? text;
  function createRow(owner: string, ref: ArtifactRef) {
    const bindings = createLocaleBindings();
    const node = <T extends keyof HTMLElementTagNameMap>(tag: T, className: string, text?: LocalizedText) => {
      const element = document.createElement(tag); element.className = className;
      if (text !== undefined) bindings.text(element, text);
      return element;
    };
    const root = node("section", "plugin-result-file chat-midi-preview");
    root.dataset.artifactId = ref.id;
    const title = node("h4", "plugin-result-title", () => t("Saved MIDI"));
    const status = node("p", "field-hint", () => t("Loading MIDI preview…")); status.setAttribute("role", "status");
    const retry = node("button", "secondary", () => t("Retry preview")); retry.type = "button"; retry.hidden = true;
    const preview = node("div", "chat-artifact-notes");
    const partLabel = node("label", "chat-artifact-part");
    partLabel.append(node("span", "", () => t("Preview part")));
    const part = node("select", ""); partLabel.append(part); partLabel.hidden = true;
    const roll = createMidiPianoRoll({ id: `chat-midi-${owner}-${ref.id}`, label: () => t("Saved MIDI note preview") });
    preview.append(partLabel, roll.element); preview.hidden = true;
    const controls = node("div", "artifact-actions"); controls.hidden = true;
    let artifact: SessionArtifact | undefined;
    let controller: AbortController | undefined;
    let transferring = false;
    let disposed = false;
    let suspended = false;
    const current = () => !disposed && !suspended && owner === deps.getState().activeSessionId;
    const button = (text: string, run: () => void) => {
      const value = node("button", "secondary", () => t(text)); value.type = "button";
      value.addEventListener("click", () => { if (current()) run(); }); controls.append(value); return value;
    };
    const add = button("Add to Live", () => {
      if (busy || !artifact) return;
      deps.resultActions.openMidiImport({ sessionId: owner, artifacts: [{ artifactRef: ref.id, label: artifact.label }],
        ...(part.value ? { initialPartId: part.value } : {}),
        onComplete(completed) {
          if (!current()) return;
          status.hidden = false; bindings.text(status, () => t(completed ? "MIDI import finished. Review the Session result." : "MIDI import did not complete. Review the Session result before retrying."));
          if (add.isConnected) add.focus();
        },
      });
    });
    const download = button("Export MIDI", () => { void exportFile(); });
    button("Open artifact", () => { if (artifact) deps.openArtifact(artifact); });
    function syncBusy() { add.disabled = busy; download.disabled = transferring; }
    async function exportFile() {
      if (transferring) return;
      transferring = true; syncBusy();
      try {
        const completed = await deps.transfer("export_artifact", { sessionId: owner, artifact: ref });
        if (current()) { status.hidden = false; bindings.text(status, () => t(completed ? "File download opened." : "The file transfer did not complete. Try again.")); }
      } catch { if (current()) { status.hidden = false; bindings.text(status, () => t("The file transfer did not complete. Try again.")); } }
      finally { transferring = false; syncBusy(); }
    }
    function renderNotes(reset = false) {
      if (!artifact?.midi) return;
      const midi = artifact.midi;
      const selected = midi.parts.find((entry) => entry.id === part.value);
      roll.update({ notes: selected ? midi.notes.filter((note) => note.partId === selected.id) : midi.notes,
        durationBeats: selected?.durationBeats ?? midi.durationBeats }, reset);
    }
    async function load() {
      if (!current() || controller) return;
      const attempt = new window.AbortController(); controller = attempt;
      status.hidden = false; bindings.text(status, () => t("Loading MIDI preview…")); retry.hidden = true;
      try {
        const result = await deps.readArtifact({ sessionId: owner, artifact: ref }, attempt.signal);
        if (!current() || controller !== attempt) return;
        if (!isSessionArtifactDetail(result) || result.sessionId !== owner || artifactKey(result.artifact.ref) !== artifactKey(ref) || !result.artifact.midi) throw new Error("Unavailable artifact");
        artifact = result.artifact;
        bindings.text(title, () => `${artifact!.label}${artifact!.version ? ` · v${artifact!.version.number}` : ""}`);
        part.replaceChildren();
        const all = node("option", "", () => t("All source parts")); all.value = ""; part.append(all);
        for (const entry of artifact.midi!.parts) {
          const option = node("option", "", () => `${entry.sourceTrackName || `${t("Track")} ${entry.sourceTrackIndex + 1}`} · ${t("Channel")} ${entry.channel}`);
          option.value = entry.id; part.append(option);
        }
        partLabel.hidden = artifact.midi!.parts.length <= 1;
        preview.hidden = controls.hidden = false; status.hidden = true; renderNotes(true); syncBusy();
      } catch {
        if (!current() || controller !== attempt) return;
        status.hidden = false; bindings.text(status, () => t("MIDI preview is unavailable. Retry or open Artifacts.")); retry.hidden = false;
      } finally { if (controller === attempt) controller = undefined; }
    }
    part.addEventListener("change", () => renderNotes(true));
    retry.addEventListener("click", () => { void load(); });
    root.append(title, status, retry, preview, controls);
    // History may contain many results. Read only cards that approach the viewport.
    const observer = typeof window.IntersectionObserver === "function" ? new window.IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { observer!.disconnect(); void load(); }
    }, { rootMargin: "200px" }) : undefined;
    const observe = () => { if (observer) observer.observe(root); else void load(); };
    observe();
    return { element: root, syncBusy,
      refreshLocale() { if (bindings.refresh(root)) renderNotes(); },
      suspend() { suspended = true; controller?.abort(); controller = undefined; observer?.disconnect(); },
      resume() { if (!suspended || disposed) return; suspended = false; if (!artifact) observe(); },
      dispose() { disposed = true; controller?.abort(); observer?.disconnect(); },
    };
  }
  return {
    sync(owner: string | undefined, refs: readonly ArtifactRef[]) {
      if (sessionId !== owner) { for (const row of rows.values()) row.dispose(); rows.clear(); sessionId = owner; }
      const present = new Set(refs.filter((ref) => ref.kind === "midi").map(artifactKey));
      for (const [key, row] of rows) if (!present.has(key)) { row.dispose(); rows.delete(key); }
      for (const row of rows.values()) row.refreshLocale();
    },
    render(ref: ArtifactRef) {
      if (!sessionId || ref.kind !== "midi") return undefined;
      const key = artifactKey(ref); let row = rows.get(key);
      if (!row) { row = createRow(sessionId, ref); rows.set(key, row); }
      return row.element;
    },
    setBusy(value: boolean) { busy = value; for (const row of rows.values()) row.syncBusy(); },
    suspend() { for (const row of rows.values()) row.suspend(); },
    resume() { for (const row of rows.values()) row.resume(); },
    dispose() { for (const row of rows.values()) row.dispose(); rows.clear(); },
  };
}
window.LiveSmithFactories ??= {};
window.LiveSmithFactories.createChatArtifactPreviews = createChatArtifactPreviews;
