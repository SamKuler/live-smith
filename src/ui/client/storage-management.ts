import type { StorageUsage } from "../../storage/management.js";
import type { SessionStorageUsage } from "../../storage/session-usage.js";
import type { UiMessage } from "../../i18n/ui-message.js";
import { storageUsageByteFields } from "./wire-contracts/storage.js";

type MaintenanceCommand = "clear_storage_backups" | "compact_storage" | "open_storage_directory";
type StorageCommand = MaintenanceCommand | "delete_session";
type FeedbackMessage = UiMessage | (() => string);
type SessionUsage = Extract<SessionStorageUsage, { available: true }>;
type View = "overview" | "conversations";

interface Dependencies {
  i18n: {
    locale: string;
    t(source: string, values?: Record<string, string>): string;
    message(source: string, values?: Record<string, string | (() => string)>): () => string;
    text(message: FeedbackMessage): string;
  };
  readStorageUsage(signal: AbortSignal): Promise<StorageUsage>;
  readSessionStorageUsage(signal: AbortSignal): Promise<SessionStorageUsage>;
  runCommand(kind: StorageCommand, input: { revision?: string; sessionId?: string }, options: {
    statusPresenter(message: FeedbackMessage, isError?: boolean): void;
  }): Promise<boolean>;
  confirmAction(input: {
    title: FeedbackMessage;
    message: FeedbackMessage;
    acceptLabel: FeedbackMessage;
    danger: boolean;
    signal: AbortSignal;
  }): Promise<boolean>;
}

const busyMessages: Record<StorageCommand, string> = {
  clear_storage_backups: "Clearing old backups…",
  compact_storage: "Freeing database space…",
  open_storage_directory: "Opening storage folder…",
  delete_session: "Deleting selected conversations…",
};

export function createStorageManagement({ i18n, readStorageUsage, readSessionStorageUsage, runCommand, confirmAction }: Dependencies) {
  const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  let section: HTMLElement;
  let appPanel: HTMLElement;
  let overviewScrollTop = 0;
  let rangeAnchor: { id: string; checked: boolean; selection: Set<string> } | undefined;
  let breakdown: HTMLElement;
  let status: HTMLElement;
  let refreshButton: HTMLButtonElement;
  let commands: Record<MaintenanceCommand, HTMLButtonElement>;
  let list: HTMLElement;
  let search: HTMLInputElement;
  let sort: HTMLSelectElement;
  let selectVisible: HTMLInputElement;
  let deleteButton: HTMLButtonElement;
  let scope: AbortController | undefined;
  let request: AbortController | undefined;
  let usage: StorageUsage | undefined;
  let sessionUsage: SessionStorageUsage | undefined;
  let readFailed = false;
  let commandBlocked = false;
  let operation: StorageCommand | undefined;
  let view: View = "overview";
  let feedback: { message: FeedbackMessage; isError: boolean } | undefined;
  const selection = new Set<string>();
  const rows = new Map<string, { row: HTMLLIElement; checkbox: HTMLInputElement; title: HTMLElement; date: HTMLTimeElement; bytes: HTMLElement }>();

  function number(value: number, maximumFractionDigits = 0) {
    return new Intl.NumberFormat(i18n.locale, { maximumFractionDigits }).format(value);
  }

  function size(bytes: number) {
    const units = ["{value} B", "{value} KiB", "{value} MiB", "{value} GiB", "{value} TiB", "{value} PiB"];
    const index = Math.min(units.length - 1, Math.floor(Math.log2(Math.max(bytes, 1)) / 10));
    return i18n.t(units[index]!, { value: number(bytes / 1024 ** index, index ? 1 : 0) });
  }

  function visibleSessions() {
    if (!sessionUsage?.available) return [];
    const query = search.value.trim().toLocaleLowerCase(i18n.locale);
    return sessionUsage.sessions.filter(session => (session.title || i18n.t("Untitled")).toLocaleLowerCase(i18n.locale).includes(query))
      .sort((a, b) => (sort.value === "updated" ? Date.parse(b.updatedAt) - Date.parse(a.updatedAt) : b.contentBytes - a.contentBytes)
        || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  }

  function reclaimableBytes(data: SessionUsage) {
    return data.media.reduce((total, group) => total + (!group.retained && group.sessionIds.every(id => selection.has(id)) ? group.bytes : 0), 0);
  }

  function selectSession(id: string, checked: boolean, extend: boolean) {
    const visible = visibleSessions();
    const anchorIndex = rangeAnchor ? visible.findIndex(session => session.id === rangeAnchor!.id) : -1;
    const targetIndex = visible.findIndex(session => session.id === id);
    if (targetIndex < 0 || request || operation || commandBlocked || readFailed) return;
    if (extend && anchorIndex >= 0) {
      selection.clear();
      for (const selectedId of rangeAnchor!.selection) selection.add(selectedId);
      for (const session of visible.slice(Math.min(anchorIndex, targetIndex), Math.max(anchorIndex, targetIndex) + 1)) {
        if (rangeAnchor!.checked) selection.add(session.id); else selection.delete(session.id);
      }
    } else {
      if (checked) selection.add(id); else selection.delete(id);
      rangeAnchor = { id, checked, selection: new Set(selection) };
    }
    renderList();
  }

  function renderList() {
    const data = sessionUsage?.available ? sessionUsage : undefined;
    const visible = visibleSessions();
    const blocked = Boolean(request || operation || commandBlocked || readFailed);
    const ids = new Set(visible.map(session => session.id));
    for (const [id, row] of rows) {
      if (!ids.has(id)) { row.row.remove(); rows.delete(id); }
    }
    visible.forEach((session, index) => {
      let row = rows.get(session.id);
      if (!row) {
        const item = document.createElement("li");
        item.dataset.sessionId = session.id;
        const label = document.createElement("label");
        label.className = "storage-conversation-row";
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        label.addEventListener("click", event => {
          if (checkbox.disabled) return;
          if (event.target !== checkbox) {
            event.preventDefault();
            checkbox.focus({ preventScroll: true });
          }
          selectSession(session.id, !selection.has(session.id), event.shiftKey);
        });
        checkbox.addEventListener("keydown", event => {
          if (event.key !== " " || !event.shiftKey) return;
          event.preventDefault();
          selectSession(session.id, !checkbox.checked, true);
        });
        const copy = document.createElement("span");
        copy.className = "storage-conversation-copy";
        const title = document.createElement("span");
        title.className = "storage-conversation-title";
        const date = document.createElement("time");
        copy.append(title, date);
        const bytes = document.createElement("span");
        bytes.className = "storage-conversation-size";
        label.append(checkbox, copy, bytes);
        item.append(label);
        row = { row: item, checkbox, title, date, bytes };
        rows.set(session.id, row);
      }
      const title = session.title || i18n.t("Untitled");
      row.checkbox.setAttribute("aria-label", i18n.t("Select {title}", { title }));
      row.checkbox.checked = selection.has(session.id);
      row.checkbox.disabled = blocked;
      row.title.textContent = title;
      row.title.title = title;
      row.date.dateTime = session.updatedAt;
      row.date.textContent = i18n.t("Updated {date}", { date: new Intl.DateTimeFormat(i18n.locale, { year: "numeric", month: "short", day: "numeric" }).format(new Date(session.updatedAt)) });
      row.bytes.textContent = size(session.contentBytes);
      row.bytes.title = i18n.t("Media files: {size}", { size: size(session.mediaBytes) });
      if (list.children[index] !== row.row) list.insertBefore(row.row, list.children[index] ?? null);
    });
    const selectedVisible = visible.filter(session => selection.has(session.id)).length;
    selectVisible.checked = visible.length > 0 && selectedVisible === visible.length;
    selectVisible.indeterminate = selectedVisible > 0 && selectedVisible < visible.length;
    selectVisible.disabled = blocked || !visible.length;
    deleteButton.disabled = blocked || !data || !selection.size;
    const summary = element("storageSelectionSummary");
    summary.textContent = selection.size ? i18n.t("{count} selected", { count: number(selection.size) })
      : i18n.t(visible.length === 1 ? "1 conversation" : "{count} conversations", { count: number(visible.length) });
    summary.hidden = !data;
    const estimate = element("storageReclaimEstimate");
    estimate.textContent = data && selection.size ? i18n.t("Files to free: {size}", { size: size(reclaimableBytes(data)) }) : "";
    estimate.hidden = !estimate.textContent;
    const empty = element("storageConversationsEmpty");
    empty.hidden = !data || visible.length > 0;
    empty.textContent = i18n.t(data?.sessions.length ? "No conversations match your search." : "No saved conversations.");
    element("storageConversationSelection").hidden = !data?.sessions.length;
  }

  function render() {
    if (!scope || !section.isConnected) return;
    const data = usage?.available ? usage : undefined;
    element("storageOverview").hidden = view !== "overview";
    element("storageConversations").hidden = view !== "conversations";
    element("appPreferencesOverview").hidden = view === "conversations";
    breakdown.hidden = !data;
    for (const field of storageUsageByteFields) {
      const value = element(`storage-${field}`);
      value.hidden = !data || (field === "totalBytes" && view !== "overview");
      if (data) value.textContent = size(data[field]);
    }
    const conversationCount = element("storage-sessionCount");
    conversationCount.hidden = !data;
    if (data) conversationCount.textContent = i18n.t(data.sessionCount === 1 ? "1 conversation" : "{count} conversations", { count: number(data.sessionCount) });
    const busy = Boolean(request || operation);
    section.setAttribute("aria-busy", String(busy));
    refreshButton.disabled = busy;
    refreshButton.setAttribute("aria-busy", String(busy));
    refreshButton.setAttribute("aria-label", i18n.t(operation ? busyMessages[operation]
      : request ? "Reading storage usage…" : "Refresh storage usage"));
    commands.clear_storage_backups.disabled = busy || commandBlocked || readFailed || !data?.backupFileCount;
    commands.compact_storage.disabled = busy || commandBlocked || readFailed || !data?.databaseFreeBytes;
    commands.open_storage_directory.disabled = busy || commandBlocked || readFailed || !data;
    element<HTMLButtonElement>("manageStorageConversationsButton").disabled = Boolean(operation);
    element<HTMLButtonElement>("storageConversationsBackButton").disabled = Boolean(operation);
    const currentUsage = view === "overview" ? usage : sessionUsage;
    const text = readFailed ? i18n.t("Storage usage could not be read. Choose Refresh to try again.")
      : currentUsage?.available === false ? i18n.t("Live Smith is using temporary storage for this window.")
      : feedback ? i18n.text(feedback.message) : "";
    if (status.textContent !== text) status.textContent = text;
    status.hidden = !text;
    status.classList.toggle("error", readFailed || feedback?.isError === true);
    if (view === "conversations") renderList();
  }

  async function refresh({ clearFeedback = false } = {}) {
    const opening = scope;
    if (!opening || request || !section.isConnected) return;
    const target = view;
    const current = new window.AbortController();
    request = current;
    render();
    try {
      if (target === "overview") {
        const next = await readStorageUsage(current.signal);
        if (request === current && scope === opening) {
          usage = next;
          readFailed = false;
        }
      } else {
        const next = await readSessionStorageUsage(current.signal);
        if (request === current && scope === opening) {
          sessionUsage = next;
          readFailed = false;
          if (next.available) {
            const ids = new Set(next.sessions.map(session => session.id));
            for (const id of selection) if (!ids.has(id)) selection.delete(id);
            if (rangeAnchor && !ids.has(rangeAnchor.id)) rangeAnchor = undefined;
            if (rangeAnchor) for (const id of rangeAnchor.selection) if (!ids.has(id)) rangeAnchor.selection.delete(id);
          }
        }
      }
      if (clearFeedback && request === current && scope === opening) feedback = undefined;
    } catch {
      if (request === current && scope === opening) {
        readFailed = true;
      }
    } finally {
      if (request === current && scope === opening) {
        request = undefined;
        render();
      }
    }
  }

  function showView(next: View) {
    request?.abort();
    request = undefined;
    if (view === "overview" && next === "conversations") overviewScrollTop = appPanel.scrollTop;
    view = next;
    readFailed = false;
    feedback = undefined;
    render();
    appPanel.scrollTop = next === "conversations" ? 0 : overviewScrollTop;
    void refresh();
  }

  function present(opening: AbortController) {
    return { statusPresenter(message: FeedbackMessage, isError = false) {
      if (scope === opening) feedback = { message, isError };
    } };
  }

  async function execute(kind: MaintenanceCommand) {
    const opening = scope;
    const reviewedUsage = usage;
    if (!opening || commands[kind].disabled || !reviewedUsage?.available) return;
    let input: { revision?: string } = {};
    if (kind === "clear_storage_backups") {
      const accepted = await confirmAction({
        title: i18n.message("Clear old backups?"),
        message: i18n.message(reviewedUsage.backupFileCount === 1
          ? "Permanently delete one old backup file ({size})? This removes an old restore copy. Your current conversations are kept."
          : "Permanently delete {count} old backup files ({size})? This removes old restore copies. Your current conversations are kept.",
        { count: () => number(reviewedUsage.backupFileCount), size: () => size(reviewedUsage.backupBytes) }),
        acceptLabel: i18n.message("Clear old backups"), danger: true, signal: opening.signal,
      });
      if (!accepted || scope !== opening || usage !== reviewedUsage || commands[kind].disabled) return;
      input = { revision: reviewedUsage.backupRevision };
    }
    operation = kind;
    feedback = undefined;
    render();
    try {
      await runCommand(kind, input, present(opening));
    } finally {
      if (scope === opening) {
        operation = undefined;
        if (kind === "open_storage_directory") render(); else void refresh();
      }
    }
  }

  async function deleteSelected() {
    const opening = scope;
    const reviewedUsage = sessionUsage;
    if (!opening || deleteButton.disabled || !reviewedUsage?.available) return;
    const selectedIds = reviewedUsage.sessions.filter(session => selection.has(session.id)).map(session => session.id);
    const reclaimable = reclaimableBytes(reviewedUsage);
    const accepted = await confirmAction({
      title: i18n.message("Delete selected conversations?"),
      message: i18n.message("Permanently delete {count} conversations, including their messages, attachments and artifacts? Estimated files to free: {size}. Shared files still in use, exported files and old backups are kept.",
        { count: () => number(selectedIds.length), size: () => size(reclaimable) }),
      acceptLabel: i18n.message("Delete selected"), danger: true, signal: opening.signal,
    });
    if (!accepted || scope !== opening || reviewedUsage !== sessionUsage || deleteButton.disabled) return;
    operation = "delete_session";
    feedback = undefined;
    render();
    try {
      for (const sessionId of selectedIds) {
        const succeeded = await runCommand("delete_session", { sessionId }, present(opening));
        if (scope !== opening) return;
        if (!succeeded) {
          if (!feedback) feedback = { message: i18n.message("Deletion stopped. Refresh the list and try the remaining conversations again."), isError: true };
          break;
        }
        selection.delete(sessionId);
      }
    } finally {
      if (scope === opening) {
        operation = undefined;
        void refresh();
      }
    }
  }

  return {
    initialize() {
      section = element("storageSettingsSection");
      appPanel = element("appPanel");
      breakdown = element("storageUsageBreakdown");
      status = element("storageUsageStatus");
      refreshButton = element("refreshStorageUsageButton");
      list = element("storageConversationList");
      search = element("storageConversationSearch");
      sort = element("storageConversationSort");
      selectVisible = element("storageSelectVisible");
      deleteButton = element("deleteStorageConversationsButton");
      commands = { clear_storage_backups: element("clearStorageBackupsButton"), compact_storage: element("compactStorageButton"), open_storage_directory: element("openStorageDirectoryButton") };
      refreshButton.addEventListener("click", () => { void refresh({ clearFeedback: true }); });
      element("manageStorageConversationsButton").addEventListener("click", () => { showView("conversations"); search.focus({ preventScroll: true }); });
      element("storageConversationsBackButton").addEventListener("click", () => { showView("overview"); element("manageStorageConversationsButton").focus({ preventScroll: true }); });
      search.addEventListener("input", renderList);
      sort.addEventListener("change", renderList);
      selectVisible.addEventListener("change", () => {
        rangeAnchor = undefined;
        for (const session of visibleSessions()) {
          if (selectVisible.checked) selection.add(session.id); else selection.delete(session.id);
        }
        renderList();
      });
      deleteButton.addEventListener("click", () => { void deleteSelected(); });
      for (const kind of Object.keys(commands) as MaintenanceCommand[]) commands[kind].addEventListener("click", () => { void execute(kind); });
    },
    setVisible(visible: boolean) {
      if (visible === Boolean(scope)) return;
      if (visible) {
        scope = new window.AbortController();
        void refresh();
        return;
      }
      scope?.abort();
      scope = undefined;
      request?.abort();
      request = undefined;
      operation = undefined;
      feedback = undefined;
    },
    setCommandBlocked(blocked: boolean) {
      if (blocked === commandBlocked) return;
      commandBlocked = blocked;
      render();
    },
    refreshLocale: render,
  };
}
