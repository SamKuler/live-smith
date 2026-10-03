export interface PianoRollNote {
  pitch: number;
  startTime: number;
  duration: number;
  velocity?: number;
  muted?: boolean;
  layer?: "before" | "after";
  description?: string;
}
export interface MidiPianoRollData {
  notes: readonly PianoRollNote[];
  durationBeats: number;
  /** Fix comparison views to the same pitch domain while their visible notes change. */
  pitchRange?: { low: number; high: number };
}

interface MidiScale { low: number; high: number; beats: number; startBeat?: number }
function midiScale(midi: MidiPianoRollData): MidiScale {
  let low = 127, high = 0;
  for (const note of midi.notes) { low = Math.min(low, note.pitch); high = Math.max(high, note.pitch); }
  if (midi.pitchRange) ({ low, high } = midi.pitchRange);
  return { low: low > high ? 60 : Math.floor(low / 12) * 12,
    high: low > high ? 71 : Math.min(127, Math.ceil((high + 1) / 12) * 12 - 1), beats: Math.max(1, midi.durationBeats) };
}
function midiNoteName(pitch: number): string {
  return `${["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"][pitch % 12]}${Math.floor(pitch / 12) - 2}`;
}
function renderMidiPreview(svg: SVGSVGElement, midi: MidiPianoRollData, scale: MidiScale,
  t: (text: string, values?: Record<string, string>) => string) {
  const ns = "http://www.w3.org/2000/svg";
  const node = (tag: string, attributes: Record<string, number | string>, text?: string) => {
    const element = document.createElementNS(ns, tag);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const number = (value: number) => new Intl.NumberFormat(document.documentElement.lang || undefined, { maximumSignificantDigits: 5 }).format(value);
  const figure = svg.parentElement!;
  const axis = (tag: string, className: string) => {
    let value = figure.querySelector<HTMLElement>(`.${className}`);
    if (!value) { value = document.createElement(tag); value.className = className; figure.append(value); }
    value.replaceChildren(); return value;
  };
  const keyboard = axis("div", "piano-roll-keyboard"); keyboard.setAttribute("aria-hidden", "true");
  const ticks = axis("div", "piano-roll-beats");
  const caption = axis("figcaption", "piano-roll-scale");
  caption.id = svg.getAttribute("aria-describedby")!;
  const pitchCount = scale.high - scale.low + 1;
  const height = Math.max(144, Math.min(288, pitchCount * 8));
  figure.style.setProperty("--piano-roll-height", `${height}px`);
  svg.setAttribute("viewBox", `0 0 640 ${height}`);
  const start = scale.startBeat ?? 0;
  const end = start + scale.beats;
  const x = (beat: number) => (beat - start) / scale.beats * 640;
  const row = height / pitchCount;
  const y = (pitch: number) => (scale.high - pitch) * row;
  const accidental = (pitch: number) => [1, 3, 6, 8, 10].includes(pitch % 12);
  const naturalPitches: number[] = [];
  svg.replaceChildren();
  for (let pitch = scale.high; pitch >= scale.low; pitch--) {
    if (!accidental(pitch)) naturalPitches.push(pitch);
    svg.append(node("rect", { x: 0, y: y(pitch), width: 640, height: row,
      class: accidental(pitch) ? "piano-roll-row accidental" : "piano-roll-row" }));
    if (pitch % 12 === 0) svg.append(node("line", { x1: 0, x2: 640, y1: y(pitch) + row, y2: y(pitch) + row, class: "piano-roll-grid" }));
  }
  for (const [index, pitch] of naturalPitches.entries()) {
    const top = index === 0 ? 0 : (y(naturalPitches[index - 1]!) + y(pitch) + row) / 2;
    const bottom = index === naturalPitches.length - 1 ? height : (y(pitch) + y(naturalPitches[index + 1]!) + row) / 2;
    const key = document.createElement("span"); key.className = "piano-roll-key";
    key.style.top = `${top / height * 100}%`; key.style.height = `${(bottom - top) / height * 100}%`;
    key.title = `${midiNoteName(pitch)} (${pitch})`;
    if (pitch % 12 === 0) key.textContent = midiNoteName(pitch);
    keyboard.append(key);
  }
  for (let pitch = scale.high; pitch >= scale.low; pitch--) {
    if (!accidental(pitch)) continue;
    const key = document.createElement("span"); key.className = "piano-roll-key accidental";
    key.style.top = `${y(pitch) / height * 100}%`; key.style.height = `${row / height * 100}%`;
    key.title = `${midiNoteName(pitch)} (${pitch})`; keyboard.append(key);
  }
  const minorStep = Math.max(.25, 2 ** Math.ceil(Math.log2(scale.beats / 16)));
  for (let beat = Math.ceil(start / minorStep) * minorStep; beat < end; beat += minorStep) {
    svg.append(node("line", { x1: x(beat), x2: x(beat), y1: 0, y2: height, class: "piano-roll-grid minor" }));
  }
  const step = 2 ** Math.ceil(Math.log2(scale.beats / 4));
  const beats = new Set([start, end]);
  for (let beat = Math.ceil(start / step) * step; beat < end - step / 3; beat += step) {
    if (beat > start + step / 3) beats.add(beat);
  }
  for (const beat of [...beats].sort((a, b) => a - b)) {
    svg.append(node("line", { x1: x(beat), x2: x(beat), y1: 0, y2: height, class: "piano-roll-grid" }));
    const label = document.createElement("span"); label.textContent = number(beat + 1);
    label.style.left = `${(beat - start) / scale.beats * 100}%`;
    label.style.transform = `translateX(${beat === end ? -100 : beat === start ? 0 : -50}%)`;
    ticks.append(label);
  }
  for (const note of midi.notes) {
    const left = Math.max(start, note.startTime);
    const right = Math.min(end, note.startTime + note.duration);
    if (right <= left) continue;
    const rectangle = node("rect", { x: x(left), y: y(note.pitch) + row * .1,
      width: Math.min(640 - x(left), Math.max(1, (right - left) / scale.beats * 640)), height: Math.max(1, row * .8), rx: 1,
      class: `piano-roll-note${note.layer ? ` ${note.layer}` : ""}`, "data-pitch": note.pitch });
    (rectangle as SVGElement).style.opacity = String(note.muted ? .25 : note.velocity === undefined ? .8 : .3 + note.velocity / 127 * .7);
    rectangle.append(node("title", {}, note.description ?? t("Pitch {pitch} · beat {beat} · length {length}", {
      pitch: `${midiNoteName(note.pitch)} (${note.pitch})`, beat: number(note.startTime + 1), length: number(note.duration),
    })));
    svg.append(rectangle);
  }
  caption.textContent = t("Beats {start}–{end} · {low}–{high}", {
    start: number(start + 1), end: number(end + 1), low: midiNoteName(scale.low), high: midiNoteName(scale.high),
  });
}


/** A read-only note viewport. Callers supply notes and presentation labels, not host or storage services. */
export function createMidiPianoRoll(input: { id: string; label(): string; focusLabel?(): string }) {
  const t = (text: string, values?: Record<string, string>) => window.LiveSmithI18n?.t(text, values) ?? text;
  const root = document.createElement("div"); root.className = "midi-piano-roll";
  const controls = document.createElement("div"); controls.className = "piano-roll-controls";
  const makeButton = (className: string, action: () => void) => {
    const button = document.createElement("button"); button.type = "button";
    button.className = `secondary ${className}`; button.addEventListener("click", action); return button;
  };
  const zoomOut = makeButton("piano-roll-zoom-out", () => zoom(span * 2)); zoomOut.textContent = "−";
  const zoomIn = makeButton("piano-roll-zoom-in", () => zoom(span / 2)); zoomIn.textContent = "+";
  const width = document.createElement("output"); width.className = "piano-roll-span";
  const focus = makeButton("piano-roll-focus", () => { focusNotes(); render(); });
  const full = makeButton("piano-roll-full", () => { start = 0; span = total(); render(); });
  controls.append(zoomOut, width, zoomIn, focus, full);
  const figure = document.createElement("figure"); figure.className = "piano-roll-chart";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.id = input.id; svg.classList.add("piano-roll-canvas"); svg.setAttribute("role", "img");
  svg.setAttribute("preserveAspectRatio", "none"); svg.setAttribute("aria-describedby", `${input.id}-scale`);
  figure.append(svg);
  const position = document.createElement("input"); position.type = "range"; position.className = "piano-roll-position";
  position.min = "0"; position.step = "any"; position.setAttribute("aria-controls", input.id);
  root.append(controls, figure, position);
  let data: MidiPianoRollData | undefined;
  let start = 0;
  let span = 1;
  const total = () => Math.max(1, data?.durationBeats ?? 1);
  const clamp = () => { span = Math.max(.25, Math.min(total(), span)); start = Math.max(0, Math.min(total() - span, start)); };
  const number = (value: number) => new Intl.NumberFormat(document.documentElement.lang || undefined, { maximumFractionDigits: 4 }).format(value);
  function focusNotes() {
    span = Math.min(total(), 16);
    const first = data?.notes.reduce((value, note) => Math.min(value, note.startTime), Infinity) ?? Infinity;
    start = Number.isFinite(first) ? Math.floor(Math.max(0, first - span / 8) * 4) / 4 : 0;
    clamp();
  }
  function render() {
    if (!data) return;
    clamp();
    svg.setAttribute("aria-label", input.label());
    const bounds = { start: number(start + 1), end: number(start + span + 1) };
    position.max = String(total() - span); position.value = String(start); position.hidden = span >= total();
    position.style.setProperty("--piano-roll-thumb-width", `${span / total() * 100}%`);
    position.setAttribute("aria-label", t("Scroll piano roll")); position.setAttribute("aria-valuetext", t("Beats {start}–{end}", bounds));
    width.textContent = t("{beats} beats", { beats: number(span) });
    zoomOut.disabled = span >= total(); zoomIn.disabled = span <= .25;
    zoomOut.setAttribute("aria-label", t("Zoom out")); zoomOut.title = t("Zoom out");
    zoomIn.setAttribute("aria-label", t("Zoom in")); zoomIn.title = t("Zoom in");
    focus.textContent = input.focusLabel?.() ?? t("Focus notes"); focus.disabled = data.notes.length === 0;
    full.textContent = t("Full view");
    renderMidiPreview(svg, data, { ...midiScale(data), startBeat: start, beats: span }, t);
  }
  function zoom(nextSpan: number) {
    span = Math.max(.25, Math.min(total(), nextSpan)); render();
  }
  function pan(nextStart: number) { start = nextStart; render(); }
  position.addEventListener("input", () => pan(Number(position.value)));
  position.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    pan(event.key === "Home" ? 0 : event.key === "End" ? total() - span : start + (event.key === "ArrowLeft" ? -1 : 1) * span / 4);
  });
  figure.addEventListener("wheel", (event) => {
    if (event.ctrlKey || event.metaKey || span >= total()) return;
    const delta = event.deltaX || (event.shiftKey ? event.deltaY : 0);
    if (!delta) return;
    const pixels = event.deltaMode === 1 ? delta * 16 : event.deltaMode === 2 ? delta * (svg.clientWidth || 640) : delta;
    event.preventDefault(); pan(start + pixels / (svg.clientWidth || 640) * span);
  }, { passive: false });
  return {
    element: root,
    update(value: MidiPianoRollData, resetView = false) {
      const first = !data; data = value;
      if (first || resetView) focusNotes();
      render();
    },
  };
}
