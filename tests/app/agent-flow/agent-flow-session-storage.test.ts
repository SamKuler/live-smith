import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { URL } from "node:url";
import { runAgentFlow } from "../../../src/app/agent-flow.js";
import { saveSessionAttachment } from "../../../src/storage/attachments.js";
import { appendSessionEvent, listSessionEventLogIds, loadSessionEvents } from "../../../src/storage/events.js";
import { MEDIA_DIRECTORY_NAME } from "../../../src/storage/media-files.js";
import { createSession, listSessions, setSessionArchived } from "../../../src/storage/sessions.js";
import type { ChatDialogState, ChatSessionEventPage } from "../../../src/ui/chat-state.js";
import { isWireSessionStorageUsage } from "../../../src/ui/client/wire-contracts/storage.js";
import { liveContextPresentationFixture } from "../context/support/live-context.test-harness.js";

const currentScope = { kind: "track" as const, identity: "track-1", label: "Lead" };
const historicalScope = { kind: "track" as const, identity: "old-track", label: "Bass" };

type Endpoint = (pathname: string) => URL;

async function temporaryStorage(t: test.TestContext) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-session-storage-http-")));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function openDialog(directory: string, inspect: (endpoint: Endpoint) => Promise<void>) {
  const context = {
    application: { song: { handle: { id: 1n } } },
    environment: { storageDirectory: directory },
    ui: { showModalDialog: async (target: string) => {
      const dialogUrl = new URL(target);
      const token = dialogUrl.searchParams.get("token");
      assert.ok(token);
      await inspect(pathname => {
        const endpoint = new URL(pathname, dialogUrl);
        endpoint.searchParams.set("token", token);
        return endpoint;
      });
    } },
  };
  await runAgentFlow(context as never, {
    presentation: liveContextPresentationFixture(currentScope.label),
    summary: "Track: Lead",
    target: {},
    scope: currentScope,
  }, { renderHtml: () => "<html></html>" });
}

function postJson(url: URL, input: unknown, headers: Record<string, string> = {}) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(input),
  });
}

async function successfulJson(request: Promise<Response>): Promise<unknown> {
  const response = await request;
  const body = await response.text();
  assert.equal(response.status, 200, body);
  return JSON.parse(body);
}

async function readUsage(endpoint: Endpoint) {
  const usage = await successfulJson(fetch(endpoint("/session-storage-usage")));
  assert.ok(isWireSessionStorageUsage(usage) && usage.available);
  return usage;
}

async function readPage(endpoint: URL, input: { sessionId: string; before?: number; historyId?: string }) {
  const page = await successfulJson(postJson(endpoint, input)) as ChatSessionEventPage;
  assert.equal(page.sessionId, input.sessionId);
  return page;
}

test("production storage lists conversations across Live Sets while history pages within the current Live Set", async t => {
  const directory = await temporaryStorage(t);
  const historical = await createSession(directory, {
    title: "Bass arrangement", projectKey: "past-live-set", scope: historicalScope,
  });
  await setSessionArchived(directory, historical.id, true);
  await appendSessionEvent(directory, historical.id, { kind: "user", content: "Bass edit" });

  await openDialog(directory, async endpoint => {
    const state = async () => await successfulJson(fetch(endpoint("/state"))) as ChatDialogState;
    const activeId = (await state()).activeSessionId;
    const messages = Array.from({ length: 101 }, (_, index) => `Lead edit ${index + 1}`);
    for (const content of messages) {
      await appendSessionEvent(directory, activeId, { kind: "user", content });
    }
    const sessionsBefore = await listSessions(directory);

    const usage = await readUsage(endpoint);
    assert.deepEqual(new Set(usage.sessions.map(session => session.id)), new Set([historical.id, activeId]));
    const archived = usage.sessions.find(session => session.id === historical.id);
    const active = usage.sessions.find(session => session.id === activeId);
    assert.ok(archived && active);
    assert.equal(archived.title, historical.title);
    assert.ok(active.contentBytes > archived.contentBytes && archived.contentBytes > 0);

    const usageUrl = endpoint("/session-storage-usage");
    usageUrl.searchParams.set("path", directory);
    assert.equal((await fetch(usageUrl)).status, 400);
    usageUrl.searchParams.delete("path");
    usageUrl.searchParams.set("token", "wrong");
    assert.equal((await fetch(usageUrl)).status, 403);

    const regularEvents = endpoint("/session-events");
    assert.equal((await postJson(regularEvents, { sessionId: historical.id })).status, 404);
    const recent = await readPage(regularEvents, { sessionId: activeId });
    assert.equal(recent.total, messages.length);
    assert.deepEqual(recent.events.map(event => event.content), messages.slice(1));
    assert.ok(recent.nextBefore);
    const older = await readPage(regularEvents, {
      sessionId: activeId, before: recent.nextBefore, historyId: recent.historyId,
    });
    assert.deepEqual(older.events.map(event => event.content), messages.slice(0, 1));
    assert.equal(older.nextBefore, undefined);

    assert.equal((await state()).activeSessionId, activeId);
    assert.deepEqual(await listSessions(directory), sessionsBefore);
  });
});

test("production Session deletion releases shared media after its final owner is deleted", async t => {
  const directory = await temporaryStorage(t);
  const first = await createSession(directory, {
    title: "Bass take one", projectKey: "past-live-set", scope: historicalScope,
  });
  const last = await createSession(directory, {
    title: "Bass take two", projectKey: "another-live-set", scope: historicalScope,
  });
  await setSessionArchived(directory, first.id, true);
  await appendSessionEvent(directory, first.id, { kind: "user", content: "Delete this conversation" });
  const bytes = Buffer.from("Bass arrangement notes");
  const file = { fileName: "bass-notes.txt", bytes, claimedMediaType: "text/plain" };
  const options = { preSavePendingAttachmentRefs: [] };
  const attachment = await saveSessionAttachment(directory, first.id, file, options);
  await saveSessionAttachment(directory, last.id, file, options);
  const mediaPath = path.join(directory, MEDIA_DIRECTORY_NAME, attachment.sha256);

  await openDialog(directory, async endpoint => {
    const { activeSessionId } = await successfulJson(fetch(endpoint("/state"))) as ChatDialogState;
    const kept = await appendSessionEvent(directory, activeSessionId, { kind: "user", content: "Keep this conversation" });
    const remove = async (sessionId: string) => await successfulJson(postJson(endpoint("/command"),
      { kind: "delete_session", sessionId }, { "X-Live-Smith-Command-Id": `delete-${sessionId}` },
    )) as ChatDialogState;

    const before = await readUsage(endpoint);
    assert.equal(before.media.length, 1);
    assert.deepEqual(new Set(before.media[0]?.sessionIds), new Set([first.id, last.id]));
    assert.equal(before.media[0]?.bytes, bytes.length);
    assert.equal(before.media[0]?.retained, false);
    assert.equal(before.sessions.find(session => session.id === first.id)?.mediaBytes, bytes.length);
    assert.equal(before.sessions.find(session => session.id === last.id)?.mediaBytes, bytes.length);

    assert.equal((await remove(first.id)).activeSessionId, activeSessionId);
    assert.deepEqual(await listSessionEventLogIds(directory), [activeSessionId]);
    assert.deepEqual(await fs.readFile(mediaPath), bytes);
    const afterFirst = await readUsage(endpoint);
    assert.deepEqual(afterFirst.media, [{ bytes: bytes.length, sessionIds: [last.id], retained: false }]);
    assert.deepEqual(new Set(afterFirst.sessions.map(session => session.id)), new Set([last.id, activeSessionId]));

    assert.equal((await remove(last.id)).activeSessionId, activeSessionId);
    await assert.rejects(fs.stat(mediaPath), { code: "ENOENT" });
    const afterLast = await readUsage(endpoint);
    assert.deepEqual(afterLast.media, []);
    assert.deepEqual(afterLast.sessions.map(session => session.id), [activeSessionId]);
    assert.deepEqual((await loadSessionEvents(directory, activeSessionId)).map(event => event.id), [kept.id]);
  });
});
