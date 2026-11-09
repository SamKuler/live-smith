import assert from "node:assert/strict";
import test from "node:test";
import { uiMessage } from "../../../src/i18n/ui-message.js";
import type { SessionStorageUsage } from "../../../src/storage/session-usage.js";
import type { StorageUsage } from "../../../src/storage/management.js";
import { commandCalls, createDialogHarness, stateFixture } from "../support/chat-dialog.test-harness.js";

const usage = {
  available: true,
  totalBytes: 32768,
  databaseBytes: 8192,
  databaseFreeBytes: 4096,
  mediaBytes: 12288,
  backupBytes: 6144,
  backupFileCount: 3,
  backupRevision: "a".repeat(64),
  exportBytes: 4096,
  pluginBytes: 1536,
  otherBytes: 512,
  sessionCount: 4,
} satisfies StorageUsage;

const refresh = "#refreshStorageUsageButton";
const clear = "#clearStorageBackupsButton";
const compact = "#compactStorageButton";
const openFolder = "#openStorageDirectoryButton";
const manageConversations = "#manageStorageConversationsButton";
const status = "#storageUsageStatus";
const breakdown = "#storageUsageBreakdown";
const section = "#storageSettingsSection";

function usageResponse(value: unknown): Response {
  return Response.json(value);
}

async function storageDialog(...responses: Array<Response | Promise<Response>>) {
  const harness = await createDialogHarness(stateFixture(), {
    baseUrl: "http://bridge.test",
    token: "test-token",
    viewId: "test-view",
  }, { navigatorLanguages: ["en"] });
  const window = harness.document.defaultView!;
  const fetch = window.fetch;
  const reads: Array<{ url: URL; init: RequestInit | undefined }> = [];
  const sessionReads: typeof reads = [];
  const sessionResponses: Array<Response | Promise<Response>> = [];
  Object.defineProperty(window, "fetch", {
    configurable: true,
    value: (input: string, init?: RequestInit) => {
      const url = new URL(input);
      if (!["/storage-usage", "/session-storage-usage"].includes(url.pathname)) return fetch(input, init);
      const targetReads = url.pathname === "/storage-usage" ? reads : sessionReads;
      const targetResponses = url.pathname === "/storage-usage" ? responses : sessionResponses;
      targetReads.push({ url, init });
      const response = targetResponses.shift();
      assert.ok(response, "Unexpected storage usage read");
      return Promise.resolve(response);
    },
  });
  const element = <T extends HTMLElement = HTMLElement>(selector: string) => {
    const result = harness.document.querySelector<T>(selector);
    assert.ok(result, selector);
    return result;
  };
  return { ...harness, reads, sessionReads, sessionResponses, element, disabled: (selector: string) => element<HTMLButtonElement>(selector).disabled };
}

test("storage stats are read when App opens and locale changes reuse the current result", async () => {
  const dialog = await storageDialog(usageResponse(usage));
  try {
    assert.equal(dialog.reads.length, 0);
    dialog.click("#appTab");
    await dialog.settle();

    assert.equal(dialog.reads.length, 1);
    const { url, init } = dialog.reads[0]!;
    assert.equal(init?.method ?? "GET", "GET");
    assert.equal(init?.body, undefined);
    assert.deepEqual([...url.searchParams.entries()], [["token", "test-token"]]);
    assert.equal(new Headers(init?.headers).get("X-Live-Smith-View-Id"), "test-view");
    assert.equal(dialog.element(breakdown).hidden, false);
    assert.equal(dialog.element("#storage-totalBytes").textContent, "32 KiB");
    assert.equal(dialog.element("#storage-pluginBytes").textContent, "1.5 KiB");
    assert.equal(dialog.element("#storage-sessionCount").textContent, "4 conversations");
    const details = dialog.element<HTMLDetailsElement>(breakdown);
    assert.equal(details.open, false);
    dialog.click(`${breakdown} > summary`);
    await dialog.settle();
    assert.equal(details.open, true);

    dialog.select("#uiLanguage", "zh-CN");
    await dialog.settle();
    assert.equal(dialog.reads.length, 1);
    assert.equal(dialog.element("#storageSettingsHeading").textContent, "存储");
    assert.equal(dialog.element("#storage-sessionCount").textContent, "4 个会话");
    assert.equal(details.open, true, "language updates keep the requested details open");
    dialog.click(clear);
    assert.equal(dialog.element("#appConfirmationTitle").textContent, "清理旧备份？");
    assert.match(dialog.element("#appConfirmationMessage").textContent!, /3 个旧备份文件（6 KiB）.*当前聊天记录会保留/);
    await dialog.cancelAppConfirmation();
    assert.deepEqual(dialog.errors, []);
  } finally {
    dialog.close();
  }
});

test("confirmed cleanup submits the reviewed revision and displays success only in the global status", async () => {
  const afterCleanup = { ...usage, backupBytes: 0, backupFileCount: 0, backupRevision: "b".repeat(64), totalBytes: 26624 };
  const dialog = await storageDialog(usageResponse(usage), usageResponse(afterCleanup));
  let holding = false;
  try {
    dialog.click("#appTab");
    await dialog.settle();
    dialog.element(clear).focus();
    dialog.click(clear);
    assert.match(dialog.element("#appConfirmationMessage").textContent!, /3 old backup files \(6 KiB\).*restore copies.*current conversations/);
    assert.equal(dialog.document.activeElement?.id, "appConfirmationCancel");
    await dialog.cancelAppConfirmation();
    assert.equal(dialog.document.activeElement?.id, "clearStorageBackupsButton");
    assert.deepEqual(commandCalls(dialog), []);

    dialog.holdNextCommand();
    holding = true;
    dialog.click(clear);
    await dialog.acceptAppConfirmation();
    assert.deepEqual(commandCalls(dialog).map(call => call.body), [{ kind: "clear_storage_backups", revision: usage.backupRevision }]);
    assert.equal(dialog.element(section).getAttribute("aria-busy"), "true");
    assert.equal(dialog.element(refresh).getAttribute("aria-label"), "Clearing old backups…");
    assert.equal(dialog.element(status).hidden, true);
    for (const selector of [clear, compact, openFolder, refresh]) assert.equal(dialog.disabled(selector), true);
    assert.equal(dialog.reads.length, 1);
    dialog.setServerState({ ...stateFixture(), status: uiMessage("Old backups cleared.") });
    dialog.releaseHeldCommand();
    holding = false;
    await dialog.settle();

    assert.equal(dialog.reads.length, 2);
    assert.equal(dialog.element("#storage-backupBytes").textContent, "0 B");
    assert.equal(dialog.disabled(clear), true);
    assert.equal(dialog.disabled(refresh), false);
    assert.equal(dialog.element("#status").textContent, "Old backups cleared.");
    assert.equal(dialog.element(status).hidden, true);
    assert.equal(dialog.element(status).textContent, "");

    dialog.select("#uiLanguage", "zh-CN");
    await dialog.settle();
    assert.equal(dialog.element("#status").textContent, "旧备份已清理。");
    assert.equal(dialog.element(status).hidden, true);
    assert.equal(dialog.reads.length, 2);
    assert.deepEqual(dialog.errors, []);
  } finally {
    if (holding) dialog.releaseHeldCommand();
    dialog.close();
  }
});

test("cleanup conflict shows updated usage and stays visible until a manual refresh succeeds", async () => {
  const changed = { ...usage, backupRevision: "b".repeat(64), backupBytes: 2048, backupFileCount: 1, totalBytes: 28672 };
  const retry = Promise.withResolvers<Response>();
  const dialog = await storageDialog(usageResponse(usage), usageResponse(changed), retry.promise);
  try {
    dialog.click("#appTab");
    await dialog.settle();
    const message = "Stored backup files changed. Refresh storage usage and try again.";
    dialog.failNextCommand(message, undefined, { status: 409, displayMessage: uiMessage(message) });
    dialog.click(clear);
    await dialog.acceptAppConfirmation();
    await dialog.settle();
    assert.equal(dialog.element(status).textContent, message);
    assert.equal(dialog.element(status).classList.contains("error"), true);
    assert.equal(dialog.element("#storage-backupBytes").textContent, "2 KiB");
    dialog.click(clear);
    assert.match(dialog.element("#appConfirmationMessage").textContent!, /one old backup file \(2 KiB\)/);
    await dialog.cancelAppConfirmation();

    dialog.click(refresh);
    assert.equal(dialog.element(status).hidden, false);
    assert.equal(dialog.element(status).textContent, message);
    retry.resolve(usageResponse(changed));
    await dialog.settle();
    assert.equal(dialog.element(status).hidden, true);
    assert.equal(dialog.disabled(clear), false);
    assert.deepEqual(commandCalls(dialog).map(call => call.body), [{ kind: "clear_storage_backups", revision: usage.backupRevision }]);
    assert.deepEqual(dialog.errors, []);
  } finally {
    retry.resolve(usageResponse(changed));
    dialog.close();
  }
});

test("failed and invalid reads can be retried and temporary storage disables disk actions", async () => {
  const dialog = await storageDialog(
    new Response(null, { status: 503 }),
    usageResponse({ ...usage, backupRevision: "not-a-revision" }),
    usageResponse({ available: false } satisfies StorageUsage),
  );
  try {
    dialog.click("#appTab");
    assert.equal(dialog.disabled(refresh), true);
    assert.equal(dialog.disabled(clear), true);
    assert.equal(dialog.element(section).getAttribute("aria-busy"), "true");
    assert.equal(dialog.element(refresh).getAttribute("aria-label"), "Reading storage usage…");
    assert.equal(dialog.element(status).hidden, true);
    await dialog.settle();
    assert.match(dialog.element(status).textContent!, /Choose Refresh/);
    assert.equal(dialog.disabled(refresh), false);

    dialog.click(refresh);
    await dialog.settle();
    assert.match(dialog.element(status).textContent!, /Choose Refresh/);
    assert.equal(dialog.element(breakdown).hidden, true);
    assert.equal(dialog.disabled(clear), true);

    dialog.click(refresh);
    await dialog.settle();
    assert.match(dialog.element(status).textContent!, /temporary storage/);
    assert.equal(dialog.element(status).classList.contains("error"), false);
    assert.equal(dialog.element(breakdown).hidden, true);
    for (const selector of [clear, compact, openFolder]) assert.equal(dialog.disabled(selector), true);
    assert.equal(dialog.disabled(manageConversations), false);
    assert.deepEqual(commandCalls(dialog), []);
    assert.deepEqual(dialog.errors, []);
  } finally {
    dialog.close();
  }
});

test("overview refresh keeps the previous usage visible and locks maintenance until a successful read", async () => {
  const failed = Promise.withResolvers<Response>();
  const retry = Promise.withResolvers<Response>();
  const updated = { ...usage, databaseFreeBytes: 2048 };
  const dialog = await storageDialog(usageResponse(usage), failed.promise, retry.promise);
  try {
    dialog.click("#appTab");
    await dialog.settle();
    dialog.click(`${breakdown} > summary`);
    await dialog.settle();
    const details = dialog.element<HTMLDetailsElement>(breakdown);
    const total = dialog.element("#storage-totalBytes");
    const free = dialog.element("#storage-databaseFreeBytes");
    assert.equal(details.open, true);
    assert.equal(dialog.disabled(compact), false);

    dialog.click(refresh);
    assert.equal(dialog.element(section).getAttribute("aria-busy"), "true");
    assert.equal(dialog.element(status).hidden, true);
    assert.equal(total.textContent, "32 KiB");
    assert.equal(free.textContent, "4 KiB");
    assert.equal(dialog.disabled(compact), true);

    failed.resolve(new Response(null, { status: 503 }));
    await dialog.settle();
    const failure = dialog.element(status).textContent;
    assert.match(failure!, /Choose Refresh/);
    assert.equal(dialog.element(status).hidden, false);
    assert.equal(details.hidden, false);
    assert.equal(total.hidden, false);
    assert.equal(total.textContent, "32 KiB");
    assert.equal(free.textContent, "4 KiB");
    assert.equal(dialog.disabled(refresh), false);
    for (const selector of [clear, compact]) assert.equal(dialog.disabled(selector), true);
    dialog.click(compact);
    assert.deepEqual(commandCalls(dialog), []);

    dialog.click(refresh);
    assert.equal(dialog.element(status).textContent, failure);
    assert.equal(dialog.element(status).hidden, false);
    assert.equal(dialog.disabled(compact), true);
    retry.resolve(usageResponse(updated));
    await dialog.settle();
    assert.equal(dialog.element(section).getAttribute("aria-busy"), "false");
    assert.equal(dialog.element(refresh).getAttribute("aria-label"), "Refresh storage usage");
    assert.equal(dialog.element(status).hidden, true);
    assert.equal(details.open, true);
    assert.equal(dialog.element("#storage-databaseFreeBytes"), free);
    assert.equal(free.textContent, "2 KiB");
    assert.equal(dialog.disabled(compact), false);
    assert.deepEqual(dialog.errors, []);
  } finally {
    failed.resolve(new Response(null, { status: 503 }));
    retry.resolve(usageResponse(updated));
    dialog.close();
  }
});

test("closing App aborts its read and reopening keeps previous usage until the next result", async () => {
  const late = Promise.withResolvers<Response>();
  const reopened = Promise.withResolvers<Response>();
  const updated = { ...usage, totalBytes: 36864, mediaBytes: 16384 };
  const dialog = await storageDialog(usageResponse(usage), late.promise, reopened.promise);
  try {
    dialog.click("#appTab");
    await dialog.settle();
    dialog.click(refresh);
    const staleSignal = dialog.reads[1]?.init?.signal;
    assert.ok(staleSignal);
    dialog.click("#settingsButton");
    assert.equal(staleSignal.aborted, true);
    assert.equal(dialog.reads.length, 2);
    dialog.click("#settingsButton");
    assert.equal(dialog.reads.length, 3);
    const total = dialog.element("#storage-totalBytes");
    assert.equal(total.hidden, false);
    assert.equal(total.textContent, "32 KiB");
    assert.equal(dialog.element(status).hidden, true);

    reopened.resolve(usageResponse(updated));
    await dialog.settle();
    late.resolve(usageResponse({ available: false }));
    await dialog.settle();
    assert.equal(total.textContent, "36 KiB");
    assert.equal(dialog.disabled(openFolder), false);
    assert.deepEqual(dialog.errors, []);
  } finally {
    late.resolve(usageResponse({ available: false }));
    reopened.resolve(usageResponse(updated));
    dialog.close();
  }
});

test("free space refreshes storage, folder opening leaves the count alone, and Manage opens the storage conversation list", async () => {
  const compacted = { ...usage, databaseBytes: 4096, databaseFreeBytes: 0, totalBytes: 28672 };
  const dialog = await storageDialog(usageResponse(usage), usageResponse(compacted));
  let holding = false;
  try {
    dialog.click("#sessionsToggleButton");
    dialog.click("#appTab");
    await dialog.settle();
    dialog.holdNextCommand();
    holding = true;
    dialog.click(compact);
    dialog.setServerState({ ...stateFixture(), status: uiMessage("Database space reclaimed.") });
    dialog.releaseHeldCommand();
    holding = false;
    await dialog.settle();
    assert.equal(dialog.element("#status").textContent, "Database space reclaimed.");
    assert.equal(dialog.element(status).hidden, true);
    assert.equal(dialog.element("#storage-databaseFreeBytes").textContent, "0 B");
    assert.equal(dialog.disabled(compact), true);
    assert.equal(dialog.reads.length, 2);
    dialog.click(`${breakdown} > summary`);
    await dialog.settle();
    dialog.click(openFolder);
    await dialog.settle();
    assert.equal(dialog.reads.length, 2);
    assert.deepEqual(commandCalls(dialog).map(call => call.body), [{ kind: "compact_storage" }, { kind: "open_storage_directory" }]);

    dialog.sessionResponses.push(usageResponse({ available: true, sessions: [], media: [] }));
    dialog.click(manageConversations);
    await dialog.settle();
    assert.equal(dialog.element("#inspectorPane").hidden, false);
    assert.equal(dialog.element("#storageConversations").hidden, false);
    assert.equal(dialog.document.activeElement?.id, "storageConversationSearch");
    assert.equal(dialog.sessionReads.length, 1);
    assert.equal(commandCalls(dialog).length, 2);
    assert.deepEqual(dialog.errors, []);
  } finally {
    if (holding) dialog.releaseHeldCommand();
    dialog.close();
  }
});

const sessionUsage = {
  available: true,
  sessions: [
    { id: "session-1", title: "Bass session", updatedAt: "2026-11-01T10:00:00Z", contentBytes: 4096, mediaBytes: 3584 },
    { id: "session-2", title: "Lead session", updatedAt: "2026-11-03T10:00:00Z", contentBytes: 8192, mediaBytes: 2048 },
    { id: "session-3", title: "Archived drums", updatedAt: "2026-11-07T10:00:00Z", contentBytes: 2048, mediaBytes: 512 },
  ],
  media: [
    { bytes: 1024, sessionIds: ["session-1"], retained: false },
    { bytes: 2048, sessionIds: ["session-1", "session-2"], retained: false },
    { bytes: 512, sessionIds: ["session-1"], retained: true },
    { bytes: 512, sessionIds: ["session-3"], retained: false },
  ],
} satisfies SessionStorageUsage;

const select = (id: string) => `#storageConversationList [data-session-id="${id}"] input`;
const row = (id: string) => `#storageConversationList [data-session-id="${id}"] label`;
const removeSelected = "#deleteStorageConversationsButton";
const estimate = "#storageReclaimEstimate";
const summary = "#storageSelectionSummary";
const listSearch = "#storageConversationSearch";
const visibleSelect = "#storageSelectVisible";

async function openList(dialog: Awaited<ReturnType<typeof storageDialog>>, response: Response | Promise<Response> = usageResponse(sessionUsage)) {
  dialog.click("#appTab");
  await dialog.settle();
  dialog.sessionResponses.push(response);
  dialog.click(manageConversations);
  await dialog.settle();
}

test("conversation list sorts and filters real rows, preserves focus, and estimates shared files once", async () => {
  const dialog = await storageDialog(usageResponse(usage));
  try {
    await openList(dialog);
    const ids = () => [...dialog.document.querySelectorAll<HTMLElement>("#storageConversationList li")].map(row => row.dataset.sessionId);
    assert.deepEqual(ids(), ["session-2", "session-1", "session-3"]);
    assert.match(dialog.element(row("session-1")).textContent!, /Bass session.*Nov 1, 2026/);
    assert.equal(dialog.element("#storage-totalBytes").hidden, true);
    const first = dialog.element<HTMLInputElement>(select("session-1"));
    first.focus();
    dialog.click(select("session-1"));
    assert.equal(dialog.document.activeElement, first);
    assert.equal(dialog.element(estimate).textContent, "Files to free: 1 KiB");
    assert.equal(dialog.element<HTMLInputElement>(visibleSelect).indeterminate, true);
    dialog.select("#storageConversationSort", "updated");
    assert.deepEqual(ids(), ["session-3", "session-2", "session-1"]);
    dialog.input(listSearch, "Lead");
    assert.deepEqual(ids(), ["session-2"]);
    dialog.click(visibleSelect);
    assert.equal(dialog.element(summary).textContent, "2 selected");
    assert.equal(dialog.element(estimate).textContent, "Files to free: 3 KiB");
    dialog.input(listSearch, "");
    dialog.click(visibleSelect);
    assert.equal(dialog.element(summary).textContent, "3 selected");
    assert.equal(dialog.element(estimate).textContent, "Files to free: 3.5 KiB");
    dialog.input(listSearch, "No match");
    assert.equal(dialog.element("#storageConversationsEmpty").hidden, false);
    assert.equal(dialog.disabled(visibleSelect), true);
    assert.equal(dialog.disabled(removeSelected), false);
    assert.equal(dialog.element(summary).textContent, "3 selected");
    dialog.select("#uiLanguage", "zh-CN");
    await dialog.settle();
    assert.equal(dialog.element(estimate).textContent, "预计释放文件：3.5 KiB");
    assert.equal(dialog.sessionReads.length, 1);
    assert.deepEqual(dialog.errors, []);
  } finally { dialog.close(); }
});

test("deletion requires confirmation, runs sequentially, stops on failure and keeps remaining selections", async () => {
  const dialog = await storageDialog(usageResponse(usage));
  try {
    await openList(dialog);
    dialog.click(visibleSelect);
    dialog.element(removeSelected).focus();
    dialog.click(removeSelected);
    assert.match(dialog.element("#appConfirmationMessage").textContent!, /3 conversations.*messages, attachments and artifacts.*3.5 KiB.*Shared files.*exported files.*old backups/);
    await dialog.cancelAppConfirmation();
    assert.equal(dialog.document.activeElement?.id, "deleteStorageConversationsButton");
    assert.deepEqual(commandCalls(dialog), []);
    const fetch = dialog.window.fetch;
    let deletions = 0;
    Object.defineProperty(dialog.window, "fetch", { configurable: true, value: (input: string, init?: RequestInit) => {
      if (new URL(input).pathname === "/command" && JSON.parse(String(init?.body)).kind === "delete_session" && ++deletions === 2) {
        dialog.failNextCommand("This conversation is busy.");
      }
      return fetch(input, init);
    } });
    const after = { ...sessionUsage, sessions: sessionUsage.sessions.slice(1), media: [
      { bytes: 2048, sessionIds: ["session-2"], retained: false },
      { bytes: 512, sessionIds: ["session-3"], retained: false },
    ] };
    dialog.sessionResponses.push(usageResponse(after));
    dialog.click(removeSelected);
    await dialog.acceptAppConfirmation();
    await dialog.settle();
    assert.deepEqual(commandCalls(dialog).map(call => call.body), [
      { kind: "delete_session", sessionId: "session-1" }, { kind: "delete_session", sessionId: "session-2" },
    ]);
    assert.equal(dialog.element(summary).textContent, "2 selected");
    assert.equal(dialog.element(estimate).textContent, "Files to free: 2.5 KiB");
    assert.equal(dialog.element<HTMLInputElement>(select("session-2")).checked, true);
    assert.equal(dialog.element<HTMLInputElement>(select("session-3")).checked, true);
    assert.match(dialog.element(status).textContent!, /busy/);
    assert.equal(dialog.element(status).classList.contains("error"), true);
    assert.equal(dialog.sessionReads.length, 2);
    assert.equal(dialog.disabled(removeSelected), false);
    assert.deepEqual(dialog.errors, []);
  } finally { dialog.close(); }
});

test("successful deletion refreshes the list and leaves success in the global status", async () => {
  const dialog = await storageDialog(usageResponse(usage));
  let holding = false;
  try {
    await openList(dialog);
    dialog.click(select("session-1"));
    dialog.click(select("session-2"));
    dialog.sessionResponses.push(usageResponse({ available: true, sessions: [sessionUsage.sessions[2]], media: [sessionUsage.media[3]] }));
    dialog.holdNextCommand();
    holding = true;
    dialog.click(removeSelected);
    await dialog.acceptAppConfirmation();
    assert.equal(dialog.element(refresh).getAttribute("aria-label"), "Deleting selected conversations…");
    assert.equal(dialog.element(status).hidden, true);
    dialog.setServerState({ ...stateFixture(), status: uiMessage("Session deleted.") });
    dialog.releaseHeldCommand();
    holding = false;
    await dialog.settle();
    assert.deepEqual(commandCalls(dialog).map(call => call.body), [
      { kind: "delete_session", sessionId: "session-1" }, { kind: "delete_session", sessionId: "session-2" },
    ]);
    assert.equal(dialog.element("#status").textContent, "Session deleted.");
    assert.equal(dialog.element(status).hidden, true);
    assert.equal(dialog.disabled(removeSelected), true);
    assert.equal(dialog.element(summary).textContent, "1 conversation");
    assert.equal(dialog.element(estimate).hidden, true);
    assert.deepEqual(dialog.errors, []);
  } finally { if (holding) dialog.releaseHeldCommand(); dialog.close(); }
});

test("closing stops a deletion batch and its late result cannot change the reopened selection", async () => {
  const dialog = await storageDialog(usageResponse(usage));
  let held = false;
  try {
    await openList(dialog);
    dialog.click(select("session-1"));
    dialog.click(select("session-2"));
    dialog.holdNextCommand(); held = true;
    dialog.click(removeSelected);
    await dialog.acceptAppConfirmation();
    assert.equal(dialog.disabled(removeSelected), true);
    dialog.click("#settingsButton");
    dialog.sessionResponses.push(usageResponse(sessionUsage));
    dialog.click("#settingsButton");
    await dialog.settle();
    dialog.releaseHeldCommand(); held = false;
    await dialog.settle();
    assert.equal(commandCalls(dialog).filter(call => (call.body as { kind: string }).kind === "delete_session").length, 1);
    assert.equal(dialog.element(summary).textContent, "2 selected");
    assert.equal(dialog.element<HTMLInputElement>(select("session-1")).checked, true);
    assert.equal(dialog.sessionReads.length, 2);
    assert.equal(dialog.element(status).hidden, true);
    assert.deepEqual(dialog.errors, []);
  } finally { if (held) dialog.releaseHeldCommand(); dialog.close(); }
});

test("stale inventory reads cannot update a reopened list, and refresh prunes vanished selections", async () => {
  const dialog = await storageDialog(usageResponse(usage));
  const lateInventory = Promise.withResolvers<Response>();
  try {
    await openList(dialog);
    dialog.input(listSearch, "Bass");
    dialog.click(select("session-1"));
    dialog.sessionResponses.push(lateInventory.promise);
    dialog.click(refresh);
    const staleSignal = dialog.sessionReads.at(-1)?.init?.signal;
    dialog.click("#settingsButton");
    assert.equal(staleSignal?.aborted, true);
    dialog.sessionResponses.push(usageResponse(sessionUsage));
    dialog.click("#settingsButton");
    await dialog.settle();
    lateInventory.resolve(usageResponse({ available: false }));
    await dialog.settle();
    assert.equal(dialog.element<HTMLInputElement>(listSearch).value, "Bass");
    assert.equal(dialog.element<HTMLInputElement>(select("session-1")).checked, true);
    dialog.sessionResponses.push(usageResponse({ available: true, sessions: sessionUsage.sessions.slice(1), media: [] }));
    dialog.click(refresh);
    await dialog.settle();
    assert.equal(dialog.element(summary).textContent, "0 conversations");
    assert.equal(dialog.disabled(removeSelected), true);
    assert.deepEqual(dialog.errors, []);
  } finally {
    lateInventory.resolve(usageResponse({ available: false }));
    dialog.close();
  }
});

test("an invalid first inventory read leaves the conversation list unavailable", async () => {
  const dialog = await storageDialog(usageResponse(usage));
  try {
    await openList(dialog, usageResponse({ ...sessionUsage, sessions: [sessionUsage.sessions[0], sessionUsage.sessions[0]] }));
    assert.equal(dialog.element("#storageConversationList").children.length, 0);
    assert.equal(dialog.element(summary).hidden, true);
    assert.equal(dialog.element("#storageConversationsEmpty").hidden, true);
    assert.equal(dialog.disabled(removeSelected), true);
    assert.equal(dialog.disabled(refresh), false);
    assert.match(dialog.element(status).textContent!, /Choose Refresh/);
    assert.deepEqual(dialog.errors, []);
  } finally { dialog.close(); }
});

test("inventory refresh keeps rows and selections visible and locks deletion until a valid read", async () => {
  const dialog = await storageDialog(usageResponse(usage));
  const delayed = Promise.withResolvers<Response>();
  const retry = Promise.withResolvers<Response>();
  try {
    await openList(dialog);
    dialog.click(select("session-1"));
    const bass = dialog.element<HTMLInputElement>(select("session-1"));
    assert.equal(dialog.disabled(removeSelected), false);

    dialog.sessionResponses.push(delayed.promise);
    dialog.click(refresh);
    assert.equal(dialog.element(section).getAttribute("aria-busy"), "true");
    assert.equal(dialog.element(status).hidden, true);
    assert.equal(dialog.element(select("session-1")), bass);
    assert.equal(bass.checked, true);
    assert.equal(dialog.element(estimate).textContent, "Files to free: 1 KiB");
    assert.equal(dialog.disabled(removeSelected), true);
    delayed.resolve(usageResponse({ ...sessionUsage, sessions: [{ ...sessionUsage.sessions[0], contentBytes: -1 }] }));
    await dialog.settle();
    assert.equal(dialog.disabled(removeSelected), true);
    assert.equal(dialog.element(select("session-1")), bass);
    assert.match(dialog.element(status).textContent!, /Choose Refresh/);

    dialog.sessionResponses.push(usageResponse({ ...sessionUsage, media: [{ bytes: 10, sessionIds: ["session-missing"], retained: false }] }));
    dialog.click(refresh);
    await dialog.settle();
    assert.equal(dialog.disabled(removeSelected), true);
    assert.equal(dialog.element(select("session-1")), bass);
    assert.match(dialog.element(status).textContent!, /Choose Refresh/);
    dialog.click(removeSelected);
    assert.equal(dialog.element("#appConfirmation").hidden, true);

    dialog.sessionResponses.push(retry.promise);
    dialog.click(refresh);
    assert.equal(dialog.element(status).hidden, false);
    assert.equal(dialog.disabled(removeSelected), true);
    retry.resolve(usageResponse(sessionUsage));
    await dialog.settle();
    assert.equal(dialog.element(select("session-1")), bass);
    assert.equal(bass.checked, true);
    assert.equal(dialog.element(status).hidden, true);
    assert.equal(dialog.disabled(removeSelected), false);
    dialog.sessionResponses.push(usageResponse({ available: false }));
    dialog.click(refresh);
    await dialog.settle();
    assert.match(dialog.element(status).textContent!, /temporary storage/);
    assert.equal(dialog.element(estimate).hidden, true);
    assert.equal(dialog.disabled(removeSelected), true);
    assert.deepEqual(commandCalls(dialog), []);
    assert.deepEqual(dialog.errors, []);
  } finally {
    delayed.resolve(new Response(null, { status: 503 }));
    retry.resolve(usageResponse(sessionUsage));
    dialog.close();
  }
});

function modifiedClick(dialog: Awaited<ReturnType<typeof storageDialog>>, selector: string, keys: MouseEventInit) {
  const window = dialog.document.defaultView!;
  dialog.element(selector).dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true, ...keys }));
}

function selectedIds(dialog: Awaited<ReturnType<typeof storageDialog>>) {
  return [...dialog.document.querySelectorAll<HTMLInputElement>("#storageConversationList input:checked")]
    .map(input => input.closest<HTMLElement>("[data-session-id]")!.dataset.sessionId);
}

test("whole rows toggle selection and Shift ranges extend, shrink, reverse and deselect in visible order", async () => {
  const dialog = await storageDialog(usageResponse(usage));
  try {
    await openList(dialog);
    dialog.click(row("session-2"));
    assert.deepEqual(selectedIds(dialog), ["session-2"]);
    modifiedClick(dialog, row("session-3"), { shiftKey: true });
    assert.deepEqual(selectedIds(dialog), ["session-2", "session-1", "session-3"]);
    modifiedClick(dialog, row("session-1"), { shiftKey: true });
    assert.deepEqual(selectedIds(dialog), ["session-2", "session-1"]);
    dialog.click(row("session-1"));
    modifiedClick(dialog, row("session-2"), { shiftKey: true });
    assert.deepEqual(selectedIds(dialog), []);
    modifiedClick(dialog, row("session-3"), { metaKey: true });
    modifiedClick(dialog, row("session-2"), { ctrlKey: true });
    assert.deepEqual(selectedIds(dialog), ["session-2", "session-3"]);
    modifiedClick(dialog, row("session-1"), { shiftKey: true });
    assert.deepEqual(selectedIds(dialog), ["session-2", "session-1", "session-3"]);
    assert.deepEqual(commandCalls(dialog), []);
    assert.equal(dialog.readBootstrappedClientStateReference().activeSessionId, "session-1");
    assert.equal(dialog.sessionReads.length, 1);
    assert.deepEqual(dialog.errors, []);
  } finally { dialog.close(); }
});

test("range selection follows search and sorting, preserves hidden selections, and supports Shift Space", async () => {
  const dialog = await storageDialog(usageResponse(usage));
  try {
    await openList(dialog);
    dialog.click(row("session-3"));
    dialog.input(listSearch, "session");
    modifiedClick(dialog, row("session-2"), { shiftKey: true });
    assert.deepEqual(selectedIds(dialog), ["session-2"]);
    modifiedClick(dialog, row("session-1"), { shiftKey: true });
    assert.deepEqual(selectedIds(dialog), ["session-2", "session-1"]);
    assert.equal(dialog.element(summary).textContent, "3 selected");
    dialog.input(listSearch, "");
    dialog.select("#storageConversationSort", "updated");
    dialog.click(visibleSelect);
    assert.deepEqual(selectedIds(dialog), []);
    dialog.click(row("session-3"));
    const input = dialog.element<HTMLInputElement>(select("session-1"));
    input.focus();
    input.dispatchEvent(new dialog.document.defaultView!.KeyboardEvent("keydown", { key: " ", shiftKey: true, bubbles: true, cancelable: true }));
    assert.deepEqual(selectedIds(dialog), ["session-3", "session-2", "session-1"]);
    assert.equal(dialog.document.activeElement, input);
    assert.deepEqual(dialog.errors, []);
  } finally { dialog.close(); }
});

test("conversation management starts its subpage at the top and returning restores settings position and focus", async () => {
  const dialog = await storageDialog(usageResponse(usage), usageResponse(usage));
  try {
    dialog.click("#appTab");
    await dialog.settle();
    const panel = dialog.element("#appPanel");
    panel.scrollTop = 320;
    dialog.sessionResponses.push(usageResponse(sessionUsage));
    dialog.click(manageConversations);
    await dialog.settle();
    assert.equal(panel.scrollTop, 0);
    assert.equal(dialog.element("#appPreferencesOverview").hidden, true);
    dialog.click(row("session-1"));
    dialog.input(listSearch, "Bass");
    dialog.click("#storageConversationsBackButton");
    await dialog.settle();
    assert.equal(dialog.element("#appPreferencesOverview").hidden, false);
    assert.equal(panel.scrollTop, 320);
    assert.equal(dialog.document.activeElement?.id, "manageStorageConversationsButton");
    dialog.sessionResponses.push(usageResponse(sessionUsage));
    dialog.click(manageConversations);
    await dialog.settle();
    assert.equal(panel.scrollTop, 0);
    assert.equal(dialog.element<HTMLInputElement>(listSearch).value, "Bass");
    assert.deepEqual(selectedIds(dialog), ["session-1"]);
    assert.deepEqual(dialog.errors, []);
  } finally { dialog.close(); }
});
