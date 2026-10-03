import { artifactKey, pendingArtifactParentFromEvents, type ArtifactHistoryEvent, type ArtifactSelection } from "../../agent/artifact-contracts.js";
import type { SessionArtifact, SessionArtifacts } from "../../app/session/session-artifacts.js";
import type { PluginResultActions } from "./plugin-results.js";
import { isSessionArtifacts } from "./wire-contracts/artifacts.js";

interface Dependencies {
  getState(): { activeSessionId?: string; events?: ArtifactHistoryEvent[] };
  read(input: { sessionId: string; offset: number }): Promise<unknown>;
  select(input: { sessionId: string; selection: ArtifactSelection }): Promise<boolean>;
  transfer(kind: "export_midi_artifact" | "attach_midi_artifact", input: { sessionId: string; artifactRef: string }): Promise<boolean>;
  useInChat(text: string): Promise<void>;
  resultActions: PluginResultActions;
  audioUrl(sessionId: string, id: string): string;
  createAudioPlayer(sessionId: string, descriptor: { fileName: string; durationSeconds: number }, sourceUrl: string): { element: HTMLElement; media: HTMLAudioElement; dispose(): void };
}

function createArtifactComparisonView(deps: Dependencies) {
  const t = (value: string, params?: Record<string, string>) => window.LiveSmithI18n?.t(value, params) ?? value;
  const panel = document.getElementById("sessionArtifacts")!;
  const launcher = document.getElementById("artifactsButton") as HTMLButtonElement;
  let visible = false;
  const content = document.getElementById("artifactComparison")!;
  let sessionId: string | undefined;
  let snapshot: SessionArtifacts | undefined;
  let pending = false;
  let busy = false;
  let serial = 0;
  let continuationIdentity = "";
  const selected = new Map<string, SessionArtifact>();
  const cards = new Map<string, ReturnType<typeof createCard>>();
  const element = <T extends keyof HTMLElementTagNameMap>(tag: T, className: string, text?: string): HTMLElementTagNameMap[T] => {
    const node = document.createElement(tag); node.className = className; if (text !== undefined) node.textContent = text; return node;
  };
  const status = element("p", "field-hint"); status.setAttribute("role", "status");
  const controls = element("div", "artifact-controls");
  const pages = element("div", "artifact-page-controls");
  const choices = element("div", "artifact-choices");
  const comparison = element("div", "artifact-cards");
  const context = element("p", "field-hint");
  const clear = element("button", "secondary", t("Clear next-request source")); clear.type = "button";
  const load = element("button", "secondary", t("Refresh artifacts")); load.type = "button";
  const previous = element("button", "secondary", t("Previous page")); previous.type = "button";
  const next = element("button", "secondary", t("Next page")); next.type = "button";
  previous.hidden = next.hidden = true;
  pages.append(load, previous, next);
  const selectionCount = element("p", "field-hint artifact-selection-count"); selectionCount.setAttribute("role", "status");
  status.hidden = true;
  controls.append(pages, status, context, clear, choices, selectionCount, comparison); content.append(controls);
  const artifactLabel = (artifact: SessionArtifact) => artifact.version ? `${artifact.label} · v${artifact.version.number}` : artifact.label;
  const current = (id = sessionId) => Boolean(id) && id === deps.getState().activeSessionId;
  function syncBusy() {
    load.disabled = pending; previous.disabled = pending || !snapshot?.offset;
    next.disabled = pending || !snapshot || snapshot.offset + 24 >= snapshot.total;
    clear.disabled = pending || busy;
    for (const button of comparison.querySelectorAll<HTMLButtonElement>("[data-artifact-transfer]")) button.disabled = pending;
    for (const button of comparison.querySelectorAll<HTMLButtonElement>("[data-artifact-write]")) button.disabled = pending || busy;
  }
  async function read(offset = 0) {
    if (!current() || pending) return;
    const id = sessionId!; const attempt = ++serial; pending = true; syncBusy();
    status.hidden = false; status.textContent = t("Loading saved artifacts…");
    try {
      const result = await deps.read({ sessionId: id, offset });
      if (!current(id) || attempt !== serial) return;
      if (!isSessionArtifacts(result) || result.sessionId !== id) throw new Error(t("Artifact comparison is unavailable."));
      snapshot = result;
      for (const artifact of result.artifacts) if (selected.has(artifactKey(artifact.ref))) selected.set(artifactKey(artifact.ref), artifact);
      renderSnapshot();
      status.hidden = !result.unavailableCount && result.total > 0;
      status.textContent = result.unavailableCount ? t("Some saved artifacts are unavailable.") : result.total ? t("Choose up to four artifacts to compare.") : t("No saved audio or MIDI artifacts yet.");
    } catch (error) { if (current(id)) { status.hidden = false; status.textContent = error instanceof Error ? error.message : t("Artifact comparison is unavailable."); } }
    finally { if (attempt === serial) { pending = false; syncBusy(); } }
  }
  async function select(selection: ArtifactSelection, artifact?: SessionArtifact) {
    if (!current() || pending || busy) return;
    const id = sessionId!; const attempt = ++serial; pending = true; syncBusy();
    try {
      const saved = await deps.select({ sessionId: id, selection });
      if (!current(id)) return;
      if (!saved) { if (artifact) cards.get(artifactKey(artifact.ref))?.notify(t("Could not save the selection. Try again.")); return; }
      if (selection.action === "continue" && artifact) await deps.useInChat(
        artifact.ref.kind === "midi"
          ? t("Create a new version of saved MIDI artifact {reference}. Describe the changes:", { reference: artifact.ref.id })
          : t("Continue from saved audio asset {reference}. Describe the next variation or edit:", { reference: artifact.ref.id }));
    } finally { if (attempt === serial) { pending = false; syncBusy(); if (current(id)) void read(snapshot?.offset ?? 0); } }
  }
  async function transfer(kind: "export_midi_artifact" | "attach_midi_artifact", artifact: SessionArtifact) {
    if (!current() || pending) return;
    const id = sessionId!; const attempt = ++serial; pending = true; syncBusy();
    const card = cards.get(artifactKey(artifact.ref));
    card?.notify(t(kind === "export_midi_artifact" ? "Opening MIDI download…" : "Attaching MIDI…"));
    try {
      const completed = await deps.transfer(kind, { sessionId: id, artifactRef: artifact.ref.id });
      if (current(id)) card?.notify(t(completed
        ? kind === "export_midi_artifact" ? "MIDI download opened." : "MIDI attached to the next message."
        : "The MIDI transfer did not complete. Try again."));
    } catch { if (current(id)) card?.notify(t("The MIDI transfer did not complete. Try again.")); }
    finally { if (attempt === serial) { pending = false; syncBusy(); } }
  }
  const button = (label: string, action: () => void) => {
    const node = element("button", "secondary", t(label)); node.type = "button"; node.addEventListener("click", action); return node;
  };
  function createCard(artifact: SessionArtifact) {
      let player: ReturnType<Dependencies["createAudioPlayer"]> | undefined;
      let svg: SVGSVGElement | undefined;
      const card = element("article", "artifact-card");
      const title = element("h3", "", artifactLabel(artifact));
      const source = element("p", "field-hint", artifact.sourceLabel);
      const heading = element("div", "artifact-card-heading");
      const remove = button("Remove from comparison", () => {
        const key = artifactKey(artifact.ref); selected.delete(key); renderCards();
        (choices.querySelector<HTMLInputElement>(`input[value="${key}"]`) ?? load).focus();
      });
      remove.classList.add("artifact-remove"); remove.textContent = "×";
      remove.setAttribute("aria-label", t("Remove {name} from comparison", { name: artifactLabel(artifact) }));
      remove.title = t("Remove from comparison");
      heading.append(title, remove); card.append(heading, source);
      const isPreferred = () => Boolean(snapshot?.preferred && artifactKey(snapshot.preferred) === artifactKey(artifact.ref));
      const actions = element("div", "artifact-actions");
      const prefer = button("Mark preferred", () => { void select({ action: "prefer", candidate: isPreferred() ? null : artifact.ref }); });
      prefer.setAttribute("aria-pressed", String(isPreferred()));
      prefer.dataset.artifactWrite = "";
      const continueButton = button(artifact.ref.kind === "midi" ? "Create next version" : "Continue in chat", () => { void select({ action: "continue", candidate: artifact.ref }, artifact); });
      continueButton.dataset.artifactWrite = "";
      actions.append(prefer, continueButton);
      card.append(actions);
      const actionStatus = element("p", "field-hint"); actionStatus.hidden = true;
      actionStatus.setAttribute("role", "status"); actionStatus.setAttribute("aria-live", "polite");
      card.append(actionStatus);
      if (artifact.audio) {
        card.append(element("p", "field-hint", `${artifact.audio.durationSeconds.toFixed(1)} s · ${artifact.audio.mediaType === "audio/wav" ? "WAV" : "MP3"}`));
        player = deps.createAudioPlayer(sessionId!, { fileName: artifact.label, durationSeconds: artifact.audio.durationSeconds }, deps.audioUrl(sessionId!, artifact.ref.id));
        card.append(player.element);
        card.append(button("Prepare audio import in chat", () => {
          if (!current()) return;
          void deps.useInChat(t("Import saved audio asset {reference} into Live. Inspect the destination and preview affected tracks and Clips before applying. Destination and start beat:", { reference: artifact.ref.id }));
        }));
      }
      if (artifact.midi) {
        const transfers = element("div", "artifact-actions");
        transfers.append(button("Attach to message", () => { void transfer("attach_midi_artifact", artifact); }),
          button("Export MIDI", () => { void transfer("export_midi_artifact", artifact); }));
        for (const button of transfers.querySelectorAll("button")) button.dataset.artifactTransfer = "";
        card.append(transfers);
        const midi = artifact.midi;
        card.append(element("p", "field-hint", t("{notes} notes · {parts} parts · {beats} beats", {
          notes: String(midi.noteCount), parts: String(midi.parts.length), beats: String(midi.durationBeats) })));
        svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("viewBox", "0 0 640 140"); svg.setAttribute("preserveAspectRatio", "none");
        svg.setAttribute("aria-describedby", `artifact-scale-${artifact.ref.id}`); svg.setAttribute("role", "img");
        svg.setAttribute("aria-label", t("Saved MIDI note preview")); svg.classList.add("artifact-midi-preview");
        const figure = element("figure", "artifact-midi-chart"); figure.append(svg); card.append(figure);
        if (midi.omittedNoteCount) card.append(element("p", "field-hint", t("{count} notes omitted from this preview.", { count: String(midi.omittedNoteCount) })));
        const parts = element("details", "artifact-details"); parts.append(element("summary", "", t("Source parts")));
        for (const part of midi.parts) parts.append(element("p", "field-hint", `${part.sourceTrackIndex + 1} · ${part.sourceTrackName || "MIDI"} · ${t("Channel")} ${part.channel} · ${part.noteCount} · ${part.durationBeats}`));
        card.append(parts, deps.resultActions.create("saved_midi", { artifacts: [{ kind: "midi", artifactRef: artifact.ref.id,
          label: artifact.label, noteCount: midi.noteCount, durationBeats: midi.durationBeats }] }, { importOnly: true }));
      }
      const parentLabel = element("p", "field-hint"); card.append(parentLabel);
      const generation = element("details", "artifact-details"); generation.append(element("summary", "", t("Generation parameters")));
      const parameters = element("pre", "");
      const shortened = element("p", "field-hint", t("Parameters are shortened here; the original tool call remains in Session history."));
      generation.append(parameters, shortened); card.append(generation);
      return { element: card,
        notify(message: string) { actionStatus.hidden = false; actionStatus.textContent = message; },
        pause() { player?.media.pause(); },
        dispose() { player?.dispose(); card.remove(); },
        update(value: SessionArtifact, scale: MidiScale) {
          artifact = value; title.textContent = artifactLabel(value); source.textContent = value.sourceLabel;
          prefer.textContent = t(isPreferred() ? "Clear preferred" : "Mark preferred");
          prefer.setAttribute("aria-pressed", String(isPreferred()));
          parameters.textContent = value.generation?.parameters ?? t("Original generation parameters are unavailable.");
          shortened.hidden = !value.generation?.parametersTruncated;
          parentLabel.hidden = !value.parent;
          if (value.parent) {
            const parent = [...selected.values(), ...(snapshot?.artifacts ?? [])].find((entry) => artifactKey(entry.ref) === artifactKey(value.parent!));
            parentLabel.textContent = t("Source artifact: {name}", { name: parent ? artifactLabel(parent) : t("Saved source artifact") });
          }
          if (svg && value.midi) renderMidiComparison(svg, value.midi, scale, t);
        },
      };
  }
  function renderCards() {
    for (const [key, card] of cards) if (!selected.has(key)) { card.dispose(); cards.delete(key); }
    const scale = midiComparisonScale([...selected.values()]);
    for (const [key, artifact] of selected) {
      let card = cards.get(key);
      if (!card) { card = createCard(artifact); cards.set(key, card); comparison.append(card.element); }
      card.update(artifact, scale);
    }
    for (const checkbox of choices.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
      checkbox.checked = selected.has(checkbox.value);
      checkbox.disabled = !checkbox.checked && selected.size >= 4;
    }
    selectionCount.hidden = !snapshot?.total && !selected.size;
    selectionCount.textContent = t("{count} / 4 selected", { count: String(selected.size) });
    syncBusy();
  }
  function renderSnapshot() {
    choices.replaceChildren();
    previous.hidden = next.hidden = !snapshot || snapshot.total <= 24;
    previous.disabled = !snapshot?.offset; next.disabled = !snapshot || snapshot.offset + 24 >= snapshot.total;
    renderContext();
    const groups = new Map<string, SessionArtifact[]>();
    for (const artifact of snapshot?.artifacts ?? []) {
      const key = artifact.version?.groupId ?? artifactKey(artifact.ref);
      const group = groups.get(key) ?? [];
      group.push(artifact); groups.set(key, group);
    }
    for (const group of groups.values()) {
      const container = element("div", "artifact-version-group");
      if (group[0]?.version) container.append(element("strong", "", group[0].version.groupLabel));
      for (const artifact of group.sort((a, b) => (a.version?.number ?? 0) - (b.version?.number ?? 0))) {
        const label = element("label", "artifact-choice"); const checkbox = element("input", ""); checkbox.type = "checkbox";
        const key = artifactKey(artifact.ref); checkbox.value = key; checkbox.checked = selected.has(key);
        label.append(checkbox, element("span", "", artifactLabel(artifact) + (artifact.preferred ? " · " + t("Preferred") : "")));
        checkbox.addEventListener("change", () => {
          if (checkbox.checked && selected.size >= 4) { checkbox.checked = false; return; }
          if (checkbox.checked) selected.set(key, artifact); else selected.delete(key);
          renderCards();
        });
        container.append(label);
      }
      choices.append(container);
    }
    renderCards();
  }
  function renderContext() {
    clear.hidden = !snapshot?.continuation;
    const source = snapshot?.continuation && [...selected.values(), ...(snapshot?.artifacts ?? [])].find((entry) => artifactKey(entry.ref) === artifactKey(snapshot!.continuation!));
    context.textContent = snapshot?.continuation ? t("Next request starts from: {name}", { name: source ? artifactLabel(source) : t("Saved source artifact") }) : t("Choose up to four artifacts to compare or use in your next message.");
  }
  load.addEventListener("click", () => { void read(snapshot?.offset ?? 0); });
  previous.addEventListener("click", () => { void read(Math.max(0, (snapshot?.offset ?? 0) - 24)); });
  next.addEventListener("click", () => { void read((snapshot?.offset ?? 0) + 24); });
  clear.addEventListener("click", () => { void select({ action: "continue", candidate: null }); });
  return {
    render() {
      const continuation = pendingArtifactParentFromEvents(deps.getState().events ?? []);
      const identity = continuation ? artifactKey(continuation) : "";
      if (sessionId !== deps.getState().activeSessionId) {
        serial++; pending = false; sessionId = deps.getState().activeSessionId; snapshot = undefined; selected.clear();
        status.textContent = ""; renderSnapshot();
        if (visible) void read();
      }
      if (continuationIdentity !== identity && snapshot) {
        if (continuation) snapshot.continuation = continuation; else delete snapshot.continuation;
        renderContext();
      }
      continuationIdentity = identity;
      panel.hidden = !sessionId; launcher.disabled = !sessionId; syncBusy();
    },
    setBusy(value: boolean) { busy = value; syncBusy(); },
    setVisible(value: boolean) {
      const opening = value && !visible;
      visible = value;
      if (opening && !pending) void read(snapshot?.offset ?? 0);
      if (!visible) for (const card of cards.values()) card.pause();
    },
  };
}
function createArtifactComparison(deps: Dependencies) {
  let view: ReturnType<typeof createArtifactComparisonView> | undefined;
  let busy = false;
  return {
    render() {
      if (!view) { view = createArtifactComparisonView(deps); view.setBusy(busy); }
      view.render();
    },
    setBusy(value: boolean) { busy = value; view?.setBusy(value); },
    setVisible(value: boolean) {
      if (!view) { view = createArtifactComparisonView(deps); view.setBusy(busy); view.render(); }
      view.setVisible(value);
    },
  };
}
window.LiveSmithFactories = window.LiveSmithFactories || {};
window.LiveSmithFactories.createArtifactComparison = createArtifactComparison;

interface MidiScale { low: number; high: number; beats: number }
function midiComparisonScale(artifacts: SessionArtifact[]): MidiScale {
  const midi = artifacts.flatMap((artifact) => artifact.midi ? [artifact.midi] : []);
  const pitches = midi.flatMap((value) => value.notes.map((note) => note.pitch));
  const low = pitches.length ? Math.max(0, Math.floor(Math.min(...pitches) / 12) * 12) : 60;
  const high = pitches.length ? Math.min(127, Math.ceil((Math.max(...pitches) + 1) / 12) * 12 - 1) : 71;
  return { low, high, beats: Math.max(1, ...midi.map((value) => value.durationBeats)) };
}
function renderMidiComparison(svg: SVGSVGElement, midi: NonNullable<SessionArtifact["midi"]>, scale: MidiScale,
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
  const pitches = axis("div", "artifact-midi-pitches");
  const ticks = axis("div", "artifact-midi-beats");
  const caption = axis("figcaption", "artifact-midi-scale");
  caption.id = svg.getAttribute("aria-describedby")!;
  const x = (beat: number) => beat / scale.beats * 640;
  const row = 140 / (scale.high - scale.low + 1);
  const y = (pitch: number) => (scale.high - pitch) * row;
  svg.replaceChildren();
  if (midi.durationBeats < scale.beats) svg.append(node("rect", { x: x(midi.durationBeats), y: 0,
    width: x(scale.beats) - x(midi.durationBeats), height: 140, class: "artifact-midi-unused" }));
  for (const pitch of new Set([scale.low, Math.round((scale.low + scale.high) / 2), scale.high])) {
    svg.append(node("line", { x1: 0, x2: 640, y1: y(pitch) + row / 2, y2: y(pitch) + row / 2, class: "artifact-midi-grid" }));
    const label = document.createElement("span"); label.textContent = String(pitch);
    label.style.top = `${(y(pitch) + row / 2) / 140 * 100}%`; pitches.append(label);
  }
  const step = 2 ** Math.ceil(Math.log2(scale.beats / 4));
  const beats = new Set([0, scale.beats]);
  for (let beat = step; beat < scale.beats - step / 3; beat += step) beats.add(beat);
  for (const beat of beats) {
    svg.append(node("line", { x1: x(beat), x2: x(beat), y1: 0, y2: 140, class: "artifact-midi-grid" }));
    const label = document.createElement("span"); label.textContent = number(beat + 1);
    label.style.left = `${beat / scale.beats * 100}%`;
    label.style.transform = `translateX(${beat === scale.beats ? -100 : beat === 0 ? 0 : -50}%)`;
    ticks.append(label);
  }
  for (const note of midi.notes) {
    const rectangle = node("rect", { x: x(note.startTime), y: y(note.pitch), width: Math.max(1, note.duration / scale.beats * 640),
      height: Math.max(1, row * .78), class: "artifact-midi-note", "data-pitch": note.pitch });
    rectangle.append(node("title", {}, t("Pitch {pitch} · beat {beat} · length {length}", {
      pitch: String(note.pitch), beat: number(note.startTime + 1), length: number(note.duration),
    })));
    svg.append(rectangle);
  }
  caption.textContent = t("Shared scale · beats 1–{end} · MIDI pitches {low}–{high}", {
    end: number(scale.beats + 1), low: String(scale.low), high: String(scale.high),
  });
}
