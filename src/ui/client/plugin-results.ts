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
  importMidi(input: { sessionId: string; artifactRef: string; trackName: string; startBeat: number }): Promise<boolean>;
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
        const track = node("input", "plugin-result-track");
        track.name = "trackName"; track.required = true; track.maxLength = 256;
        track.autocomplete = "off";
        field("Destination MIDI track", track);
        const beat = node("input", "plugin-result-beat");
        beat.name = "startBeat"; beat.type = "number"; beat.required = true;
        beat.min = "1"; beat.step = "any"; beat.value = "1";
        field("Start beat (1-based)", beat);
        form.append(node("p", "field-hint", t("Enter an existing MIDI track name. Import follows this Session's edit scope and approval mode.")));
        const submit = node("button", "primary plugin-result-apply", t("Insert into Live"));
        submit.type = "submit";
        form.append(submit);
        const status = node("p", "plugin-result-import-status");
        status.setAttribute("role", "status");
        form.append(status);
        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          if (!current() || !sessionId || !form.reportValidity()) return;
          track.setCustomValidity(track.value.trim() ? "" : t("Enter a MIDI track name."));
          if (!form.reportValidity()) return;
          const artifactRef = selection.value;
          if (!saved.some((entry) => entry.artifactRef === artifactRef)) return;
          controls.disabled = true;
          try {
            const completed = await deps.importMidi({ sessionId, artifactRef, trackName: track.value.trim(), startBeat: Number(beat.value) - 1 });
            status.textContent = t(completed ? "MIDI import finished. Review the Session result." : "MIDI was not imported. Review the Session status before retrying.");
          } finally { controls.disabled = busy; }
        });
        track.addEventListener("input", () => track.setCustomValidity(""));
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
