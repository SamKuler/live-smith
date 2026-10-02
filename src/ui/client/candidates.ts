import { candidateKey, pendingCandidateParentFromEvents, type CandidateHistoryEvent, type CandidateSelection } from "../../agent/candidate-contracts.js";
import type { SessionCandidate, SessionCandidates } from "../../app/session/session-candidates.js";
import type { PluginResultActions } from "./plugin-results.js";
import { isSessionCandidates } from "./wire-contracts/candidates.js";

interface Dependencies {
  getState(): { activeSessionId?: string; events?: CandidateHistoryEvent[] };
  read(input: { sessionId: string; offset: number }): Promise<unknown>;
  select(input: { sessionId: string; selection: CandidateSelection }): Promise<boolean>;
  transfer(kind: "export_midi_artifact" | "attach_midi_artifact", input: { sessionId: string; artifactRef: string }): Promise<boolean>;
  useInChat(text: string): Promise<void>;
  resultActions: PluginResultActions;
  audioUrl(sessionId: string, id: string): string;
  createAudioPlayer(sessionId: string, descriptor: { fileName: string; durationSeconds: number }, sourceUrl: string): { element: HTMLElement; dispose(): void };
}

function createCandidateComparisonView(deps: Dependencies) {
  const t = (value: string, params?: Record<string, string>) => window.LiveSmithI18n?.t(value, params) ?? value;
  const panel = document.getElementById("sessionCandidates") as HTMLDetailsElement;
  const content = document.getElementById("candidateComparison")!;
  let sessionId: string | undefined;
  let snapshot: SessionCandidates | undefined;
  let pending = false;
  let busy = false;
  let serial = 0;
  let continuationIdentity = "";
  const selected = new Map<string, SessionCandidate>();
  let players: { dispose(): void }[] = [];
  const element = <T extends keyof HTMLElementTagNameMap>(tag: T, className: string, text?: string): HTMLElementTagNameMap[T] => {
    const node = document.createElement(tag); node.className = className; if (text !== undefined) node.textContent = text; return node;
  };
  const status = element("p", "field-hint"); status.setAttribute("role", "status");
  const controls = element("div", "candidate-controls");
  const pages = element("div", "candidate-page-controls");
  const choices = element("div", "candidate-choices");
  const comparison = element("div", "candidate-cards");
  const context = element("p", "field-hint");
  const clear = element("button", "secondary", t("Clear next-request source")); clear.type = "button";
  const load = element("button", "secondary", t("Refresh candidates")); load.type = "button";
  const previous = element("button", "secondary", t("Previous page")); previous.type = "button";
  const next = element("button", "secondary", t("Next page")); next.type = "button";
  pages.append(load, previous, next);
  controls.append(pages, context, clear, choices, comparison); content.append(controls, status);
  const candidateLabel = (candidate: SessionCandidate) => candidate.version ? `${candidate.label} · v${candidate.version.number}` : candidate.label;
  const current = (id = sessionId) => Boolean(id) && id === deps.getState().activeSessionId;
  function syncBusy() {
    load.disabled = pending; previous.disabled = pending || !snapshot?.offset;
    next.disabled = pending || !snapshot || snapshot.offset + 24 >= snapshot.total;
    clear.disabled = pending || busy;
    for (const button of comparison.querySelectorAll<HTMLButtonElement>("[data-candidate-transfer]")) button.disabled = pending;
    for (const button of comparison.querySelectorAll<HTMLButtonElement>("[data-candidate-write]")) button.disabled = pending || busy;
  }
  async function read(offset = 0) {
    if (!current() || pending) return;
    const id = sessionId!; const attempt = ++serial; pending = true; syncBusy();
    status.textContent = t("Loading saved candidates…");
    try {
      const result = await deps.read({ sessionId: id, offset });
      if (!current(id) || attempt !== serial) return;
      if (!isSessionCandidates(result) || result.sessionId !== id) throw new Error(t("Candidate comparison is unavailable."));
      snapshot = result;
      for (const candidate of result.candidates) if (selected.has(candidateKey(candidate.ref))) selected.set(candidateKey(candidate.ref), candidate);
      renderSnapshot();
      status.textContent = result.unavailableCount ? t("Some saved candidates are unavailable.") : result.total ? t("Choose up to four candidates to compare.") : t("No saved audio or MIDI candidates yet.");
    } catch (error) { if (current(id)) status.textContent = error instanceof Error ? error.message : t("Candidate comparison is unavailable."); }
    finally { if (attempt === serial) { pending = false; syncBusy(); } }
  }
  async function select(selection: CandidateSelection, candidate?: SessionCandidate) {
    if (!current() || pending || busy) return;
    const id = sessionId!; const attempt = ++serial; pending = true; syncBusy();
    try {
      const saved = await deps.select({ sessionId: id, selection });
      if (!saved || !current(id)) return;
      if (selection.action === "continue" && candidate) await deps.useInChat(
        candidate.ref.kind === "midi"
          ? t("Create a new version of saved MIDI artifact {reference}. Describe the changes:", { reference: candidate.ref.id })
          : t("Continue from saved audio asset {reference}. Describe the next variation or edit:", { reference: candidate.ref.id }));
    } finally { if (attempt === serial) { pending = false; syncBusy(); if (current(id)) void read(snapshot?.offset ?? 0); } }
  }
  async function transfer(kind: "export_midi_artifact" | "attach_midi_artifact", candidate: SessionCandidate) {
    if (!current() || pending) return;
    const id = sessionId!; const attempt = ++serial; pending = true; syncBusy();
    try { await deps.transfer(kind, { sessionId: id, artifactRef: candidate.ref.id }); }
    finally { if (attempt === serial) { pending = false; syncBusy(); } }
  }
  const button = (label: string, action: () => void) => {
    const node = element("button", "secondary", t(label)); node.type = "button"; node.addEventListener("click", action); return node;
  };
  function renderCards() {
    for (const player of players) player.dispose(); players = [];
    comparison.replaceChildren();
    for (const candidate of selected.values()) {
      const card = element("article", "candidate-card");
      card.append(element("h4", "", candidateLabel(candidate)), element("p", "field-hint", candidate.sourceLabel));
      const preferred = snapshot?.preferred && candidateKey(snapshot.preferred) === candidateKey(candidate.ref);
      const actions = element("div", "candidate-actions");
      const prefer = button(preferred ? "Clear preferred" : "Mark preferred", () => { void select({ action: "prefer", candidate: preferred ? null : candidate.ref }); });
      prefer.setAttribute("aria-pressed", String(Boolean(preferred)));
      prefer.dataset.candidateWrite = "";
      const continueButton = button(candidate.ref.kind === "midi" ? "Create next version" : "Continue in chat", () => { void select({ action: "continue", candidate: candidate.ref }, candidate); });
      continueButton.dataset.candidateWrite = "";
      actions.append(prefer, continueButton);
      card.append(actions);
      if (candidate.audio) {
        card.append(element("p", "field-hint", `${candidate.audio.durationSeconds.toFixed(1)} s · ${candidate.audio.mediaType === "audio/wav" ? "WAV" : "MP3"}`));
        const player = deps.createAudioPlayer(sessionId!, { fileName: candidate.label, durationSeconds: candidate.audio.durationSeconds }, deps.audioUrl(sessionId!, candidate.ref.id));
        players.push(player); card.append(player.element);
        card.append(button("Prepare audio import in chat", () => {
          if (!current()) return;
          void deps.useInChat(t("Import saved audio asset {reference} into Live. Inspect the destination and preview affected tracks and Clips before applying. Destination and start beat:", { reference: candidate.ref.id }));
        }));
      }
      if (candidate.midi) {
        const transfers = element("div", "candidate-actions");
        transfers.append(button("Attach to message", () => { void transfer("attach_midi_artifact", candidate); }),
          button("Export MIDI", () => { void transfer("export_midi_artifact", candidate); }));
        for (const button of transfers.querySelectorAll("button")) button.dataset.candidateTransfer = "";
        card.append(transfers);
        const midi = candidate.midi;
        card.append(element("p", "field-hint", t("{notes} notes · {parts} parts · {beats} beats", {
          notes: String(midi.noteCount), parts: String(midi.parts.length), beats: String(midi.durationBeats) })));
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("viewBox", "0 0 640 128"); svg.setAttribute("role", "img");
        svg.setAttribute("aria-label", t("Saved MIDI note preview")); svg.classList.add("candidate-midi-preview");
        const lowestPitch = Math.min(...midi.notes.map((note) => note.pitch)) - 2;
        const pitchRange = Math.max(12, Math.max(...midi.notes.map((note) => note.pitch)) - lowestPitch + 2);
        for (const note of midi.notes) {
          const rect = document.createElementNS(svg.namespaceURI, "rect");
          rect.setAttribute("x", String(note.startTime / midi.durationBeats * 640));
          rect.setAttribute("y", String((pitchRange - (note.pitch - lowestPitch) - 1) / pitchRange * 128));
          rect.setAttribute("width", String(Math.max(1, note.duration / midi.durationBeats * 640)));
          rect.setAttribute("height", String(128 / pitchRange * 0.8));
          svg.append(rect);
        }
        card.append(svg);
        if (midi.omittedNoteCount) card.append(element("p", "field-hint", t("{count} notes omitted from this preview.", { count: String(midi.omittedNoteCount) })));
        const parts = element("details", "candidate-details"); parts.append(element("summary", "", t("Source parts")));
        for (const part of midi.parts) parts.append(element("p", "field-hint", `${part.sourceTrackIndex + 1} · ${part.sourceTrackName || "MIDI"} · ${t("Channel")} ${part.channel} · ${part.noteCount} · ${part.durationBeats}`));
        card.append(parts, deps.resultActions.create("saved_midi", { artifacts: [{ kind: "midi", artifactRef: candidate.ref.id,
          label: candidate.label, noteCount: midi.noteCount, durationBeats: midi.durationBeats }] }, { importOnly: true }));
      }
      if (candidate.parent) {
        const parent = [...selected.values(), ...(snapshot?.candidates ?? [])].find((entry) => candidateKey(entry.ref) === candidateKey(candidate.parent!));
        card.append(element("p", "field-hint", t("Parent candidate: {name}", { name: parent?.label ?? t("Saved source candidate") })));
      }
      const generation = element("details", "candidate-details"); generation.append(element("summary", "", t("Generation parameters")));
      generation.append(element("pre", "", candidate.generation?.parameters ?? t("Original generation parameters are unavailable.")));
      if (candidate.generation?.parametersTruncated) generation.append(element("p", "field-hint", t("Parameters are shortened here; the original tool call remains in Session history.")));
      card.append(generation); comparison.append(card);
    }
    syncBusy();
  }
  function renderSnapshot() {
    choices.replaceChildren();
    previous.disabled = !snapshot?.offset; next.disabled = !snapshot || snapshot.offset + 24 >= snapshot.total;
    renderContext();
    const groups = new Map<string, SessionCandidate[]>();
    for (const candidate of snapshot?.candidates ?? []) {
      const key = candidate.version?.groupId ?? candidateKey(candidate.ref);
      const group = groups.get(key) ?? [];
      group.push(candidate); groups.set(key, group);
    }
    for (const group of groups.values()) {
      const container = element("div", "candidate-version-group");
      if (group[0]?.version) container.append(element("strong", "", group[0].version.groupLabel));
      for (const candidate of group.sort((a, b) => (a.version?.number ?? 0) - (b.version?.number ?? 0))) {
        const label = element("label", "candidate-choice"); const checkbox = element("input", ""); checkbox.type = "checkbox";
        const key = candidateKey(candidate.ref); checkbox.value = key; checkbox.checked = selected.has(key);
        label.append(checkbox, element("span", "", candidateLabel(candidate) + (candidate.preferred ? " · " + t("Preferred") : "")));
        checkbox.addEventListener("change", () => {
          if (checkbox.checked && selected.size >= 4) { checkbox.checked = false; return; }
          if (checkbox.checked) selected.set(key, candidate); else selected.delete(key);
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
    const source = snapshot?.continuation && [...selected.values(), ...(snapshot?.candidates ?? [])].find((entry) => candidateKey(entry.ref) === candidateKey(snapshot!.continuation!));
    context.textContent = snapshot?.continuation ? t("Next request starts from: {name}", { name: source?.label ?? t("Saved source candidate") }) : t("Continue in chat prepares a draft. Sending it uses the normal model and tool permissions.");
  }
  load.addEventListener("click", () => { void read(snapshot?.offset ?? 0); });
  previous.addEventListener("click", () => { void read(Math.max(0, (snapshot?.offset ?? 0) - 24)); });
  next.addEventListener("click", () => { void read((snapshot?.offset ?? 0) + 24); });
  clear.addEventListener("click", () => { void select({ action: "continue", candidate: null }); });
  panel.addEventListener("toggle", () => { if (panel.open && !snapshot) void read(); });
  return {
    render() {
      const continuation = pendingCandidateParentFromEvents(deps.getState().events ?? []);
      const identity = continuation ? candidateKey(continuation) : "";
      if (sessionId !== deps.getState().activeSessionId) {
        serial++; pending = false; sessionId = deps.getState().activeSessionId; snapshot = undefined; selected.clear();
        status.textContent = ""; renderSnapshot();
        if (panel.open) void read();
      }
      if (continuationIdentity !== identity && snapshot) {
        if (continuation) snapshot.continuation = continuation; else delete snapshot.continuation;
        renderContext();
      }
      continuationIdentity = identity;
      panel.hidden = !sessionId; syncBusy();
    },
    setBusy(value: boolean) { busy = value; syncBusy(); },
  };
}
function createCandidateComparison(deps: Dependencies) {
  let view: ReturnType<typeof createCandidateComparisonView> | undefined;
  let busy = false;
  return {
    render() {
      if (!view) { view = createCandidateComparisonView(deps); view.setBusy(busy); }
      view.render();
    },
    setBusy(value: boolean) { busy = value; view?.setBusy(value); },
  };
}
window.LiveSmithFactories = window.LiveSmithFactories || {};
window.LiveSmithFactories.createCandidateComparison = createCandidateComparison;
