import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { URL } from "node:url";
import test from "node:test";
import { createAgentRuntime } from "../../../src/app/agent-flow.js";
import { appendSessionEvent } from "../../../src/storage/events.js";
import { createDialogHarness, stateFixture } from "../support/chat-dialog.test-harness.js";

test("actual new-session responses display localized status and follow language changes", async () => {
  const storage = await fs.mkdtemp(path.join(tmpdir(), "live-smith-session-status-"));
  const runtime = await createAgentRuntime({ application: { song: { handle: { id: 1n }, tracks: [], scenes: [] } }, environment: { storageDirectory: storage } } as never,
    { summary: "Track: Delete", presentation: { origin: "object", objectKind: "track", title: "Delete", details: [] }, scope: { kind: "track", identity: "track-one", label: "Delete" }, target: {} },
    { renderHtml: () => "<html></html>" });
  try {
    const initial = new URL(runtime.url); initial.pathname = "/state";
    assert.equal((await fetch(initial)).status, 200);
    for (const [index, chinese, english] of [[0, "空白会话已就绪。", "Empty session ready."], [1, "已创建新会话。", "New session created."]] as const) {
      const endpoint = new URL(runtime.url); endpoint.pathname = "/command";
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json", "X-Live-Smith-Command-Id": `locale-session-${index}` }, body: JSON.stringify({ kind: "new_session" }) });
      assert.equal(response.status, 200);
      const result = await response.json();
      const state = stateFixture(); state.settings.uiLanguage = "zh-CN"; state.status = result.status;
      const h = await createDialogHarness(state);
      try {
        assert.equal(h.document.querySelector("#status")!.textContent, chinese);
        h.emitServerEvent({ type: "global_settings_changed", commandId: "peer-language", uiLanguage: "en", uiLanguageRevision: "1",
          defaultFollowUpBehavior: state.settings.defaultFollowUpBehavior, defaultFollowUpBehaviorRevision: state.settings.defaultFollowUpBehaviorRevision,
          showContextUsage: state.settings.showContextUsage, contextUsageVisibilityRevision: state.settings.contextUsageVisibilityRevision });
        await h.settle();
        assert.equal(h.document.querySelector("#status")!.textContent, english);
        assert.deepEqual(h.errors, []);
      } finally { h.close(); }
      await appendSessionEvent(storage, result.activeSessionId, { kind: "user", content: "Retain this Session" });
    }
  } finally { await runtime.close(); await fs.rm(storage, { recursive: true, force: true }); }
});
