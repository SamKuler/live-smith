import type { MidiArtifactImportCommand } from "../../app/midi-artifact-import.js";
import type { MidiArtifactImportPreview, MidiImportMapping } from "../../app/midi-artifact-preview.js";
import { isMidiArtifactImportPreview } from "./wire-contracts/midi-import.js";

interface Artifact {
  kind: "midi";
  artifactRef: string;
  label: string;
  noteCount: number;
  durationBeats: number;
}

export interface PluginResultActions {
  create(toolName: string, result: unknown): HTMLElement;
  setBusy(value: boolean): void;
}

interface Dependencies {
  getState(): { activeSessionId?: string };
  useInChat(text: string): Promise<void>;
  prepareMidiImport(input: { sessionId: string; artifactRef: string }): Promise<unknown>;
  importMidi(input: Omit<MidiArtifactImportCommand, "kind">): Promise<boolean>;
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const metadataKey = "io.github.samkuler/live-smith-artifacts";

function artifacts(result: Record<string, unknown>): Artifact[] {
  const metadata = record(result._meta) ? result._meta[metadataKey] : undefined;
  const entries = record(metadata) && metadata.version === 1 ? metadata.artifacts : result.artifacts;
  return Array.isArray(entries) ? entries.filter((entry): entry is Artifact => record(entry) && entry.kind === "midi" &&
    typeof entry.artifactRef === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(entry.artifactRef) &&
    typeof entry.label === "string" && Number.isFinite(entry.noteCount) && Number.isFinite(entry.durationBeats)) : [];
}

function createPluginResults(deps: Dependencies): PluginResultActions {
  let busy = false;
  const t = (value: string, values?: Record<string, string>): string => window.LiveSmithI18n?.t(value, values) ?? value;
  const node = <T extends keyof HTMLElementTagNameMap>(tag: T, className: string, text?: string): HTMLElementTagNameMap[T] => {
    const element = document.createElement(tag);
    element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  return {
    create(toolName, raw) {
      const card = node("section", "plugin-result-card");
      if (!record(raw)) return card;
      const sessionId = deps.getState().activeSessionId;
      const current = () => !busy && Boolean(sessionId) && sessionId === deps.getState().activeSessionId;
      const saved = artifacts(raw);
      const text = Array.isArray(raw.content) ? raw.content.filter((part) => record(part) && part.type === "text" && typeof part.text === "string")
        .map((part) => (part as { text: string }).text).join("\n") : "";
      card.append(node("h4", "plugin-result-title", t(raw.isError ? "Tool reported an error" : "Tool result")));
      if (text) card.append(node("p", "plugin-result-summary", text.slice(0, 2000)));
      else if (raw.structuredContent !== undefined) {
        card.append(node("pre", "plugin-result-summary", JSON.stringify(raw.structuredContent, null, 2).slice(0, 2000)));
      }
      const controls = node("fieldset", "plugin-result-controls");
      controls.disabled = busy;
      const chat = node("button", "secondary plugin-result-chat", t("Use in chat"));
      chat.type = "button";
      chat.addEventListener("click", () => {
        if (!current()) return;
        const references = saved.map((entry) => `${entry.label}: ${entry.artifactRef}`).join("\n");
        const prompt = t("Continue with the saved result from {tool}.", { tool: toolName }) +
          (references ? "\n" + references : "");
        void deps.useInChat(prompt);
      });
      controls.append(chat);
      if (saved.length && !raw.isError) {
        const details = node("details", "plugin-result-import");
        details.append(node("summary", "", t("Insert into Live")));
        const form = node("form", "plugin-result-import-form");
        const field = (title: string, input: HTMLInputElement | HTMLSelectElement) => {
          const label = node("label", "plugin-result-field");
          label.append(node("span", "", t(title)), input);
          form.append(label);
        };
        const selection = node("select", "plugin-result-artifact");
        for (const entry of saved) {
          const option = node("option", "", entry.label);
          option.value = entry.artifactRef;
          selection.append(option);
        }
        field("Saved MIDI", selection);
        const load = node("button", "secondary plugin-result-load", t("Load parts and Live tracks"));
        load.type = "button";
        form.append(load);
        const beat = node("input", "plugin-result-beat");
        beat.name = "startBeat"; beat.type = "number"; beat.required = true;
        beat.min = "1"; beat.step = "any"; beat.value = "1";
        field("Start beat (1-based)", beat);
        const mode = node("select", "plugin-result-mode");
        for (const [value, label] of [["parts", "Separate source parts"], ["merge", "Merge all parts into one Clip"]]) {
          const option = node("option", "", t(label!)); option.value = value!; mode.append(option);
        }
        field("Import mode", mode);
        const mapping = node("div", "plugin-result-mapping");
        const preview = node("ul", "plugin-result-preview");
        preview.setAttribute("aria-label", t("Clip preview"));
        form.append(mapping, preview);
        form.append(node("p", "field-hint", t("Quarter-note beats. Source offsets and track endings are preserved. Tempo, meter and controller events do not change the Live Set. Import follows this Session's edit scope and approval mode.")));
        const submit = node("button", "primary plugin-result-apply", t("Insert into Live"));
        submit.type = "submit"; submit.disabled = true;
        form.append(submit);
        const status = node("p", "plugin-result-import-status");
        status.setAttribute("role", "status"); form.append(status);
        let prepared: MidiArtifactImportPreview | undefined;
        let pending = false;
        let rows: { partId: string; label: string; duration: number; select: HTMLSelectElement }[] = [];
        const mappings = (): MidiImportMapping[] => rows.flatMap((row) => {
          const target = prepared?.targets.find((candidate) => candidate.trackId === row.select.value);
          return target ? [{ partId: row.partId, ...target }] : [];
        });
        const updatePreview = () => {
          preview.replaceChildren();
          const chosen = mappings();
          const repeated = new Set(chosen.map((entry) => entry.trackId)).size !== chosen.length;
          const start = Number(beat.value);
          for (const row of rows) {
            const target = prepared?.targets.find((candidate) => candidate.trackId === row.select.value);
            if (target) preview.append(node("li", "", `${row.label} → ${target.trackName} · ${t("Beats")} ${start}–${start + row.duration}`));
          }
          status.textContent = repeated ? t("Choose a different destination for each part, or use Merge all parts.") :
            chosen.length > (prepared?.maxMappings ?? 64) ? t("Select at most 64 parts for one import.") : "";
          submit.disabled = !prepared || !chosen.length || repeated || chosen.length > prepared.maxMappings || pending || !Number.isFinite(start) || start < 1;
        };
        const renderMapping = () => {
          mapping.replaceChildren(); rows = [];
          if (prepared) {
            const parts = mode.value === "merge"
              ? [{ id: "merged", label: t("All source parts"), durationBeats: prepared.durationBeats }]
              : prepared.parts.map((part) => ({ ...part,
                label: `${t("Track")} ${part.sourceTrackIndex + 1}${part.sourceTrackName ? " · " + part.sourceTrackName : ""} · ${t("Channel")} ${part.channel} · ${part.noteCount} ${t("notes")}` }));
            for (const part of parts) {
              const select = node("select", "plugin-result-track");
              select.setAttribute("aria-label", part.label);
              const skip = node("option", "", t("Skip this part")); skip.value = ""; select.append(skip);
              for (const target of prepared.targets) {
                const option = node("option", "", target.trackName); option.value = target.trackId; select.append(option);
              }
              const label = node("label", "plugin-result-field");
              label.append(node("span", "", part.label), select); mapping.append(label);
              rows.push({ partId: part.id, label: part.label, duration: part.durationBeats, select });
              select.addEventListener("change", updatePreview);
            }
            if (!prepared.targets.length) mapping.append(node("p", "field-hint", t("No unambiguous MIDI destinations are available. Create or rename MIDI tracks in Live, then reload.")));
            else if (prepared.unavailableTargetCount) mapping.append(node("p", "field-hint", t("Tracks with duplicate names are unavailable. Rename them in Live, then reload.")));
            mapping.append(node("p", "field-hint", `${prepared.timing.tempoEventCount} ${t("tempo events")}, ${prepared.timing.timeSignatureEventCount} ${t("meter events")} · ${t("metadata only")}`));
          }
          updatePreview();
        };
        load.addEventListener("click", async () => {
          if (!current() || !sessionId || pending) return;
          const artifactRef = selection.value;
          pending = true; prepared = undefined; renderMapping();
          status.textContent = t("Reading saved MIDI and observing Live tracks…");
          try {
            const result = await deps.prepareMidiImport({ sessionId, artifactRef });
            if (!current() || selection.value !== artifactRef) return;
            if (!isMidiArtifactImportPreview(result) || result.sessionId !== sessionId || result.artifactRef !== artifactRef) throw new Error(t("MIDI import preview is unavailable."));
            prepared = result;
          } catch (error) { status.textContent = error instanceof Error ? error.message : t("MIDI import preview failed."); }
          finally { pending = false; if (prepared) renderMapping(); }
        });
        selection.addEventListener("change", () => { prepared = undefined; renderMapping(); });
        mode.addEventListener("change", renderMapping);
        beat.addEventListener("input", updatePreview);
        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          if (!current() || !sessionId || pending || !prepared || !form.reportValidity()) return;
          updatePreview(); if (submit.disabled) return;
          const chosen = mappings();
          pending = true; updatePreview();
          try {
            const completed = await deps.importMidi({ sessionId, artifactRef: selection.value, startBeat: Number(beat.value) - 1,
              ...(mode.value === "merge" ? { trackId: chosen[0]!.trackId, trackName: chosen[0]!.trackName, mergeParts: true } : { mappings: chosen }) });
            prepared = undefined; renderMapping();
            status.textContent = t(completed ? "MIDI import finished. Review the Session result." : "MIDI was not imported. Review the Session status before retrying.");
          } finally { pending = false; }
        });
        details.append(form);
        controls.append(details);
      }
      card.append(controls);
      return card;
    },
    setBusy(value) {
      busy = value;
      for (const fieldset of document.querySelectorAll<HTMLFieldSetElement>(".plugin-result-controls")) fieldset.disabled = value;
    },
  };
}

window.LiveSmithFactories = window.LiveSmithFactories || {};
window.LiveSmithFactories.createPluginResults = createPluginResults;
