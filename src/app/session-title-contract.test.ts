import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  createSession,
  listSessions,
  MAX_SESSION_TITLE_CODE_POINTS,
  updateSession,
} from "../storage/sessions.js";
import { parseCommandInput } from "./chat-bridge-http.js";
import { sessionTitleForPrompt } from "./session-context.js";

test("Session title limits use Unicode code points across HTTP and storage", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-session-title-contract-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const exact = "😀".repeat(MAX_SESSION_TITLE_CODE_POINTS);
  const over = `${exact}x`;
  const session = await createSession(directory, {
    title: exact,
    projectKey: "project-1",
    scope: { kind: "track", identity: "track-1", label: "Lead" },
  });
  assert.equal(session.title, exact);
  await assert.rejects(
    createSession(directory, {
      title: over,
      projectKey: "project-1",
      scope: { kind: "track", identity: "track-2", label: "Bass" },
    }),
    /Session title/i,
  );
  await assert.rejects(
    updateSession(directory, session.id, { title: over }),
    /Session update is invalid/i,
  );
  assert.deepEqual(parseCommandInput({
    kind: "rename_session",
    sessionId: session.id,
    title: exact,
  }), {
    kind: "rename_session",
    sessionId: session.id,
    title: exact,
  });
  assert.throws(
    () => parseCommandInput({
      kind: "rename_session",
      sessionId: session.id,
      title: over,
    }),
    /title may not exceed/i,
  );
});

test("automatic Session titles never split a surrogate pair", () => {
  const prompt = `${"a".repeat(MAX_SESSION_TITLE_CODE_POINTS - 2)}😀suffix`;
  const title = sessionTitleForPrompt(prompt, "Fallback");
  assert.equal([...title].length, MAX_SESSION_TITLE_CODE_POINTS);
  assert.equal(title, `${"a".repeat(MAX_SESSION_TITLE_CODE_POINTS - 2)}😀…`);
  assert.doesNotMatch(title, /[\uD800-\uDFFF](?![\uDC00-\uDFFF])/u);
});

test("legacy oversized persisted titles stay readable and repair on the next write", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-legacy-session-title-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const legacyTitle = `${"😀".repeat(MAX_SESSION_TITLE_CODE_POINTS)}tail`;
  const target = path.join(directory, "live-smith-sessions.json");
  const record = {
    id: "session-legacy-title",
    title: legacyTitle,
    projectKey: "project-1",
    scope: { kind: "track", identity: "track-1", label: "Lead" },
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
  await fs.writeFile(target, JSON.stringify([record]));

  const [loaded] = await listSessions(directory);
  assert.equal(loaded?.title, "😀".repeat(MAX_SESSION_TITLE_CODE_POINTS));
  assert.equal(
    (JSON.parse(await fs.readFile(target, "utf8")) as typeof record[])[0]?.title,
    legacyTitle,
  );

  await updateSession(directory, record.id, { approvalMode: "manual" });
  assert.equal(
    (JSON.parse(await fs.readFile(target, "utf8")) as typeof record[])[0]?.title,
    "😀".repeat(MAX_SESSION_TITLE_CODE_POINTS),
  );
});
