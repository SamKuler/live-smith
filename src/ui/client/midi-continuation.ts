import { createLocaleBindings, type LocalizedText } from "./locale-bindings.js";
import type { MidiContinuationCommand, MidiContinuationGeneratorChoice, MidiContinuationView } from "../../agent/midi-continuation-contracts.js";
import type { PluginParameterPanel } from "../../plugins/parameter-panel.js";
import type { ChatDialogState } from "../chat-state.js";
import type { PluginResultActions } from "./plugin-results.js";
import { isMidiArtifactImportPreview } from "./wire-contracts/midi-import.js";

interface Operation { busy: boolean; commandKind?: string | null; canStop: boolean; stopping: boolean }
interface ParameterPanels {
  refreshLocale(): void;
  create(panel: PluginParameterPanel, options: { initialValues?: Record<string, unknown>; submitLabel: string;
    description: string; showResult: false; onSubmit(args: Record<string, unknown>): Promise<void> }): HTMLElement;
}
interface Dependencies {
  getState(): Pick<ChatDialogState, "activeSessionId" | "midiContinuation" | "runtimeProfile" | "capabilities" | "configuredModelsReady">;
  run(command: MidiContinuationCommand): Promise<boolean>;
  stop(): Promise<void>;
  createParameterPanels(): ParameterPanels;
  resultActions: PluginResultActions;
  preview(input: { sessionId: string; artifactRef: string }): Promise<unknown>;
}

const clipKey = (clip: { trackId: string; clipId: string }) => `${clip.trackId}:${clip.clipId}`;
const generatorKey = (choice: MidiContinuationGeneratorChoice) => `${choice.toolName}:${choice.signature}`;
const continuationCommands = new Set(["configure_midi_continuation", "fill_midi_continuation", "import_midi_continuation"]);

function createView(deps: Dependencies) {
  const bindings = createLocaleBindings();
  const t = (source: string, values?: Record<string, string>) => window.LiveSmithI18n?.t(source, values) ?? source;
  const node = <T extends keyof HTMLElementTagNameMap>(tag: T, className: string, text?: LocalizedText): HTMLElementTagNameMap[T] => {
    const element = document.createElement(tag); element.className = className; if (text !== undefined) bindings.text(element, text); return element;
  };
  const root = document.getElementById("midiContinuationSection")!;
  const content = document.getElementById("midiContinuationContent")!;
  const load = document.getElementById("loadMidiContinuationButton") as HTMLButtonElement;
  const status = node("p", "field-hint midi-continuation-status"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  const setup = node("div", "midi-continuation-setup");
  const sourceList = node("div", "midi-continuation-sources"); sourceList.setAttribute("role", "group"); bindings.attribute(sourceList, "aria-label", () => t("Source MIDI Clips"));
  const sourceHint = node("p", "field-hint");
  const length = node("input", "midi-continuation-length"); length.type = "number"; length.min = "1"; length.max = "256"; length.step = "any"; length.required = true;
  const capacity = node("input", "midi-continuation-capacity"); capacity.type = "number"; capacity.min = "1"; capacity.max = "4"; capacity.step = "1"; capacity.required = true;
  const generator = node("select", "midi-continuation-generator");
  const prompt = node("textarea", "midi-continuation-prompt"); prompt.rows = 3; prompt.maxLength = 8000;
  const field = (label: string, control: HTMLElement) => { const wrapper = node("label", "midi-continuation-field"); wrapper.append(node("span", "", () => t(label)), control); return wrapper; };
  const numbers = node("div", "midi-continuation-numbers"); numbers.append(field("Section length (beats)", length), field("Buffer capacity", capacity));
  const promptField = field("Direction for generated sections", prompt);
  const parameters = node("div", "midi-continuation-parameters");
  const save = node("button", "primary", () => t("Save continuation setup")); save.type = "button";
  const reset = node("button", "secondary", () => t("Use saved setup")); reset.type = "button";
  const setupHint = node("p", "field-hint");
  const setupActions = node("div", "midi-continuation-actions"); setupActions.append(reset, save);
  setup.append(node("h3", "", () => t("Source MIDI Clips")), sourceList, sourceHint, numbers, field("MIDI generator", generator), promptField, parameters, setupHint, setupActions);
  const bufferInfo = node("p", "field-hint midi-continuation-buffer");
  const queue = node("div", "midi-continuation-queue");
  const fill = node("button", "primary", () => t("Fill buffer")); fill.type = "button";
  const stop = node("button", "secondary", () => t("Stop")); stop.type = "button";
  const fillActions = node("div", "midi-continuation-actions"); fillActions.append(fill, stop);
  const importRegion = node("fieldset", "midi-continuation-import");
  content.append(status, setup, bufferInfo, fillActions, queue, importRegion);

  let sessionId = "";
  let renderedView = "";
  let operation: Operation = { busy: false, canStop: false, stopping: false };
  let pending: MidiContinuationCommand["kind"] | undefined;
  let attempt = 0;
  let dirty = false;
  let baseBufferId: string | null = null;
  let headKey = "";
  let selected = new Set<string>();
  let parameterPanels = deps.createParameterPanels();
  const previewRows = new Map<string, HTMLDetailsElement>();
  const getView = (): MidiContinuationView | undefined => {
    const state = deps.getState(); return state.midiContinuation?.sessionId === state.activeSessionId ? state.midiContinuation : undefined;
  };
  const current = (owner = sessionId) => owner === deps.getState().activeSessionId;
  const choice = () => getView()?.generators.find((entry) => generatorKey(entry) === generator.value);
  const modelReady = () => Boolean(deps.getState().runtimeProfile && deps.getState().configuredModelsReady && deps.getState().capabilities.tools);
  const conflict = () => dirty && baseBufferId !== (getView()?.buffer?.id ?? null);
  const validSetup = () => {
    const view = getView(); const selectedClips = view?.clips.filter((clip) => selected.has(clipKey(clip))) ?? [];
    return Boolean(view && selectedClips.length && selectedClips.length <= 16 && selectedClips.length === selected.size &&
      length.validity.valid && capacity.validity.valid && (generator.value === "model" ? modelReady() : choice()) && !conflict());
  };
  function syncControls() {
    const view = getView(); const buffer = view?.buffer; const locked = operation.busy || Boolean(pending);
    const savingSetup = pending === "configure_midi_continuation";
    for (const control of [length, capacity, generator, prompt, ...sourceList.querySelectorAll("input")]) control.disabled = savingSetup;
    for (const fields of parameters.querySelectorAll("fieldset")) fields.disabled = savingSetup;
    load.disabled = locked;
    const canSave = validSetup() && (!buffer || dirty || view?.stale === true);
    save.disabled = locked || !canSave; save.hidden = generator.value !== "model";
    for (const submit of parameters.querySelectorAll<HTMLButtonElement>('button[type="submit"]')) submit.disabled = locked || !canSave;
    reset.disabled = savingSetup || !view; reset.hidden = !dirty && !conflict();
    fill.disabled = locked || dirty || !buffer || view?.stale === true || buffer.queue.length >= buffer.capacity;
    const stoppable = continuationCommands.has(operation.commandKind ?? "");
    stop.hidden = !stoppable; stop.disabled = !operation.canStop || operation.stopping;
    bindings.text(stop, () => t(operation.stopping ? "Stopping…" : "Stop"));
    importRegion.disabled = locked || dirty || view?.stale === true;
    bindings.text(setupHint, () => conflict() ? t("The saved setup changed. Use saved setup before editing again.") : dirty
      ? t("Save this setup or use saved values before filling or importing. Saving starts a new buffer; saved artifacts remain in this Session.")
      : generator.value === "model" && !modelReady() ? t("Choose a saved model with tool support, or an enabled MIDI generator.")
      : t("Fill generates ordered future sections. Refill manually after importing; no automatic playback is scheduled."));
    root.setAttribute("aria-busy", String(Boolean(pending)));
  }
  function renderSources() {
    sourceList.replaceChildren(); const view = getView();
    for (const clip of view?.clips ?? []) {
      const row = node("label", "midi-continuation-clip");
      const check = node("input", ""); check.type = "checkbox"; check.checked = selected.has(clipKey(clip));
      bindings.attribute(check, "aria-label", () => `${clip.trackName} · ${clip.clipName || t("Untitled MIDI Clip")}`);
      const copy = node("span", "midi-continuation-clip-copy");
      copy.append(node("strong", "", () => clip.clipName || t("Untitled MIDI Clip")), node("span", "field-hint",
        () => `${clip.trackName} · ${t(clip.location === "arrangement" ? "Arrangement" : "Session")} · ${t("Beats")} ${clip.startBeat + 1}–${clip.startBeat + clip.durationBeats + 1} · ${clip.noteCount} ${t("notes")}`));
      row.append(check, copy); sourceList.append(row);
      check.addEventListener("change", () => { if (check.checked) selected.add(clipKey(clip)); else selected.delete(clipKey(clip)); dirty = true; syncControls(); });
    }
    bindings.text(sourceHint, () => !view?.clips.length ? t("No MIDI Clips are available in this snapshot.")
      : view.clipsTruncated ? t("Source list is limited to 256 observed Clips. Select up to 16.") : t("Select up to 16 source MIDI Clips across tracks."));
  }
  function renderParameters() {
    parameters.replaceChildren(); promptField.hidden = generator.value !== "model";
    const selectedGenerator = choice(); if (!selectedGenerator) { syncControls(); return; }
    const saved = getView()?.buffer?.generator;
    const initialValues = saved?.kind === "plugin" && saved.toolName === selectedGenerator.toolName && saved.signature === selectedGenerator.signature ? saved.arguments : undefined;
    parameters.append(parameterPanels.create({ ...selectedGenerator.panel, fields: selectedGenerator.panel.fields.filter((field) =>
      field.name !== selectedGenerator.inputArgument && field.name !== selectedGenerator.lengthArgument) }, {
      ...(initialValues ? { initialValues } : {}), submitLabel: "Save continuation setup",
      description: "Stores these generation parameters without running the tool. Fill buffer starts generation.", showResult: false,
      onSubmit: async (args) => { await configure(args); },
    }));
    syncControls();
  }
  function hydrateSetup() {
    const view = getView(); const buffer = view?.buffer;
    baseBufferId = buffer?.id ?? null;
    selected = new Set(buffer?.sourceClips.map(clipKey).filter((key) => view!.clips.some((clip) => clipKey(clip) === key)) ?? []);
    length.value = String(buffer?.segmentBeats ?? 8); capacity.value = String(buffer?.capacity ?? 2); prompt.value = buffer?.prompt ?? "";
    generator.replaceChildren(); const model = node("option", "", () => t("Current Session model")); model.value = "model"; generator.append(model);
    for (const entry of view?.generators ?? []) { const option = node("option", "", entry.label); option.value = generatorKey(entry); generator.append(option); }
    generator.value = buffer?.generator.kind === "plugin" ? `${buffer.generator.toolName}:${buffer.generator.signature}` : "model";
    if (!generator.value) generator.value = "model";
    dirty = false; parameterPanels = deps.createParameterPanels(); renderSources(); renderParameters();
  }
  async function run(command: MidiContinuationCommand): Promise<boolean> {
    if (!current() || operation.busy || pending) return false;
    const owner = sessionId; const ownAttempt = ++attempt; pending = command.kind; syncControls();
    bindings.text(status, () => t(command.kind === "fill_midi_continuation" ? "Filling future MIDI sections…" : command.kind === "configure_midi_continuation" ? "Saving MIDI continuation setup…" : command.kind === "load_midi_continuation" ? "Observing MIDI Clips and generators…" : "Importing the next MIDI section…"));
    try {
      const completed = await deps.run(command);
      if (!current(owner) || attempt !== ownAttempt) return false;
      if (completed && command.kind === "configure_midi_continuation") hydrateSetup();
      bindings.text(status, () => completed ? t(command.kind === "fill_midi_continuation" ? "Fill finished. Review the saved sections before importing." : command.kind === "import_midi_continuation" ? "Import finished. The server snapshot shows the remaining sections." : "MIDI continuation is ready.")
        : t("Operation stopped or failed. Saved sections remain; review the Session status before trying again."));
      return completed;
    } catch (error) {
      if (current(owner) && attempt === ownAttempt) bindings.text(status, () => error instanceof Error ? error.message : t("MIDI continuation could not complete."));
      return false;
    } finally { if (attempt === ownAttempt) { pending = undefined; render(); syncControls(); } }
  }
  async function configure(args?: Record<string, unknown>) {
    if (!validSetup()) { length.reportValidity(); capacity.reportValidity(); return; }
    const view = getView()!; const selectedGenerator = choice();
    if (generator.value !== "model" && (!selectedGenerator || !args)) return;
    await run({ kind: "configure_midi_continuation", sessionId, expectedBufferId: baseBufferId,
      sourceClips: view.clips.filter((clip) => selected.has(clipKey(clip))).map(({ trackId, clipId }) => ({ trackId, clipId })),
      segmentBeats: Number(length.value), capacity: Number(capacity.value), prompt: generator.value === "model" ? prompt.value : "",
      generator: selectedGenerator ? { kind: "plugin", toolName: selectedGenerator.toolName, signature: selectedGenerator.signature, arguments: args! } : { kind: "model" } });
  }
  function renderQueue() {
    const view = getView(); const buffer = view?.buffer;
    bindings.text(bufferInfo, () => buffer ? t("{ready} of {capacity} future sections ready · {applied} imported", { ready: String(buffer.queue.length), capacity: String(buffer.capacity), applied: String(buffer.consumedCount) }) : t("Save a setup to prepare a bounded MIDI buffer."));
    const activeRefs = new Set(buffer?.queue.map((entry) => entry.artifactRef) ?? []);
    for (const key of previewRows.keys()) if (!activeRefs.has(key)) previewRows.delete(key);
    const rows: HTMLElement[] = [];
    for (const entry of buffer?.queue ?? []) {
      let details = previewRows.get(entry.artifactRef);
      if (!details) {
        details = node("details", "midi-continuation-section");
        details.append(node("summary", "", () => `${t("Section {number}", { number: String(entry.sequence + 1) })} · ${entry.label} · ${entry.noteCount} ${t("notes")}`));
        const preview = node("div", "midi-continuation-preview"); const previewButton = node("button", "secondary", () => t("Preview saved MIDI")); previewButton.type = "button";
        const suggested = buffer!.insertBeat + entry.sequence * buffer!.segmentBeats;
        details.append(node("p", "field-hint midi-continuation-range", () => t("Suggested Clip range: beats {start}–{end}", { start: String(suggested + 1), end: String(suggested + buffer!.segmentBeats + 1) })), previewButton, preview);
        previewButton.addEventListener("click", async () => {
          const owner = sessionId; const bufferId = buffer!.id; previewButton.disabled = true;
          try {
            const result = await deps.preview({ sessionId: owner, artifactRef: entry.artifactRef });
            if (!current(owner) || getView()?.buffer?.id !== bufferId || !getView()?.buffer?.queue.some((candidate) => candidate.artifactRef === entry.artifactRef)) return;
            if (!isMidiArtifactImportPreview(result) || result.sessionId !== owner || result.artifactRef !== entry.artifactRef) throw new Error(t("MIDI import preview is unavailable."));
            preview.replaceChildren(...result.parts.map((part) => node("p", "field-hint", () => `${t("Track")} ${part.sourceTrackIndex + 1} · ${part.sourceTrackName || "MIDI"} · ${t("Channel")} ${part.channel} · ${part.noteCount} ${t("notes")} · ${part.durationBeats} ${t("Beats")}`)));
          } catch (error) {
            if (current(owner)) preview.replaceChildren(node("p", "field-hint", () => error instanceof Error ? error.message : t("MIDI import preview failed.")));
          } finally { previewButton.disabled = false; }
        });
        previewRows.set(entry.artifactRef, details);
      }
      const suggested = buffer!.insertBeat + entry.sequence * buffer!.segmentBeats;
      bindings.text(details.querySelector(".midi-continuation-range")!, () => t("Suggested Clip range: beats {start}–{end}", { start: String(suggested + 1), end: String(suggested + buffer!.segmentBeats + 1) }));
      rows.push(details);
    }
    queue.replaceChildren(...rows);
    const head = buffer?.queue[0];
    const nextHeadKey = head ? JSON.stringify([buffer!.id, head.artifactRef, head.sequence, buffer!.insertBeat, buffer!.segmentBeats]) : "";
    if (nextHeadKey !== headKey) {
      headKey = nextHeadKey; importRegion.replaceChildren();
      if (head && buffer) {
        const owner = sessionId; const bufferId = buffer.id;
        importRegion.append(node("legend", "", () => t("Import the next section")), deps.resultActions.create("midi_continuation", {
          artifacts: [{ kind: "midi", artifactRef: head.artifactRef, label: head.label, noteCount: head.noteCount, durationBeats: buffer.segmentBeats }],
        }, { importOnly: true, initialStartBeat: buffer.insertBeat + head.sequence * buffer.segmentBeats,
          onImport: async (input) => {
            const current = getView();
            if (owner !== sessionId || input.sessionId !== owner || current?.stale || dirty || current?.buffer?.id !== bufferId || current.buffer.queue[0]?.artifactRef !== input.artifactRef) return false;
            return run({ ...input, kind: "import_midi_continuation", bufferId });
          } }));
      }
    }
    importRegion.hidden = !head;
  }
  function render() {
    bindings.refresh(content);
    parameterPanels.refreshLocale();
    const nextSession = deps.getState().activeSessionId;
    if (nextSession !== sessionId) {
      sessionId = nextSession; attempt++; pending = undefined; dirty = false; renderedView = ""; headKey = "";
      selected.clear(); previewRows.clear(); queue.replaceChildren(); importRegion.replaceChildren(); bindings.text(status, "");
    }
    const view = getView(); const key = JSON.stringify(view ?? null);
    if (key !== renderedView) {
      renderedView = key;
      if (!dirty) hydrateSetup(); else renderSources();
      renderQueue();
    }
    setup.hidden = !view; fillActions.hidden = !view?.buffer;
    if (view?.stale) bindings.text(status, () => t(view.staleReason === "generator_changed" ? "The generator changed. Reload and save the setup again before filling or importing."
      : view.staleReason === "source_changed" ? "Source Clips changed. Reload and save the setup again before filling or importing."
      : "The continuation source is unavailable. Reload before continuing."));
    syncControls();
  }
  load.addEventListener("click", () => { void run({ kind: "load_midi_continuation", sessionId }); });
  fill.addEventListener("click", () => { const buffer = getView()?.buffer; if (buffer && !fill.disabled) void run({ kind: "fill_midi_continuation", sessionId, bufferId: buffer.id }); });
  stop.addEventListener("click", () => { if (!stop.disabled && continuationCommands.has(operation.commandKind ?? "")) void deps.stop(); });
  save.addEventListener("click", () => { void configure(); });
  reset.addEventListener("click", () => { hydrateSetup(); syncControls(); });
  for (const control of [length, capacity, prompt]) control.addEventListener("input", () => { dirty = true; syncControls(); });
  parameters.addEventListener("input", () => { dirty = true; syncControls(); });
  parameters.addEventListener("change", () => { dirty = true; syncControls(); });
  generator.addEventListener("change", () => { dirty = true; renderParameters(); });
  return { render, setOperation(value: Operation) { operation = value; syncControls(); } };
}

export function createMidiContinuation(deps: Dependencies) {
  let view: ReturnType<typeof createView> | undefined;
  let operation: Operation = { busy: false, canStop: false, stopping: false };
  return {
    render() { if (!view) { view = createView(deps); view.setOperation(operation); } view.render(); },
    setOperation(value: Operation) { operation = value; view?.setOperation(value); },
  };
}
