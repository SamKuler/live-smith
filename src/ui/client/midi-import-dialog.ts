import { createLocaleBindings, type LocalizedText } from "./locale-bindings.js";
import type { MidiArtifactImportCommand } from "../../app/midi-artifact-import.js";
import type { MidiArtifactImportPreview, MidiImportDestination, MidiImportMapping } from "../../app/midi-artifact-preview.js";
import { isMidiArtifactImportPreview } from "./wire-contracts/midi-import.js";

export interface ImportableMidiArtifact { artifactRef: string; label: string }
export interface MidiImportDialogInput {
  sessionId: string;
  artifacts: ImportableMidiArtifact[];
  initialStartBeat?: number;
  initialPartId?: string;
  onImport?: (input: Omit<MidiArtifactImportCommand, "kind">) => Promise<boolean>;
  onComplete?: (completed: boolean) => void;
}
interface Dependencies {
  getState(): { activeSessionId?: string };
  prepareMidiImport(input: { sessionId: string; artifactRef: string }, signal?: AbortSignal): Promise<unknown>;
  importMidi(input: Omit<MidiArtifactImportCommand, "kind">): Promise<boolean>;
}

export function createMidiImportDialog(deps: Dependencies) {
  let busy = false;
  let active: { sessionId: string; dialog: HTMLDialogElement; fields: HTMLFieldSetElement;
    abort: AbortController | undefined; previousFocus: Element | null; refresh(): void } | undefined;
  const bindings = createLocaleBindings();
  const t = (value: string, params?: Record<string, string>) => window.LiveSmithI18n?.t(value, params) ?? value;
  const element = <T extends keyof HTMLElementTagNameMap>(tag: T, className: string, text?: LocalizedText): HTMLElementTagNameMap[T] => {
    const node = document.createElement(tag); node.className = className;
    if (text !== undefined) bindings.text(node, text); return node;
  };
  function close(restoreFocus = true) {
    const view = active; active = undefined;
    if (!view) return;
    view.abort?.abort(); view.dialog.remove();
    if (restoreFocus && view.sessionId === deps.getState().activeSessionId) {
      const target = view.previousFocus?.isConnected ? view.previousFocus : document.getElementById("prompt");
      if (target instanceof HTMLElement) target.focus({ preventScroll: true });
    }
  }
  function open(input: MidiImportDialogInput) {
    if (busy || input.sessionId !== deps.getState().activeSessionId || !input.artifacts.length) return;
    close(false);
    const dialog = element("dialog", "midi-import-dialog");
    dialog.setAttribute("aria-labelledby", "midi-import-heading");
    const header = element("div", "midi-import-header");
    const heading = element("h2", "", () => t("Add MIDI to Live")); heading.id = "midi-import-heading";
    const cancel = element("button", "secondary", () => t("Cancel")); cancel.type = "button";
    header.append(heading, cancel);
    const form = element("form", "midi-import-form");
    const body = element("div", "midi-import-body");
    const fields = element("fieldset", "midi-import-fields");
    const footer = element("div", "midi-import-footer");
    const status = element("p", "field-hint midi-import-status"); status.setAttribute("role", "status");
    const submit = element("button", "primary plugin-result-apply", () => t("Add to Live")); submit.type = "submit"; submit.disabled = true;
    footer.append(status, submit); body.append(fields); form.append(body, footer); dialog.append(header, form);
    const view = { sessionId: input.sessionId, dialog, fields, previousFocus: document.activeElement,
      abort: undefined as AbortController | undefined, refresh: () => { bindings.refresh(dialog); fields.disabled = busy || loading; updatePreview(); } };
    active = view;
    const current = () => active === view && view.sessionId === deps.getState().activeSessionId;
    let prepared: MidiArtifactImportPreview | undefined;
    let loading = false;
    let startEdited = input.initialStartBeat !== undefined;
    const field = (label: string, control: HTMLInputElement | HTMLSelectElement) => {
      const node = element("label", "midi-import-field"); node.append(element("span", "", () => t(label)), control); return node;
    };
    const source = element("select", "plugin-result-artifact");
    for (const artifact of input.artifacts) {
      const option = element("option", "", artifact.label); option.value = artifact.artifactRef; source.append(option);
    }
    if (input.artifacts.length > 1) fields.append(field("Saved MIDI", source));
    else fields.append(element("p", "midi-import-source", input.artifacts[0]!.label));
    fields.append(element("p", "field-hint", () => t("Destination: Arrangement")));
    const placement = element("div", "midi-import-placement");
    const start = element("input", "plugin-result-beat"); start.type = "number"; start.min = "1"; start.step = "any"; start.required = true;
    start.value = String((input.initialStartBeat ?? 0) + 1);
    const mode = element("select", "plugin-result-mode");
    for (const [value, label] of [["parts", "Separate source parts"], ["merge", "Merge all parts into one Clip"]]) {
      const option = element("option", "", () => t(label!)); option.value = value!; mode.append(option);
    }
    const modeField = field("Import mode", mode);
    placement.append(field("Start beat (1-based)", start), modeField); fields.append(placement);
    const mapping = element("div", "midi-import-mapping");
    const preview = element("ul", "plugin-result-preview"); bindings.attribute(preview, "aria-label", () => t("Clip preview"));
    const summary = element("p", "midi-import-summary");
    const reload = element("button", "secondary plugin-result-load", () => t("Refresh Live tracks")); reload.type = "button";
    fields.append(mapping, summary, preview, element("p", "field-hint", () => t("Imports notes at Live's tempo. Instruments, tempo, meter and controller events are not imported.")), reload);
    let rows: { id: string; label: () => string; duration: number; include: HTMLInputElement; target: HTMLSelectElement; name: HTMLInputElement }[] = [];
    const mappingDrafts = new Map<string, Map<string, { included: boolean; targetId: string; targetLabel: string; name: string }>>();
    let renderedMappingKey = "";
    function destination(row: typeof rows[number]): MidiImportDestination | undefined {
      if (!row.include.checked) return;
      if (row.target.value === "new") return { createTrack: true, trackName: row.name.value.trim() };
      return prepared?.targets.find((target) => target.trackId === row.target.value);
    }
    function updatePreview() {
      preview.replaceChildren();
      const chosen = rows.flatMap((row) => { const target = destination(row); return target ? [{ row, target }] : []; });
      const existing = chosen.flatMap(({ target }) => target.createTrack ? [] : [target.trackId]);
      const duplicate = new Set(existing).size !== existing.length;
      const missingDestination = rows.some((row) => row.include.checked && !destination(row));
      const newTracks = chosen.filter(({ target }) => target.createTrack).length;
      const actionCount = chosen.length + newTracks;
      const validNames = chosen.every(({ target }) => target.trackName.length > 0 && target.trackName.length <= 256);
      const beat = Number(start.value);
      for (const row of rows) {
        row.target.disabled = !row.include.checked;
        row.target.hidden = !row.include.checked;
        row.name.hidden = !row.include.checked || row.target.value !== "new";
        row.name.disabled = !row.include.checked || row.target.value !== "new";
      }
      for (const { row, target } of chosen) preview.append(element("li", "", () => t("{part} → {track} · beats {start}–{end}", {
        part: row.label(), track: target.createTrack ? t("New track: {name}", { name: target.trackName }) : target.trackName,
        start: String(beat), end: String(beat + row.duration),
      })));
      summary.hidden = !prepared;
      bindings.text(summary, () => t("{clips} Clips · {tracks} new tracks", { clips: String(chosen.length), tracks: String(newTracks) }));
      submit.disabled = busy || loading || !current() || !prepared || !chosen.length || duplicate || missingDestination || !validNames ||
        actionCount > prepared.maxActions || !Number.isFinite(beat) || start.value === "" || beat < 1;
      const maxActions = prepared?.maxActions ?? 0;
      if (prepared) bindings.text(status, () => missingDestination ? t("Choose an available destination for each selected part.")
        : duplicate ? t("Choose a different destination for each part, or use Merge all parts.")
        : !validNames ? t("Enter a name for each new track.")
        : actionCount > maxActions ? t("Too many track and Clip creations. Select fewer parts for this import.") : "");
    }
    function renderMapping() {
      if (rows.length) mappingDrafts.set(renderedMappingKey, new Map(rows.map((row) => [row.id, {
        included: row.include.checked, targetId: row.target.value,
        targetLabel: row.target.selectedOptions[0]?.textContent ?? row.target.value, name: row.name.value,
      }])));
      mapping.replaceChildren(); rows = [];
      if (prepared) {
        renderedMappingKey = `${source.value}:${mode.value}`;
        const draft = mappingDrafts.get(renderedMappingKey);
        const parts = mode.value === "merge"
          ? [{ id: "merged", label: () => t("All source parts"), durationBeats: prepared.durationBeats }]
          : prepared.parts.map((part) => ({ id: part.id, durationBeats: part.durationBeats,
            label: () => `${part.sourceTrackName || `${t("Track")} ${part.sourceTrackIndex + 1}`} · ${t("Channel")} ${part.channel}` }));
        for (const part of parts) {
          const saved = draft?.get(part.id);
          const row = element("div", "midi-import-part");
          const include = element("input", "midi-import-part-enabled"); include.type = "checkbox";
          include.checked = saved?.included ?? (mode.value === "merge" || !input.initialPartId || part.id === input.initialPartId);
          const label = element("label", "midi-import-part-label"); label.append(include, element("span", "", part.label));
          const target = element("select", "plugin-result-track"); bindings.attribute(target, "aria-label", () => t("Destination for {part}", { part: part.label() }));
          const create = element("option", "", () => t("New MIDI track")); create.value = "new"; target.append(create);
          for (const track of prepared.targets) { const option = element("option", "", track.trackName); option.value = track.trackId; target.append(option); }
          if (saved) {
            if (saved.targetId !== "new" && !prepared.targets.some((track) => track.trackId === saved.targetId)) {
              const unavailable = element("option", "", saved.targetLabel); unavailable.value = saved.targetId;
              unavailable.disabled = true; target.append(unavailable);
            }
            target.value = saved.targetId;
          } else if ((parts.length === 1 || input.initialPartId === part.id) && prepared.suggestedTrackId) target.value = prepared.suggestedTrackId;
          const name = element("input", "midi-import-track-name"); name.type = "text"; name.maxLength = 256; name.required = true;
          name.value = saved?.name ?? (mode.value === "merge" ? prepared.label : prepared.parts.find((entry) => entry.id === part.id)?.sourceTrackName || prepared.label);
          bindings.attribute(name, "aria-label", () => t("New track name for {part}", { part: part.label() }));
          rows.push({ id: part.id, label: part.label, duration: part.durationBeats, include, target, name });
          row.append(label, target, name); mapping.append(row);
          include.addEventListener("change", updatePreview); target.addEventListener("change", updatePreview); name.addEventListener("input", updatePreview);
        }
        if (prepared.unavailableTargetCount) mapping.append(element("p", "field-hint", () => t("Tracks with duplicate names are unavailable. Rename them in Live, then refresh.")));
      }
      updatePreview();
    }
    async function load() {
      if (!current()) return;
      view.abort?.abort(); const controller = new window.AbortController(); view.abort = controller;
      const artifactRef = source.value;
      loading = true; prepared = undefined; fields.disabled = true; renderMapping();
      bindings.text(status, () => t("Reading saved MIDI and observing Live tracks…"));
      try {
        const result = await deps.prepareMidiImport({ sessionId: input.sessionId, artifactRef }, controller.signal);
        if (!current() || view.abort !== controller) return;
        if (!isMidiArtifactImportPreview(result) || result.sessionId !== input.sessionId || result.artifactRef !== artifactRef) throw new Error(t("MIDI import preview is unavailable."));
        prepared = result;
        if (!startEdited && result.suggestedStartBeat !== undefined) start.value = String(result.suggestedStartBeat + 1);
        modeField.hidden = result.parts.length < 2;
        if (result.parts.length < 2) mode.value = "parts";
        renderMapping();
      } catch (error) { if (current() && view.abort === controller) bindings.text(status, () => error instanceof Error ? error.message : t("MIDI import preview failed.")); }
      finally { if (current() && view.abort === controller) { loading = false; view.refresh(); } }
    }
    source.addEventListener("change", () => { void load(); }); reload.addEventListener("click", () => { void load(); });
    mode.addEventListener("change", renderMapping);
    start.addEventListener("input", () => { startEdited = true; updatePreview(); });
    cancel.addEventListener("click", () => close());
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); close(); });
    dialog.addEventListener("keydown", (event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault(); updatePreview();
      if (submit.disabled || !prepared || !form.reportValidity()) return;
      const selected = rows.flatMap((row): MidiImportMapping[] => { const target = destination(row); return target ? [{ partId: row.id, ...target }] : []; });
      const command: Omit<MidiArtifactImportCommand, "kind"> = { sessionId: input.sessionId, artifactRef: source.value,
        startBeat: Number(start.value) - 1, ...(mode.value === "merge" ? { ...destination(rows[0]!)!, mergeParts: true } : { mappings: selected }) };
      close(false);
      const completed = await (input.onImport ?? deps.importMidi)(command);
      if (input.sessionId === deps.getState().activeSessionId) input.onComplete?.(completed);
    });
    document.body.append(dialog);
    if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.setAttribute("open", "");
    cancel.focus(); void load();
  }
  return { open, close, refreshLocale: () => active?.refresh(), setBusy(value: boolean) {
    busy = value;
    if (active?.sessionId !== deps.getState().activeSessionId) close(false);
    else active?.refresh();
  } };
}
