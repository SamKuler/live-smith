import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { URL } from "node:url";

import { runAgentFlow } from "../../../src/app/agent-flow.js";
import type { LiveInteractionContext } from "../../../src/live/context.js";
import { listInstalledSkills } from "../../../src/storage/skills.js";
import type { ChatDialogState } from "../../../src/ui/chat-state.js";
import { liveContextPresentationFixture } from "../context/support/live-context.test-harness.js";

test("User Skill bridge preserves replacement receipts and prevents deletion while selected", async (t) => {
  const storageDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-user-skills-"));
  t.after(() => fs.rm(storageDirectory, { recursive: true, force: true }));
  const interaction: LiveInteractionContext = {
    presentation: liveContextPresentationFixture("Lead"),
    summary: "Track: Lead",
    target: {},
    scope: { kind: "track", identity: "track-1", label: "Lead" },
  };
  let commandSequence = 0;

  await runAgentFlow({
    application: { song: { handle: { id: 1n } } },
    environment: { storageDirectory },
    ui: {
      showModalDialog: async (url: string) => {
        const endpoint = new URL(url);
        const request = (pathname: string, init: RequestInit = {}) => {
          const target = new URL(endpoint);
          target.pathname = pathname;
          return fetch(target, {
            ...init,
            headers: {
              "X-Live-Smith-Command-Id": `user-skill-command-${++commandSequence}`,
              ...init.headers,
            },
          });
        };
        const markdown = (body: string) => Buffer.from(
          `---\nname: mix-review\ndescription: Review the mix\n---\n${body}\n`,
        );
        const firstBytes = markdown("Keep the low end clear.");
        const nextBytes = markdown("Check the low end and the vocal balance.");
        const install = (bytes: Buffer, replace = false) => {
          const target = new URL(endpoint);
          target.pathname = "/skills";
          target.searchParams.set("replace", String(replace));
          return fetch(target, {
            method: "POST",
            headers: {
              "Content-Type": "text/markdown; charset=utf-8",
              "X-Live-Smith-Command-Id": `user-skill-upload-${++commandSequence}`,
            },
            body: Uint8Array.from(bytes).buffer,
          });
        };
        const readInstalled = async (response: Response) => {
          assert.equal(response.status, 201, await response.clone().text());
          return response.json() as Promise<{
            state: ChatDialogState;
            receipt: { id: string; sha256: string };
          }>;
        };
        const first = await readInstalled(await install(firstBytes));
        assert.deepEqual(first.receipt, {
          id: "mix-review",
          sha256: createHash("sha256").update(firstBytes).digest("hex"),
        });
        assert.ok(first.state.availableSkills.some((skill) => skill.id === first.receipt.id));
        const repeated = await readInstalled(await install(firstBytes));
        assert.deepEqual(repeated.receipt, first.receipt);
        assert.equal((await listInstalledSkills(storageDirectory)).length, 1);

        const rejectedReplacement = await install(nextBytes);
        assert.equal(rejectedReplacement.status, 409);
        await rejectedReplacement.text();
        assert.equal((await listInstalledSkills(storageDirectory))[0]?.sha256, first.receipt.sha256);
        const replacement = await readInstalled(await install(nextBytes, true));
        assert.equal(replacement.receipt.sha256, createHash("sha256").update(nextBytes).digest("hex"));

        const selectSkills = async (skillIds: string[]) => {
          const response = await request("/command", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              kind: "set_session_skills",
              sessionId: first.state.activeSessionId,
              skillIds,
            }),
          });
          assert.equal(response.status, 200, await response.clone().text());
          const state = await response.json() as ChatDialogState;
          assert.deepEqual(state.activeSkillIds, skillIds);
        };
        await selectSkills(["mix-review"]);
        const selectedDeletion = await request("/skills/mix-review", { method: "DELETE" });
        assert.equal(selectedDeletion.status, 409);
        await selectedDeletion.text();
        assert.equal((await listInstalledSkills(storageDirectory))[0]?.sha256, replacement.receipt.sha256);

        const keepSkill = first.state.availableSkills.find((skill) => skill.source === "built-in")!;
        assert.ok(keepSkill);
        await selectSkills(["mix-review", keepSkill.id].sort());
        const removal = { kind: "remove_session_skill", sessionId: first.state.activeSessionId, skillId: "mix-review" };
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const removed = await request("/command", {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(removal),
          });
          assert.equal(removed.status, 200, await removed.clone().text());
          assert.deepEqual((await removed.json() as ChatDialogState).activeSkillIds, [keepSkill.id]);
        }

        const deleted = await request("/skills/mix-review", { method: "DELETE" });
        assert.equal(deleted.status, 200, await deleted.clone().text());
        const deletedState = await deleted.json() as ChatDialogState;
        assert.equal(deletedState.availableSkills.some((skill) => skill.id === "mix-review"), false);
        assert.deepEqual(await listInstalledSkills(storageDirectory), []);
        const absentDeletion = await request("/skills/mix-review", { method: "DELETE" });
        assert.equal(absentDeletion.status, 200);
        await absentDeletion.text();
      },
    },
  } as never, interaction, { renderHtml: () => "<html></html>" });
});
