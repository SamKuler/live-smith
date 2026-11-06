import { isCreativeBrief, isCreativeBriefProposal, MAX_CREATIVE_BRIEF_CODE_POINTS, type CreativeBriefProposal } from "../../agent/creative-brief.js";
import type { ChatBridgeState } from "../chat-state.js";
import { uiMessage, type UiMessage } from "../../i18n/ui-message.js";
import { revealDisclosure } from "./disclosure-motion.js";

interface BriefDraft { value: string; base: string }
interface Dependencies {
  getState(): ChatBridgeState;
  isBusy(): boolean;
  confirmAction(input: { title: UiMessage; message: UiMessage; acceptLabel: UiMessage }): Promise<boolean>;
  runCommand(kind: string, input: { sessionId: string; creativeBrief: string; expectedCreativeBrief: string }, options: { cancellable: boolean }): Promise<boolean>;
}

export function createCreativeBriefEditor(deps: Dependencies) {
  const t = (text: string, values?: Record<string, string>) => window.LiveSmithI18n?.t(text, values) ?? text;
  const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const set = <T extends HTMLElement, K extends keyof T>(node: T, property: K, value: T[K]) => {
    if (node[property] !== value) node[property] = value;
  };
  let input: HTMLTextAreaElement;
  let save: HTMLButtonElement;
  let rebase: HTMLButtonElement;
  let useProposal: HTMLButtonElement;
  const drafts = new Map<string, BriefDraft>();
  let pendingSessionId: string | undefined;
  let proposal: CreativeBriefProposal | undefined;
  let renderedSessionId: string | undefined;

  function current() {
    const state = deps.getState();
    const session = state.sessions.find((entry) => entry.id === state.activeSessionId);
    const saved = session?.creativeBrief ?? "";
    let draft = drafts.get(state.activeSessionId);
    if (!draft || draft.value === draft.base || draft.value === saved) {
      draft = { value: saved, base: saved };
      drafts.set(state.activeSessionId, draft);
    }
    return { session, draft, saved };
  }

  function render() {
    const state = deps.getState();
    const ids = new Set([...state.sessions, ...state.previousSessions, ...state.archivedSessions].map((entry) => entry.id));
    for (const id of drafts.keys()) if (!ids.has(id)) drafts.delete(id);
    const { session, draft, saved } = current();
    const dirty = draft.value !== saved;
    const conflict = dirty && draft.base !== saved;
    const busy = deps.isBusy() || pendingSessionId !== undefined || !session;
    set(input, "value", draft.value);
    set(input, "disabled", pendingSessionId !== undefined || !session);
    set(save, "disabled", busy || !dirty || conflict || !isCreativeBrief(draft.value));
    set(rebase, "disabled", pendingSessionId !== undefined);
    set(rebase, "hidden", !conflict);
    const conflictPanel = element("creativeBriefConflict");
    set(conflictPanel, "hidden", !conflict);
    set(element("creativeBriefSavedText"), "textContent", saved || t("Empty brief"));
    set(element("creativeBriefCount"), "textContent", t("{count} / {limit} characters", {
      count: String([...draft.value].length), limit: String(MAX_CREATIVE_BRIEF_CODE_POINTS),
    }));
    set(element("creativeBriefStatus"), "textContent", pendingSessionId === state.activeSessionId
      ? t("Saving…") : conflict ? t("The saved brief changed. Review it before saving your draft.")
        : !isCreativeBrief(draft.value) ? t("Creative brief is too long.")
          : dirty ? t("Unsaved changes") : saved ? t("Saved for this Session") : "");
    const previousProposal = proposal?.creativeBrief;
    proposal = undefined;
    const event = state.events.findLast((entry) => entry.kind === "tool_result" && entry.name === "propose_creative_brief");
    if (event) {
      try {
        const value: unknown = JSON.parse(event.content);
        if (isCreativeBriefProposal(value) && value.creativeBrief !== saved) proposal = value;
      } catch { /* Invalid historical tool output cannot become an editable proposal. */ }
    }
    set(element("creativeBriefProposal"), "hidden", !proposal);
    set(element("creativeBriefProposalText"), "textContent", proposal?.creativeBrief || t("Empty brief"));
    set(useProposal, "disabled", pendingSessionId !== undefined || !proposal);
    const disclosure = element<HTMLDetailsElement>("creativeBriefDisclosure");
    if (renderedSessionId !== state.activeSessionId) {
      disclosure.open = Boolean(saved || draft.value || proposal);
      renderedSessionId = state.activeSessionId;
    } else if (proposal && proposal.creativeBrief !== previousProposal) {
      revealDisclosure(disclosure);
      disclosure.open = true;
    }
    const buttonState = proposal ? "suggestion" : dirty ? "draft" : saved ? "saved" : "empty";
    const button = element<HTMLButtonElement>("briefShortcut");
    set(button, "textContent", t("Brief"));
    set(button, "title", proposal ? t("Brief suggestion") : dirty ? t("Brief · draft") : saved ? t("Brief · saved") : t("Creative brief"));
    if (button.dataset.state !== buttonState) button.dataset.state = buttonState;
    if (button.getAttribute("aria-label") !== t("Creative brief")) button.setAttribute("aria-label", t("Creative brief"));
  }

  function initialize() {
    input = element<HTMLTextAreaElement>("creativeBrief");
    input.maxLength = MAX_CREATIVE_BRIEF_CODE_POINTS * 2;
    save = element<HTMLButtonElement>("saveCreativeBriefButton");
    rebase = element<HTMLButtonElement>("rebaseCreativeBriefButton");
    useProposal = element<HTMLButtonElement>("useCreativeBriefProposalButton");
    input.addEventListener("input", () => {
      const state = deps.getState();
      const draft = drafts.get(state.activeSessionId) ?? { value: "", base: "" };
      drafts.set(state.activeSessionId, { ...draft, value: input.value });
      render();
    });
    rebase.addEventListener("click", () => {
      const { draft, saved } = current();
      draft.base = saved;
      render();
    });
    useProposal.addEventListener("click", async () => {
      if (!proposal || useProposal.disabled) return;
      const sessionId = deps.getState().activeSessionId;
      const choice = proposal;
      const { draft, saved } = current();
      const value = draft.value, base = draft.base;
      if (value !== saved && !await deps.confirmAction({
        title: uiMessage("Replace this draft with the suggestion?"),
        message: uiMessage("Your unsaved changes will be replaced. The saved brief stays unchanged until you save."),
        acceptLabel: uiMessage("Use suggestion"),
      })) return;
      if (deps.getState().activeSessionId !== sessionId || pendingSessionId !== undefined ||
          proposal?.creativeBrief !== choice.creativeBrief || proposal.expectedCreativeBrief !== choice.expectedCreativeBrief) return;
      const latest = current();
      if (latest.saved !== saved || latest.draft.value !== value || latest.draft.base !== base) return;
      drafts.set(sessionId, { value: choice.creativeBrief, base: choice.expectedCreativeBrief });
      render();
      input.focus();
    });
    save.addEventListener("click", async () => {
      if (save.disabled) return;
      const { session, draft } = current();
      if (!session) return;
      pendingSessionId = session.id;
      render();
      try {
        await deps.runCommand("set_session_creative_brief", {
          sessionId: session.id, creativeBrief: draft.value, expectedCreativeBrief: draft.base,
        }, { cancellable: true });
      } finally {
        pendingSessionId = undefined;
        render();
      }
    });
  }
  function hasDraft(sessionId: string) {
    const draft = drafts.get(sessionId);
    const state = deps.getState();
    const session = [...state.sessions, ...state.previousSessions, ...state.archivedSessions].find((entry) => entry.id === sessionId);
    return Boolean(draft && session && draft.value !== draft.base && draft.value !== (session.creativeBrief ?? ""));
  }
  return { initialize, render, hasDraft,
    open() {
      const disclosure = element<HTMLDetailsElement>("creativeBriefDisclosure");
      revealDisclosure(disclosure);
      disclosure.open = true;
      input.focus({ preventScroll: true });
    },
    hasUnsavedChanges: () => [...drafts.keys()].some(hasDraft),
  };
}
