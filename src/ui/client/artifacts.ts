import "./chat-artifact-preview.js";
import { createMidiPianoRoll } from "./midi-piano-roll.js";
import { createLocaleBindings, type LocalizedText } from "./locale-bindings.js";
import { artifactKey, pendingArtifactParentFromEvents, type ArtifactHistoryEvent, type ArtifactSelection, type ArtifactRef } from "../../agent/artifact-contracts.js";
import type { SessionArtifact, SessionArtifacts, MidiPartPreview } from "../../app/session/session-artifacts.js";
import type { PluginResultActions } from "./plugin-results.js";
import { createMidiArtifactDiffView } from "./midi-artifact-diff-view.js";
import { isMidiPartPreview, isSessionArtifacts, isSessionArtifactDetail } from "./wire-contracts/artifacts.js";
import { MAX_SEARCH_QUERY_LENGTH, normalizeSearchQuery } from "../../app/session/search-contracts.js";

interface Dependencies {
  getState(): { activeSessionId?: string; events?: ArtifactHistoryEvent[] };
  read(input: { sessionId: string; offset: number; query?: string }, signal?: AbortSignal): Promise<unknown>;
  readArtifact(input: { sessionId: string; artifact: ArtifactRef }, signal?: AbortSignal): Promise<unknown>;
  readMidiArtifactDiff(input: { sessionId: string; artifactRef: string; baseArtifactRef?: string }, signal?: AbortSignal): Promise<unknown>;
  readMidiPartPreview(input: { sessionId: string; artifactRef: string; partId: string }, signal?: AbortSignal): Promise<unknown>;
  select(input: { sessionId: string; selection: ArtifactSelection }): Promise<boolean>;
  transfer(kind: "export_artifact" | "attach_artifact", input: { sessionId: string; artifact: ArtifactRef }): Promise<boolean>;
  useInChat(text: string): Promise<void>;
  resultActions: PluginResultActions;
  audioUrl(sessionId: string, id: string): string;
  createAudioPlayer(sessionId: string, descriptor: { fileName: string; durationSeconds: number }, sourceUrl: string): { element: HTMLElement; media: HTMLAudioElement; dispose(): void };
}

function createArtifactLibraryView(deps: Dependencies) {
  const bindings = createLocaleBindings();
  const t = (value: string, params?: Record<string, string>) => window.LiveSmithI18n?.t(value, params) ?? value;
  const panel = document.getElementById("sessionArtifacts")!;
  const launcher = document.getElementById("artifactsTab") as HTMLButtonElement;
  let visible = false;
  const content = document.getElementById("artifactLibrary")!;
  let sessionId: string | undefined;
  let snapshot: SessionArtifacts | undefined;
  let revealedArtifact: SessionArtifact | undefined;
  let pending = false;
  let listRead: AbortController | undefined;
  let searchTimer: number | undefined;
  let composing = false;
  let query = "";
  let queryNeedsRead = false;
  let busy = false;
  let serial = 0;
  let continuationIdentity = "";
  const rows = new Map<string, ReturnType<typeof createRow>>();
  const element = <T extends keyof HTMLElementTagNameMap>(tag: T, className: string, text?: LocalizedText): HTMLElementTagNameMap[T] => {
    const node = document.createElement(tag); node.className = className; if (text !== undefined) bindings.text(node, text); return node;
  };
  const status = element("p", "field-hint"); status.setAttribute("role", "status");
  const controls = element("div", "artifact-controls");
  const searchField = element("label", "artifact-search"); searchField.htmlFor = "artifactSearch";
  searchField.append(element("span", "", () => t("Search artifacts")));
  const search = element("input", "artifact-search-input"); search.type = "search"; search.id = "artifactSearch";
  search.maxLength = MAX_SEARCH_QUERY_LENGTH;
  bindings.attribute(search, "placeholder", () => t("Search names, versions, or sources"));
  searchField.append(search);
  const pages = element("div", "artifact-page-controls");
  const choices = element("div", "artifact-choices");
  const context = element("p", "field-hint");
  const clear = element("button", "secondary", () => t("Clear next-request source")); clear.type = "button";
  const load = element("button", "secondary", () => t("Refresh artifacts")); load.type = "button";
  const previous = element("button", "secondary", () => t("Previous page")); previous.type = "button";
  const next = element("button", "secondary", () => t("Next page")); next.type = "button";
  previous.hidden = next.hidden = true;
  status.hidden = true;
  pages.append(load, previous, next);
  controls.append(searchField, pages, status, context, clear, choices); content.append(controls);
  const artifactLabel = (artifact: SessionArtifact) => artifact.version ? `${artifact.label} · v${artifact.version.number}` : artifact.label;
  function sourceLabel(ref: ArtifactRef): string {
    for (const item of [...rows.values()].map((row) => row.artifact()).concat(snapshot?.artifacts ?? [])) {
      if (artifactKey(item.ref) === artifactKey(ref)) return artifactLabel(item);
      const version = ref.kind === item.ref.kind ? item.versions?.find((entry) => entry.id === ref.id) : undefined;
      if (version) return `${version.label} · v${version.number}`;
    }
    return t("Saved source artifact");
  }
  const groupKey = (artifact: SessionArtifact) => artifact.version ? `${artifact.ref.kind}:${artifact.version.groupId}` : artifactKey(artifact.ref);
  const current = (id = sessionId) => Boolean(id) && id === deps.getState().activeSessionId;
  const operationPending = () => pending || Boolean(listRead);
  function syncBusy() {
    load.disabled = operationPending(); previous.disabled = operationPending() || !snapshot?.offset;
    next.disabled = operationPending() || !snapshot || snapshot.offset + 24 >= snapshot.total;
    clear.disabled = operationPending() || busy;
    for (const button of choices.querySelectorAll<HTMLButtonElement>("[data-artifact-transfer]")) button.disabled = operationPending();
    for (const button of choices.querySelectorAll<HTMLButtonElement>("[data-artifact-write]")) button.disabled = operationPending() || busy;
    for (const row of rows.values()) row.syncBusy();
  }
  function cancelListRead() { listRead?.abort(); listRead = undefined; }
  function cancelSearchTimer() { if (searchTimer !== undefined) window.clearTimeout(searchTimer); searchTimer = undefined; }
  function changeQuery(immediate = false) {
    const nextQuery = normalizeSearchQuery(search.value);
    if (nextQuery === query && !queryNeedsRead) return;
    cancelSearchTimer(); cancelListRead(); query = nextQuery; queryNeedsRead = true;
    snapshot = undefined; revealedArtifact = undefined; renderSnapshot();
    status.hidden = false; bindings.text(status, () => t("Loading saved artifacts…"));
    if (composing) return;
    if (immediate) void read();
    else searchTimer = window.setTimeout(() => { searchTimer = undefined; void read(); }, 180);
  }
  async function read(offset = 0) {
    if (!current() || pending || composing) return;
    cancelSearchTimer(); cancelListRead();
    const id = sessionId!; const requestedQuery = query;
    const controller = new window.AbortController(); listRead = controller; queryNeedsRead = false; syncBusy();
    const isCurrentRead = () => current(id) && listRead === controller;
    status.hidden = false; bindings.text(status, () => t("Loading saved artifacts…"));
    try {
      const result = await deps.read({ sessionId: id, offset, ...(requestedQuery ? { query: requestedQuery } : {}) }, controller.signal);
      if (!isCurrentRead()) return;
      if (!isSessionArtifacts(result) || result.sessionId !== id || (result.query ?? "") !== requestedQuery || result.offset !== offset) throw new Error(t("Saved artifacts are unavailable."));
      if (offset > 0 && offset >= result.total) {
        await read(Math.max(0, Math.floor((result.total - 1) / 24) * 24));
        return;
      }
      snapshot = result;
      renderSnapshot();
      status.hidden = !result.unavailableCount && result.total > 0;
      bindings.text(status, () => result.unavailableCount ? t("Some saved artifacts are unavailable.") : result.total ? "" : t(requestedQuery ? "No matching artifacts." : "No saved audio or MIDI artifacts yet."));
    } catch (error) { if (isCurrentRead()) { status.hidden = false; bindings.text(status, () => error instanceof Error ? error.message : t("Saved artifacts are unavailable.")); } }
    finally { if (isCurrentRead()) { listRead = undefined; syncBusy(); } }
  }
  async function select(selection: ArtifactSelection, artifact?: SessionArtifact) {
    if (!current() || operationPending() || busy) return;
    const id = sessionId!; const attempt = ++serial; pending = true; syncBusy();
    try {
      const saved = await deps.select({ sessionId: id, selection });
      if (!current(id)) return;
      if (!saved) { if (artifact) rows.get(groupKey(artifact))?.notify(() => t("Could not save the selection. Try again.")); return; }
      if (selection.action === "continue" && artifact) await deps.useInChat(
        artifact.ref.kind === "midi"
          ? t("Create a new version of {name}. Describe the changes:", { name: artifactLabel(artifact) })
          : t("Continue from {name}. Describe the next variation or edit:", { name: artifactLabel(artifact) }));
    } finally { if (attempt === serial) { pending = false; syncBusy(); if (current(id) && searchTimer === undefined) void read(snapshot?.offset ?? 0); } }
  }
  async function transfer(kind: "export_artifact" | "attach_artifact", artifact: SessionArtifact) {
    if (!current() || operationPending()) return;
    const id = sessionId!; const attempt = ++serial; pending = true; syncBusy();
    const card = rows.get(groupKey(artifact));
    card?.notify(() => t(kind === "export_artifact" ? "Opening file download…" : "Attaching file…"));
    try {
      const completed = await deps.transfer(kind, { sessionId: id, artifact: artifact.ref });
      if (current(id)) card?.notify(() => t(completed
        ? kind === "export_artifact" ? "File download opened." : "File attached to the next message."
        : "The file transfer did not complete. Try again."));
    } catch { if (current(id)) card?.notify(() => t("The file transfer did not complete. Try again.")); }
    finally { if (attempt === serial) { pending = false; syncBusy(); if (current(id) && queryNeedsRead && searchTimer === undefined) void read(); } }
  }
  const button = (label: string, action: () => void) => {
    const node = element("button", "secondary", () => t(label)); node.type = "button"; node.addEventListener("click", action); return node;
  };
  function createCard(artifact: SessionArtifact) {
      let player: ReturnType<Dependencies["createAudioPlayer"]> | undefined;
      let pianoRoll: ReturnType<typeof createMidiPianoRoll> | undefined;
      let plottedPartId: string | undefined;
      let partSelect: HTMLSelectElement | undefined;
      let midiSummary: HTMLParagraphElement | undefined;
      let omitted: HTMLParagraphElement | undefined;
      let partPreview: MidiPartPreview | undefined;
      let previewRead: AbortController | undefined;
      let previewLoading = false;
      let previewError = "";
      const previewStatus = element("p", "field-hint"); previewStatus.setAttribute("role", "status"); previewStatus.hidden = true;
      const retryPreview = button("Retry preview", () => { void readPart(); }); retryPreview.hidden = true;
      const previewMidi = (value: SessionArtifact) => {
        const partId = partSelect?.value;
        if (!value.midi || !partId) return value.midi;
        const part = value.midi.parts.find((part) => part.id === partId)!;
        const notes = partPreview?.partId === part.id ? partPreview.notes : value.midi.notes.filter((note) => note.partId === part.id);
        return { ...value.midi, notes, noteCount: part.noteCount, parts: [part], durationBeats: part.durationBeats,
          omittedNoteCount: part.noteCount - notes.length };
      };
      const card = element("article", "artifact-card");
      async function readPart() {
        previewRead?.abort(); previewRead = undefined; partPreview = undefined; previewError = "";
        const partId = partSelect?.value;
        if (!partId) { previewLoading = false; update(artifact); return; }
        const owner = sessionId!; const controller = new window.AbortController(); previewRead = controller;
        previewLoading = true; update(artifact);
        try {
          const result = await deps.readMidiPartPreview({ sessionId: owner, artifactRef: artifact.ref.id, partId }, controller.signal);
          if (!current(owner) || !card.isConnected || previewRead !== controller) return;
          if (!isMidiPartPreview(result) || result.sessionId !== owner || result.artifactRef !== artifact.ref.id || result.partId !== partId) throw new Error(t("MIDI part preview is unavailable."));
          partPreview = result;
        } catch (error) {
          if (current(owner) && card.isConnected && previewRead === controller) previewError = error instanceof Error ? error.message : t("MIDI part preview is unavailable.");
        } finally {
          if (current(owner) && card.isConnected && previewRead === controller) { previewLoading = false; update(artifact); }
        }
      }
      card.id = `artifact-preview-${artifact.ref.kind}-${artifact.ref.id}`;
      const source = element("p", "field-hint", () => t(artifact.sourceLabel));
      card.append(source);
      const actions = element("div", "artifact-actions");
      const continueButton = button(artifact.ref.kind === "midi" ? "Create next version" : "Continue in chat", () => { void select({ action: "continue", candidate: artifact.ref }, artifact); });
      continueButton.dataset.artifactWrite = "";
      actions.append(continueButton);
      card.append(actions);
      const actionStatus = element("p", "field-hint"); actionStatus.hidden = true;
      actionStatus.setAttribute("role", "status"); actionStatus.setAttribute("aria-live", "polite");
      card.append(actionStatus);
      const transfers = element("div", "artifact-actions");
      transfers.append(button("Attach to message", () => { void transfer("attach_artifact", artifact); }),
        button(artifact.midi ? "Export MIDI" : "Export audio", () => { void transfer("export_artifact", artifact); }));
      for (const button of transfers.querySelectorAll("button")) button.dataset.artifactTransfer = "";
      card.append(transfers);
      let diff: ReturnType<typeof createMidiArtifactDiffView> | undefined;
      let midiPreview: HTMLElement | undefined;
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
        const midi = artifact.midi;
        midiPreview = element("div", "artifact-midi-preview-section"); card.append(midiPreview);
        if (midi.parts.length > 1) {
          const label = element("label", "artifact-preview-part"); label.append(element("span", "", () => t("Preview part")));
          partSelect = element("select", "");
          const all = element("option", "", () => t("All source parts")); all.value = ""; partSelect.append(all);
          for (const part of midi.parts) {
            const option = element("option", "", () => `${part.sourceTrackName || `${t("Track")} ${part.sourceTrackIndex + 1}`} · ${t("Channel")} ${part.channel}`);
            option.value = part.id; partSelect.append(option);
          }
          partSelect.addEventListener("change", () => { void readPart(); }); label.append(partSelect); midiPreview.append(label, previewStatus, retryPreview);
        }
        midiSummary = element("p", "field-hint"); midiPreview.append(midiSummary);
        pianoRoll = createMidiPianoRoll({ id: `midi-preview-${artifact.ref.id}`, label: () => t("Saved MIDI note preview") });
        midiPreview.append(pianoRoll.element);
        omitted = element("p", "field-hint"); midiPreview.append(omitted);
        const parts = element("details", "artifact-details"); parts.append(element("summary", "", () => t("Source parts")));
        for (const part of midi.parts) parts.append(element("p", "field-hint", () => `${part.sourceTrackIndex + 1} · ${part.sourceTrackName || "MIDI"} · ${t("Channel")} ${part.channel} · ${part.noteCount} · ${part.durationBeats}`));
        const add = button("Add to Live", () => {
          if (!current() || busy || operationPending()) return;
          deps.resultActions.openMidiImport({ sessionId: sessionId!, artifacts: [{ artifactRef: artifact.ref.id, label: artifactLabel(artifact) }],
            ...(partSelect?.value ? { initialPartId: partSelect.value } : {}),
            onComplete(completed) {
              actionStatus.hidden = false;
              bindings.text(actionStatus, () => t(completed ? "MIDI import finished. Review the Session result." : "MIDI import did not complete. Review the Session result before retrying."));
              if (add.isConnected) add.focus();
            },
          });
        }); add.dataset.artifactWrite = "";
        transfers.append(add); card.append(parts);
      }
      const parentLabel = element("p", "field-hint"); card.append(parentLabel);
      const generation = element("details", "artifact-details"); generation.append(element("summary", "", () => t("Generation parameters")));
      const tool = element("p", "field-hint");
      const parameters = element("pre", "");
      const shortened = element("p", "field-hint", () => t("Parameters are shortened here; the original tool call remains in Session history."));
      generation.append(tool, parameters, shortened); card.append(generation);
      function update(value: SessionArtifact) {
          artifact = value; bindings.text(source, () => t(value.sourceLabel));
          if (value.midi && (value.version?.derivedFromId || (value.versions?.length ?? 0) > 1)) {
            if (!diff) {
              diff = createMidiArtifactDiffView({ sessionId: sessionId!, artifact: value, read: deps.readMidiArtifactDiff,
                isCurrent: () => current() && card.isConnected,
                onToggle: (open) => { midiPreview!.hidden = open; } });
              card.insertBefore(diff.element, transfers.nextSibling);
            } else diff.update(value);
          } else if (diff) {
            diff.dispose(); diff.element.remove(); diff = undefined;
            if (midiPreview) midiPreview.hidden = false;
          }
          tool.hidden = !value.generation;
          bindings.text(tool, () => value.generation ? t("Tool: {name}", { name: value.generation.toolName }) : "");
          bindings.text(parameters, () => value.generation?.parameters ?? t("Original generation parameters are unavailable."));
          shortened.hidden = !value.generation?.parametersTruncated;
          parentLabel.hidden = !value.parent || value.parent.kind === "midi" && value.version?.derivedFromId === value.parent.id;
          if (value.parent) {
            bindings.text(parentLabel, () => t("Source artifact: {name}", { name: sourceLabel(value.parent!) }));
          }
          const midi = previewMidi(value);
          if (pianoRoll && midi) {
            const partId = partSelect?.value ?? "";
            // Keep the viewport on metadata/locale refresh; a different part starts at its notes.
            if (!previewLoading && !previewError) { pianoRoll.update(midi, plottedPartId !== partId); plottedPartId = partId; }
            pianoRoll.element.style.visibility = previewLoading ? "hidden" : "";
            pianoRoll.element.hidden = Boolean(previewError);
            previewStatus.hidden = !previewLoading && !previewError;
            bindings.text(previewStatus, () => previewLoading ? t("Loading MIDI part…") : previewError);
            retryPreview.hidden = !previewError;
            bindings.text(midiSummary!, () => t("{notes} notes · {parts} parts · {beats} beats", {
              notes: String(midi.noteCount), parts: String(midi.parts.length), beats: String(midi.durationBeats) }));
            omitted!.hidden = previewLoading || Boolean(previewError) || !midi.omittedNoteCount;
            bindings.text(omitted!, () => t("{count} notes omitted from this preview.", { count: String(midi.omittedNoteCount) }));
          }
      }
      return { element: card, update,
        notify(message: LocalizedText) { actionStatus.hidden = false; bindings.text(actionStatus, message); },
        pause() { player?.media.pause(); },
        dispose() { previewRead?.abort(); diff?.dispose(); player?.dispose(); card.remove(); },
      };
  }
  function createRow(initial: SessionArtifact) {
    let head = initial;
    let artifact = initial;
    let opened = false;
    let card: ReturnType<typeof createCard> | undefined;
    let cardKey = "";
    let versionRead: AbortController | undefined;
    const owner = sessionId!;
    const key = groupKey(initial);
    const row = element("article", "artifact-item");
    const expand = button(initial.version?.groupLabel ?? initial.label, () => {
      opened = !opened;
      if (opened) artifact = head;
      if (!opened) { cancelRead(); card?.dispose(); card = undefined; cardKey = ""; }
      render();
      if (opened && artifact.midi?.omittedNoteCount) void readVersion(artifact.ref.id);
    });
    expand.className = "artifact-open"; expand.dataset.artifactKey = key;
    const body = element("div", "artifact-body"); body.id = `artifact-group-${initial.ref.kind}-${initial.version?.groupId ?? initial.ref.id}`;
    expand.setAttribute("aria-controls", body.id);
    const toolbar = element("div", "artifact-version-toolbar");
    const label = element("label", "artifact-version-field"); label.append(element("span", "", () => t("Version")));
    const version = element("select", "artifact-version-select"); label.append(version);
    const ancestry = element("p", "field-hint artifact-version-source");
    const primary = button("Make primary", () => {
      if (!artifact.version || versionRead) return;
      void select({ action: "primary", group: { kind: artifact.ref.kind, id: artifact.version.groupId },
        candidate: artifact.primary && artifactKey(artifact.primary) === artifactKey(artifact.ref) ? null : artifact.ref }, artifact);
    });
    primary.classList.add("artifact-primary"); primary.dataset.artifactWrite = "";
    toolbar.append(label, primary, ancestry);
    const readStatus = element("p", "field-hint artifact-version-status"); readStatus.setAttribute("role", "status"); readStatus.hidden = true;
    const retryRead = button("Retry preview", () => { void readVersion(artifact.ref.id); });
    retryRead.classList.add("artifact-version-retry"); retryRead.hidden = true;
    body.append(toolbar, readStatus, retryRead); row.append(expand, body);
    function cancelRead() { versionRead?.abort(); versionRead = undefined; version.value = artifact.ref.id; readStatus.hidden = true; retryRead.hidden = true; }
    function syncRowBusy() { primary.disabled = operationPending() || busy || Boolean(versionRead); }
    function render() {
      syncRowBusy();
      const versions = head.versions ?? [];
      const title = head.version?.groupLabel ?? head.label;
      expand.textContent = title;
      expand.setAttribute("aria-label", title);
      expand.setAttribute("aria-expanded", String(opened)); body.hidden = !opened;
      if (!opened) return;
      const selectedId = versionRead ? version.value : artifact.ref.id;
      const previousOptions = [...version.options].map((option) => `${option.value}:${option.textContent}`).join("\n");
      const entries = versions.map((entry) => ({ value: entry.id, text: `v${entry.number} · ${entry.label}${head.primary?.id === entry.id ? ` · ${t("Primary")}` : ""}` }));
      if (previousOptions !== entries.map((entry) => `${entry.value}:${entry.text}`).join("\n")) {
        version.replaceChildren(...entries.map((entry) => { const option = element("option", "", entry.text); option.value = entry.value; return option; }));
      }
      version.value = selectedId;
      toolbar.hidden = !artifact.version;
      const isPrimary = artifact.primary && artifactKey(artifact.primary) === artifactKey(artifact.ref);
      bindings.text(primary, () => t(isPrimary ? "Clear primary" : "Make primary"));
      primary.setAttribute("aria-pressed", String(Boolean(isPrimary)));
      label.hidden = versions.length < 2;
      const parent = versions.find((entry) => entry.id === artifact.version?.derivedFromId);
      bindings.text(ancestry, () => artifact.version?.derivedFromId
        ? parent ? t("v{version} · based on v{base}", { version: String(artifact.version.number), base: String(parent.number) }) : t("Source version unavailable")
        : artifact.version ? t(artifact.version.number === 1 ? "v{version} · original" : "v{version} · alternative", { version: String(artifact.version.number) }) : "");
      if (versionRead || artifact.midi?.omittedNoteCount) { if (card) card.element.hidden = true; return; }
      const identity = artifactKey(artifact.ref);
      if (!card || cardKey !== identity) { card?.dispose(); card = createCard(artifact); cardKey = identity; body.append(card.element); }
      card.element.hidden = false; card.update(artifact); syncBusy();
    }
    async function readVersion(id: string) {
      versionRead?.abort(); versionRead = undefined; readStatus.hidden = true; retryRead.hidden = true;
      if (id === artifact.ref.id && !artifact.midi?.omittedNoteCount) { render(); return; }
      if (id === head.ref.id && !head.midi?.omittedNoteCount) { artifact = head; render(); return; }
      const controller = new window.AbortController(); versionRead = controller;
      readStatus.hidden = false; bindings.text(readStatus, () => t("Loading version…")); render();
      try {
        const result = await deps.readArtifact({ sessionId: owner, artifact: { kind: artifact.ref.kind, id } }, controller.signal);
        if (!current(owner) || !row.isConnected || versionRead !== controller) return;
        if (!isSessionArtifactDetail(result) || result.sessionId !== owner || result.artifact.ref.id !== id || groupKey(result.artifact) !== key) throw new Error(t("Saved version is unavailable."));
        artifact = { ...result.artifact, ...(head.versions ? { versions: head.versions } : {}) };
        if (head.primary) artifact.primary = head.primary; else delete artifact.primary;
        readStatus.hidden = true;
      } catch (error) {
        if (!current(owner) || !row.isConnected || versionRead !== controller) return;
        bindings.text(readStatus, () => error instanceof Error ? error.message : t("Saved version is unavailable."));
        retryRead.hidden = !artifact.midi?.omittedNoteCount;
      } finally {
        if (current(owner) && row.isConnected && versionRead === controller) { versionRead = undefined; render(); }
      }
    }
    version.addEventListener("change", () => { void readVersion(version.value); });
    return { element: row, artifact: () => artifact, syncBusy: syncRowBusy,
      update(value: SessionArtifact) {
        const previousId = artifact.ref.id;
        head = value;
        if (artifact.ref.id === value.ref.id) {
          artifact = { ...value, ...(artifact.midi?.omittedNoteCount === 0 && value.midi?.omittedNoteCount ? { midi: artifact.midi } : {}) };
        } else if (value.versions && !value.versions.some((entry) => entry.id === artifact.ref.id)) artifact = value;
        else artifact = { ...artifact, ...(value.versions ? { versions: value.versions } : {}) };
        if (value.primary) artifact.primary = value.primary; else delete artifact.primary;
        render();
        if (opened && artifact.ref.id !== previousId && artifact.midi?.omittedNoteCount) void readVersion(artifact.ref.id);
      },
      open(value: SessionArtifact) { cancelRead(); artifact = value; opened = true; render(); expand.focus({ preventScroll: true }); row.scrollIntoView?.({ block: "nearest" }); },
      notify(message: LocalizedText) { card?.notify(message); },
      pause() { card?.pause(); },
      dispose() { cancelRead(); card?.dispose(); row.remove(); },
    };
  }
  function renderSnapshot() {
    previous.hidden = next.hidden = !snapshot || snapshot.total <= 24;
    previous.disabled = !snapshot?.offset; next.disabled = !snapshot || snapshot.offset + 24 >= snapshot.total;
    const page = snapshot?.artifacts ?? [];
    const entries = revealedArtifact && !page.some((entry) => groupKey(entry) === groupKey(revealedArtifact!)) ? [revealedArtifact, ...page] : page;
    const present = new Set(entries.map(groupKey));
    for (const [key, row] of rows) if (!present.has(key)) { row.dispose(); rows.delete(key); }
    let position = choices.firstElementChild;
    for (const artifact of entries) {
      const key = groupKey(artifact);
      let row = rows.get(key);
      if (!row) { row = createRow(artifact); rows.set(key, row); }
      if (row.element !== position) choices.insertBefore(row.element, position);
      position = row.element.nextElementSibling; row.update(artifact);
    }
    renderContext(); syncBusy();
  }
  function renderContext() {
    clear.hidden = !snapshot?.continuation;
    context.hidden = !snapshot?.continuation;
    bindings.text(context, () => snapshot?.continuation ? t("Next request starts from: {name}", { name: sourceLabel(snapshot.continuation) }) : "");
  }
  load.addEventListener("click", () => { void read(snapshot?.offset ?? 0); });
  previous.addEventListener("click", () => { revealedArtifact = undefined; void read(Math.max(0, (snapshot?.offset ?? 0) - 24)); });
  next.addEventListener("click", () => { revealedArtifact = undefined; void read((snapshot?.offset ?? 0) + 24); });
  clear.addEventListener("click", () => { void select({ action: "continue", candidate: null }); });
  search.addEventListener("input", () => changeQuery());
  search.addEventListener("compositionstart", () => { composing = true; cancelSearchTimer(); });
  search.addEventListener("compositionend", () => { composing = false; changeQuery(); });
  search.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.isComposing || composing || !search.value) return;
    event.preventDefault(); event.stopPropagation(); search.value = ""; changeQuery(true);
  });
  return {
    render() {
      if (bindings.refresh(content)) renderSnapshot();
      const continuation = pendingArtifactParentFromEvents(deps.getState().events ?? []);
      const identity = continuation ? artifactKey(continuation) : "";
      if (sessionId !== deps.getState().activeSessionId) {
        cancelSearchTimer(); cancelListRead(); query = ""; search.value = ""; composing = false; queryNeedsRead = false;
        serial++; pending = false; sessionId = deps.getState().activeSessionId; snapshot = undefined; revealedArtifact = undefined;
        bindings.text(status, ""); status.hidden = true; renderSnapshot();
        if (visible) void read();
      }
      if (continuationIdentity !== identity && snapshot) {
        if (continuation) snapshot.continuation = continuation; else delete snapshot.continuation;
        renderContext();
      }
      continuationIdentity = identity;
      panel.hidden = !sessionId; launcher.disabled = !sessionId; syncBusy();
    },
    openArtifact(value: SessionArtifact) {
      if (query || search.value) { search.value = ""; composing = false; changeQuery(true); }
      revealedArtifact = value; renderSnapshot(); rows.get(groupKey(value))?.open(value);
    },
    setBusy(value: boolean) { busy = value; syncBusy(); },
    setVisible(value: boolean) {
      const opening = value && !visible;
      visible = value;
      if (opening && !pending) void read(snapshot?.offset ?? 0);
      if (!visible) for (const row of rows.values()) row.pause();
    },
  };
}
function createArtifactLibrary(deps: Dependencies) {
  let view: ReturnType<typeof createArtifactLibraryView> | undefined;
  let busy = false;
  return {
    render() {
      if (!view) { view = createArtifactLibraryView(deps); view.setBusy(busy); }
      view.render();
    },
    openArtifact(value: SessionArtifact) {
      if (!view) { view = createArtifactLibraryView(deps); view.setBusy(busy); view.render(); }
      view.openArtifact(value);
    },
    setBusy(value: boolean) { busy = value; view?.setBusy(value); },
    setVisible(value: boolean) {
      if (!view) { view = createArtifactLibraryView(deps); view.setBusy(busy); view.render(); }
      view.setVisible(value);
    },
  };
}
window.LiveSmithFactories = window.LiveSmithFactories || {};
window.LiveSmithFactories.createArtifactLibrary = createArtifactLibrary;
