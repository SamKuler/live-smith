import type { AgentActionPreview, MidiActionPreview, MidiPreviewNote } from "../../agent/action-preview.js";
import { createLocaleBindings, type LocalizedText } from "./locale-bindings.js";
import { createMidiPianoRoll } from "./midi-piano-roll.js";

let nextPreviewId = 0;

export function createActionPreview() {
  const refreshers = new WeakMap<Element, () => void>();
  const t = (text: string, values?: Record<string, string>) => window.LiveSmithI18n?.t(text, values) ?? text;
  const number = (value: number) => new Intl.NumberFormat(document.documentElement.lang || undefined, { maximumSignificantDigits: 8 }).format(value);

  function render(preview: AgentActionPreview) {
    const bindings = createLocaleBindings();
    const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: LocalizedText, className = "") => {
      const element = document.createElement(tag); element.className = className;
      if (text !== undefined) bindings.text(element, text);
      return element;
    };
    const card = node("article", undefined, "action-preview");
    card.dataset.previewKind = preview.kind;
    card.append(node("h3", () => t("Proposed changes")), node("p", preview.targetLabel));
    let refreshMidi: (() => void) | undefined;
    if (preview.kind === "midi-notes") {
      let selected: "before" | "after" = "after";
      let low = 127, high = 0;
      for (const side of [preview.before, preview.after]) for (const note of side.notes) {
        low = Math.min(low, note.pitch); high = Math.max(high, note.pitch);
      }
      const pitchRange = low > high ? { low: 60, high: 71 } : { low, high };
      card.append(node("p", () => t("Clip beats {start}–{end}", {
        start: number(preview.range.start + 1), end: number(preview.range.end + 1),
      }), "preview-coordinate"));
      const sides = node("div", undefined, "midi-preview-switch");
      sides.setAttribute("role", "group");
      bindings.attribute(sides, "aria-label", () => t("Proposed changes"));
      const id = `action-preview-${++nextPreviewId}`;
      const sideLabel = (side: "before" | "after") => t(side === "before" ? "Before" : "Proposed after");
      const buttons = (["before", "after"] as const).map((side) => {
        const button = node("button", () => t("{label} · {count} notes", {
          label: sideLabel(side), count: number(preview[side].totalNoteCount),
        }), "secondary");
        button.type = "button"; button.dataset.side = side; button.setAttribute("aria-controls", id);
        button.addEventListener("click", () => { selected = side; refreshMidi?.(); });
        sides.append(button); return button;
      });
      const pianoRoll = createMidiPianoRoll({ id, label: () => t("{label}: {count} notes. Clip beats {start} to {end}. {omitted} notes omitted from this preview.", {
        label: sideLabel(selected), count: number(preview[selected].totalNoteCount),
        start: number(preview.range.start + 1), end: number(preview.range.end + 1), omitted: number(preview[selected].omittedNoteCount),
      }) });
      const limits = node("p", undefined, "preview-limits");
      limits.setAttribute("role", "status");
      const empty = node("p", () => t("No notes."));
      const noteText = (note: MidiPreviewNote, format: (value: number) => string) => t("Pitch {pitch} · beat {beat} · length {length}", {
        pitch: String(note.pitch), beat: format(note.startTime + 1), length: format(note.duration),
      }) + (note.velocity === undefined ? t(" · velocity unreported") : t(" · velocity {velocity}", { velocity: format(note.velocity) })) +
        (note.muted ? t(" · muted") : "");
      refreshMidi = () => {
        const side: MidiActionPreview["before"] = preview[selected];
        const format = new Intl.NumberFormat(document.documentElement.lang || undefined, { maximumSignificantDigits: 8 }).format;
        for (const button of buttons) button.setAttribute("aria-pressed", String(button.dataset.side === selected));
        pianoRoll.update({ notes: side.notes.map((note) => ({ ...note, description: noteText(note, format) })), durationBeats: preview.range.end, pitchRange });
        limits.hidden = side.omittedNoteCount === 0;
        limits.textContent = side.omittedNoteCount ? t("{omitted} notes omitted; showing {shown} of {total}.", {
          omitted: number(side.omittedNoteCount), shown: number(side.notes.length), total: number(side.totalNoteCount),
        }) : "";
        empty.hidden = side.totalNoteCount !== 0;
      };
      card.append(sides, pianoRoll.element, limits, empty);
      refreshMidi();
    } else {
      card.append(node("h4", preview.parameterName));
      card.append(node("p", `${preview.before} → ${preview.after}`, "parameter-preview-values"));
      card.append(node("p", () => t("Raw parameter values · range {minimum}–{maximum}", {
        minimum: String(preview.minimum), maximum: String(preview.maximum),
      }), "preview-coordinate"));
      if (preview.valueItems?.length) {
        const details = node("details");
        details.append(node("summary", () => t("Observed value labels")));
        const labels = node("ul");
        for (const item of preview.valueItems) labels.append(node("li", item.name || item.shortName));
        details.append(labels); card.append(details);
      }
    }
    refreshers.set(card, () => { if (bindings.refresh(card)) refreshMidi?.(); });
    return card;
  }

  return {
    render,
    refreshLocale(root: Element) {
      refreshers.get(root)?.();
      for (const card of root.querySelectorAll(".action-preview")) refreshers.get(card)?.();
    },
  };
}
