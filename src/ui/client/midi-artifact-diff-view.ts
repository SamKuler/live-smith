import { createMidiPianoRoll, type PianoRollNote } from "./midi-piano-roll.js";
import { createLocaleBindings, type LocalizedText } from "./locale-bindings.js";
import type { SessionArtifact } from "../../app/session/session-artifacts.js";
import type { MidiArtifactDiff, MidiArtifactNote, MidiArtifactPartDiff } from "../../app/midi/midi-artifact-diff.js";
import { isMidiArtifactDiff } from "./wire-contracts/midi-artifact-diff.js";

export function createMidiArtifactDiffView(input: {
  sessionId: string;
  artifact: SessionArtifact;
  read(request: { sessionId: string; artifactRef: string; baseArtifactRef?: string }, signal?: AbortSignal): Promise<unknown>;
  isCurrent(): boolean;
  onToggle(open: boolean): void;
}) {
  const bindings = createLocaleBindings();
  const t = (text: string, values?: Record<string, string>) => window.LiveSmithI18n?.t(text, values) ?? text;
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: LocalizedText) => {
    const element = document.createElement(tag); element.className = className;
    if (text !== undefined) bindings.text(element, text);
    return element;
  };
  const detail = node("details", "artifact-details artifact-diff");
  let artifact = input.artifact;
  let alternatives: NonNullable<SessionArtifact["versions"]> = [];
  detail.append(node("summary", "", () => t("Version comparison")));
  const baselineField = node("label", "artifact-version-field artifact-diff-baseline");
  baselineField.append(node("span", "", () => t("Compare against")));
  const baseline = node("select", "");
  baselineField.append(baseline);
  const status = node("p", "field-hint"); status.setAttribute("role", "status"); status.hidden = true;
  const retry = node("button", "secondary", () => t("Retry differences")); retry.type = "button"; retry.hidden = true;
  const content = node("div", "artifact-diff-content");
  detail.append(baselineField, status, retry, content);
  let controller: AbortController | undefined;
  let loaded = false;
  const number = (value: number) => new Intl.NumberFormat(document.documentElement.lang || undefined, { maximumFractionDigits: 5 }).format(value);
  const pitch = (value: number) => `${["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"][value % 12]}${Math.floor(value / 12) - 2}`;
  const noteText = (note: MidiArtifactNote) => t("{pitch} · beat {beat} · length {length} · velocity {velocity}", {
    pitch: pitch(note.pitch), beat: number(note.startTime + 1), length: number(note.duration), velocity: String(note.velocity),
  });
  let refreshPreview: (() => void) | undefined;
  const transposeText = (semitones: number) => t(semitones > 0 ? "Up {count} semitones" : "Down {count} semitones", { count: String(Math.abs(semitones)) });
  function partSummary(part: MidiArtifactPartDiff): string {
    if (part.transposeSemitones) return transposeText(part.transposeSemitones);
    const changes = [
      [part.properties.pitch, "{count} pitches changed"],
      [part.properties.startTime, "{count} notes moved"],
      [part.properties.duration, "{count} lengths changed"],
      [part.properties.velocity, "{count} velocities changed"],
      [part.added, "{count} notes added"],
      [part.removed, "{count} notes removed"],
    ] as const;
    return changes.filter(([count]) => count > 0).map(([count, key]) => t(key, { count: String(count) })).join(" · ") ||
      t(part.before?.label !== part.after?.label ? "Part renamed" : "No note changes");
  }
  function render(result: MidiArtifactDiff) {
    content.replaceChildren(); refreshPreview = undefined;
    const changedParts = result.parts.filter((part) => !part.before || !part.after || part.added || part.removed || part.modified || part.before.label !== part.after.label);
    const uniformTranspose = result.parts[0]?.transposeSemitones;
    const allTransposed = uniformTranspose && result.parts.every((part) => part.transposeSemitones === uniformTranspose);
    if (allTransposed || !changedParts.length) content.append(node("p", "artifact-diff-overview", () => allTransposed
      ? transposeText(uniformTranspose) : t("No note changes")));
    if (result.beforeDurationBeats !== result.afterDurationBeats) content.append(node("p", "field-hint", () => t("Length: {before} → {after} beats", {
      before: number(result.beforeDurationBeats), after: number(result.afterDurationBeats),
    })));
    if (!changedParts.length) return;
    const partField = node("label", "artifact-version-field");
    partField.append(node("span", "", () => t("Part")));
    const selector = node("select", "artifact-diff-part-select");
    changedParts.forEach((part, index) => {
      const identity = part.after ?? part.before!;
      const label = () => identity.label || t("Channel {channel}", { channel: String(identity.channel) });
      const option = node("option", "", () => !part.before ? t("Added: {part}", { part: label() }) : !part.after ? t("Removed: {part}", { part: label() }) : label());
      option.value = String(index); selector.append(option);
    });
    partField.append(selector); content.append(partField);
    const preview = node("div", "artifact-diff-part"); content.append(preview);
    function showPart() {
      const part = changedParts[Number(selector.value)]!;
      preview.replaceChildren();
      if (!allTransposed) preview.append(node("p", "artifact-diff-part-summary", () => partSummary(part)));
      if (!part.changes.length) { refreshPreview = undefined; return; }
      const legend = node("div", "artifact-diff-legend");
      legend.append(node("span", "before", () => t("v{version} · before", { version: String(result.baseVersion) })),
        node("span", "after", () => t("v{version} · after", { version: String(result.version) })));
      preview.append(legend);
      const pianoRoll = createMidiPianoRoll({ id: `midi-diff-${artifact.ref.id}-${selector.value}`,
        label: () => t("Changed notes before and after"), focusLabel: () => t("Focus changes") });
      pianoRoll.element.classList.add("artifact-diff-chart"); preview.append(pianoRoll.element);
      refreshPreview = () => {
        const before: PianoRollNote[] = [], after: PianoRollNote[] = [];
        for (const change of part.changes) {
          const description = change.kind === "modified"
            ? t("Before: {note}", { note: noteText(change.before) }) + "\n" + t("After: {note}", { note: noteText(change.after) })
            : noteText(change.kind === "added" ? change.after : change.before);
          if (change.kind !== "added") before.push({ ...change.before, layer: "before", description });
          if (change.kind !== "removed") after.push({ ...change.after, layer: "after", description });
        }
        const midi = { notes: [...before, ...after], durationBeats: Math.max(result.beforeDurationBeats, result.afterDurationBeats) };
        pianoRoll.update(midi);
      };
      refreshPreview();
      preview.append(node("p", "field-hint", () => t("Changed notes only")));
    }
    selector.addEventListener("change", showPart); showPart();
  }
  async function read() {
    if (controller || loaded || !detail.open || !input.isCurrent()) return;
    const baseArtifactRef = baseline.value;
    if (!baseArtifactRef) return;
    const attempt = new window.AbortController(); controller = attempt;
    status.hidden = false; bindings.text(status, () => t("Reading version differences…")); retry.hidden = true;
    try {
      const result = await input.read({ sessionId: input.sessionId, artifactRef: artifact.ref.id, baseArtifactRef }, attempt.signal);
      if (!input.isCurrent() || controller !== attempt) return;
      if (!isMidiArtifactDiff(result) || result.sessionId !== input.sessionId || result.artifactRef !== artifact.ref.id ||
          result.baseArtifactRef !== baseArtifactRef) throw new Error(t("Version differences are unavailable."));
      render(result); loaded = true; status.hidden = true;
    } catch (error) {
      if (input.isCurrent() && controller === attempt) {
        bindings.text(status, () => error instanceof Error ? t(error.message) : t("Version differences are unavailable.")); retry.hidden = false;
      }
    } finally { if (controller === attempt) controller = undefined; }
  }
  function abort() { controller?.abort(); controller = undefined; }
  detail.addEventListener("toggle", () => { input.onToggle(detail.open); if (detail.open) void read(); else abort(); });
  baseline.addEventListener("change", () => {
    abort(); loaded = false; content.replaceChildren(); refreshPreview = undefined; void read();
  });
  retry.addEventListener("click", () => { void read(); });
  function update(value: SessionArtifact) {
    if (bindings.refresh(detail)) refreshPreview?.();
    const selected = baseline.value;
    const wasAvailable = alternatives.some((version) => version.id === selected);
    artifact = value;
    alternatives = (value.versions ?? []).filter((version) => version.id !== value.ref.id);
    const parentId = value.version?.derivedFromId;
    const options = alternatives.map((version) => ({ id: version.id, label: `v${version.number} · ${version.label}` }));
    if (parentId && !alternatives.some((version) => version.id === parentId)) {
      options.push({ id: parentId, label: t("Source version unavailable") });
    }
    if (JSON.stringify([...baseline.options].map((option) => [option.value, option.textContent])) !==
        JSON.stringify(options.map((option) => [option.id, option.label]))) {
      baseline.replaceChildren(...options.map((entry) => {
        const option = node("option", "", entry.label); option.value = entry.id; return option;
      }));
    }
    baseline.value = options.some((option) => option.id === selected) ? selected : parentId ?? options[0]?.id ?? "";
    if (selected && (selected !== baseline.value || wasAvailable && !alternatives.some((version) => version.id === selected))) {
      abort(); loaded = false; content.replaceChildren(); refreshPreview = undefined; status.hidden = true; retry.hidden = true;
      void read();
    }
  }
  update(artifact);
  return { element: detail, update, resume() { if (retry.hidden) void read(); }, dispose: abort };
}
