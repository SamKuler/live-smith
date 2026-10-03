import { createLocaleBindings, type LocalizedText } from "./locale-bindings.js";
import { isArtifactRef, type ArtifactRef } from "../../agent/artifact-contracts.js";
import { createMidiImportDialog, type MidiImportDialogInput } from "./midi-import-dialog.js";

type Artifact = { artifactRef: string; label: string } & (
  | { kind: "midi"; noteCount: number; durationBeats: number }
  | { kind: "audio"; durationSeconds: number; mediaType: "audio/wav" | "audio/mpeg" }
);

export interface PluginResultActions {
  create(toolName: string, result: unknown, options?: {
    importOnly?: boolean;
    initialStartBeat?: number;
    onImport?: MidiImportDialogInput["onImport"];
  }): HTMLElement;
  openMidiImport(input: MidiImportDialogInput): void;
  close(): void;
  setBusy(value: boolean): void;
  refreshLocale(): void;
}

interface Dependencies {
  getState(): { activeSessionId?: string };
  useInChat(text: string): Promise<void>;
  prepareMidiImport(input: { sessionId: string; artifactRef: string }, signal?: AbortSignal): Promise<unknown>;
  transferArtifact(kind: "export_artifact" | "attach_artifact", input: { sessionId: string; artifact: ArtifactRef }): Promise<boolean>;
  importMidi: NonNullable<MidiImportDialogInput["onImport"]>;
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const metadataKey = "io.github.samkuler/live-smith-artifacts";

function artifacts(result: Record<string, unknown>): Artifact[] {
  const metadata = record(result._meta) ? result._meta[metadataKey] : undefined;
  const entries = record(metadata) && metadata.version === 1 ? metadata.artifacts : result.artifacts;
  return Array.isArray(entries) ? entries.filter((entry): entry is Artifact => record(entry) &&
    isArtifactRef({ kind: entry.kind, id: entry.artifactRef }) && typeof entry.label === "string" &&
    (entry.kind === "midi" ? Number.isFinite(entry.noteCount) && Number.isFinite(entry.durationBeats)
      : Number.isFinite(entry.durationSeconds) && (entry.mediaType === "audio/wav" || entry.mediaType === "audio/mpeg"))) : [];
}

function createPluginResults(deps: Dependencies): PluginResultActions {
  let busy = false;
  const importer = createMidiImportDialog(deps);
  const bindings = createLocaleBindings();
  const t = (value: string, values?: Record<string, string>): string => window.LiveSmithI18n?.t(value, values) ?? value;
  const node = <T extends keyof HTMLElementTagNameMap>(tag: T, className: string, text?: LocalizedText): HTMLElementTagNameMap[T] => {
    const element = document.createElement(tag);
    element.className = className;
    if (text !== undefined) bindings.text(element, text);
    return element;
  };
  return {
    create(toolName, raw, options = {}) {
      const card = node("section", options.importOnly ? "plugin-result-import-actions" : "plugin-result-card");
      if (!record(raw)) return card;
      const sessionId = deps.getState().activeSessionId;
      const current = () => !busy && Boolean(sessionId) && sessionId === deps.getState().activeSessionId;
      const saved = artifacts(raw);
      const text = Array.isArray(raw.content) ? raw.content.filter((part) => record(part) && part.type === "text" && typeof part.text === "string")
        .map((part) => (part as { text: string }).text).join("\n") : "";
      if (!options.importOnly) card.append(node("h4", "plugin-result-title", () => t(raw.isError ? "Tool reported an error" : "Tool result")));
      if (text) card.append(node("p", "plugin-result-summary", text.slice(0, 2000)));
      else if (raw.structuredContent !== undefined) {
        card.append(node("pre", "plugin-result-summary", JSON.stringify(raw.structuredContent, null, 2).slice(0, 2000)));
      }
      const controls = node("fieldset", "plugin-result-controls");
      controls.disabled = busy;
      const chat = node("button", "secondary plugin-result-chat", () => t("Use in chat"));
      chat.type = "button";
      chat.addEventListener("click", () => {
        if (!current()) return;
        const references = saved.map((entry) => `${entry.label}: ${entry.artifactRef}`).join("\n");
        const prompt = t("Continue with the saved result from {tool}.", { tool: toolName }) +
          (references ? "\n" + references : "");
        void deps.useInChat(prompt);
      });
      if (!options.importOnly) controls.append(chat);
      const midi = saved.filter((artifact) => artifact.kind === "midi");
      if (midi.length && !raw.isError) {
        const launch = node("button", "secondary plugin-result-import", () => t("Add to Live")); launch.type = "button";
        const status = node("p", "plugin-result-import-status"); status.setAttribute("role", "status"); status.hidden = true;
        launch.addEventListener("click", () => {
          if (!current() || !sessionId) return;
          importer.open({ sessionId, artifacts: midi,
            ...(options.initialStartBeat === undefined ? {} : { initialStartBeat: options.initialStartBeat }),
            ...(options.onImport ? { onImport: options.onImport } : {}),
            onComplete(completed) {
              status.hidden = false;
              bindings.text(status, () => t(completed ? "MIDI import finished. Review the Session result." : "MIDI import did not complete. Review the Session result before retrying."));
              if (launch.isConnected) launch.focus();
            },
          });
        });
        controls.append(launch, status);
      }
      if (!options.importOnly && !raw.isError) for (const artifact of saved) {
        const item = node("div", "plugin-result-file"); item.append(node("p", "field-hint", artifact.label));
        const actions = node("div", "artifact-actions");
        const status = node("p", "plugin-result-import-status"); status.setAttribute("role", "status"); status.hidden = true;
        for (const [kind, label] of [["attach_artifact", "Attach to message"], ["export_artifact", artifact.kind === "midi" ? "Export MIDI" : "Export audio"]] as const) {
          const transfer = node("button", "secondary", () => t(label)); transfer.type = "button";
          transfer.addEventListener("click", async () => {
            if (!current() || !sessionId) return;
            const completed = await deps.transferArtifact(kind, { sessionId, artifact: { kind: artifact.kind, id: artifact.artifactRef } });
            if (sessionId !== deps.getState().activeSessionId || !item.isConnected) return;
            status.hidden = false;
            bindings.text(status, () => t(completed ? kind === "attach_artifact" ? "File attached to the next message." : "File download opened." : "The file transfer did not complete. Try again."));
          });
          actions.append(transfer);
        }
        item.append(actions, status); controls.append(item);
      }
      card.append(controls);
      return card;
    },
    openMidiImport: importer.open,
    close: importer.close,
    refreshLocale() { bindings.refresh(document.documentElement); importer.refreshLocale(); },
    setBusy(value) {
      busy = value;
      importer.setBusy(value);
      for (const fieldset of document.querySelectorAll<HTMLFieldSetElement>(".plugin-result-controls")) fieldset.disabled = value;
    },
  };
}

window.LiveSmithFactories = window.LiveSmithFactories || {};
window.LiveSmithFactories.createPluginResults = createPluginResults;
