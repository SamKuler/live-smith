import assert from "node:assert/strict";
import test from "node:test";
import { createHostAbortController } from "../../src/runtime/host.js";
import { A, B, C, accountId, clip, replay, signal, type Step } from "./support/audio-service-suno-harness.js";

const request = { operation: "get_whole_song" as const, clipId: C };
const concat = "/api/generate/concat/v2/";
const source = (extra: Record<string, unknown> = {}): Step[] => [
  { path: "/api/session/", value: { user: { clerk_id: accountId, id: "owner" } } },
  { path: `/api/feed/?ids=${C}`, value: [clip(C, "complete", { user_id: "owner", metadata: { task: "extend" }, ...extra })] },
];

test("whole-song source ownership, status, action and extension lineage are checked before direct concat", async () => {
  for (const extra of [
    { user_id: "other-owner" }, { is_trashed: true }, { status: "streaming" },
    { metadata: { task: "generate" } }, { metadata: { task: "infill" } },
    { action_config: { actions: [{ action_type: "get_full_song", disabled: true }] } },
    { action_config: { actions: [{ action_type: "get_full_song", visible: false }] } },
  ]) {
    const h = replay(source(extra));
    await assert.rejects(h.adapter.prepare!(request, signal()));
    assert.deepEqual(h.api().map((entry) => entry.path), ["/api/session/", `/api/feed/?ids=${C}`]);
  }
  const h = replay([...source({ metadata: { task: "artist_extend", edit_session_id: B } }), { path: concat, value: clip(A, "submitted") }]);
  const abort = signal();
  await h.adapter.prepare!(request, abort);
  await h.adapter.submit(request, abort);
  assert.deepEqual(h.api().at(-1)!.body, { clip_id: C, is_infill: false, edit_session_id: B });
  h.done();
});

test("direct concat retains its confirmed single output when Stop races the response", async () => {
  const controller = createHostAbortController();
  let dispatches = 0;
  const h = replay([...source(), { path: concat, run: async () => { controller.abort(); return Response.json(clip(A, "submitted")); } }], undefined, {
    authorizeSubmission: async (_signal, operation) => { dispatches++; return operation(); },
  });
  await h.adapter.prepare!(request, controller.signal);
  const result = await h.adapter.submit(request, controller.signal);
  assert.deepEqual(result, { kind: "task", taskId: A, expectedOutputs: [{ key: A, role: "music" }] });
  assert.equal(dispatches, 1);
  assert.equal(h.api().some((entry) => entry.path === "/api/c/check"), false);
});

test("direct concat transport loss never replays submission or invokes a verifier", async () => {
  let verifications = 0;
  const h = replay([...source(), { path: concat, run: async () => { throw new Error("Lost concat reply"); } }], undefined, {
    verifyHuman: async () => { verifications++; throw new Error("Unexpected verification"); },
  });
  const abort = signal();
  await h.adapter.prepare!(request, abort);
  await assert.rejects(h.adapter.submit(request, abort));
  await assert.rejects(h.adapter.submit(request, abort));
  assert.equal(h.api().filter((entry) => entry.path === concat).length, 1);
  assert.equal(verifications, 0);
});
