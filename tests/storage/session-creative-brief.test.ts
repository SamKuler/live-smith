import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createSession, listSessions, updateSession, SessionStorageCorruptionError } from "../../src/storage/sessions.js";
import { MAX_CREATIVE_BRIEF_CODE_POINTS } from "../../src/agent/creative-brief.js";
import { isReusableEmptySessionMetadata, sessionSummaries } from "../../src/app/context/session-context.js";

const input = { title: "", projectKey: "set", scope: { kind: "track" as const, identity: "track", label: "Bass" } };

test("briefs are additive, private, Session scoped, bounded, and count as retained Session content", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-brief-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const first = await createSession(directory, input, { transient: true });
  const other = await createSession(directory, input, { transient: true });
  assert.equal(first.creativeBrief, undefined);
  assert.equal(isReusableEmptySessionMetadata(first, "set", input.scope), true);
  const brief = "🎵".repeat(MAX_CREATIVE_BRIEF_CODE_POINTS);
  await updateSession(directory, first.id, { creativeBrief: brief });
  const sessions = await listSessions(directory);
  const updated = sessions.find((entry) => entry.id === first.id)!;
  assert.equal(updated.creativeBrief, brief);
  assert.equal((await sessionSummaries(directory, [updated]))[0]?.hasContent, true);
  assert.equal(sessions.find((entry) => entry.id === other.id)?.creativeBrief, undefined);
  assert.equal(isReusableEmptySessionMetadata(updated, "set", input.scope), false);
  const file = path.join(directory, "live-smith-sessions.json");
  const data = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(data.length, 1);
  assert.equal(data[0].creativeBrief, brief);
  if (process.platform !== "win32") assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  await assert.rejects(updateSession(directory, first.id, { creativeBrief: brief + "a" }));
  assert.equal((await listSessions(directory)).find((entry) => entry.id === first.id)?.creativeBrief, brief);
  await updateSession(directory, first.id, { creativeBrief: "" });
  assert.equal((await listSessions(directory)).find((entry) => entry.id === first.id)?.creativeBrief, "");
  data[0].creativeBrief = 42;
  await fs.writeFile(file, JSON.stringify(data));
  await assert.rejects(listSessions(directory), SessionStorageCorruptionError);
});
