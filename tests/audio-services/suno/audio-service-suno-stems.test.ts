import assert from "node:assert/strict";
import test from "node:test";
import { C, clip, downloadPath, model, replay, signal } from "./support/audio-service-suno-harness.js";
import { stemClips, stemIds, stemManifest, stemPreparation } from "./support/audio-service-suno-stems-harness.js";
import { waveBytes } from "../../storage/support/audio-storage-test-helpers.js";

const request = { operation: "extract_music_stems" as const, clipId: C };
const submitPath = "/api/generate/v2-web/";

test("Suno stems use the native fixed model and actual instrument metadata, preserving silent stems and failed siblings", async () => {
  const originals = stemClips();
  const ordered = [...originals].reverse();
  const polled = originals.map((entry, index) => index === 4 ? { ...entry, status: "error" } : entry);
  const h = replay([...stemPreparation(), { path: submitPath, value: { id: "request-id", clips: ordered } },
    { path: `/api/feed/?ids=${stemIds.slice(0, 12).join(",")}`, value: polled },
  ], "unrelated-saved-model");
  const controller = signal();
  await h.adapter.prepare!(request, controller);
  const receipt = await h.adapter.submit(request, controller);
  assert.equal(receipt.kind, "task");
  if (receipt.kind !== "task") return;
  assert.deepEqual(receipt.expectedOutputs, stemManifest());
  const body = h.api().find((entry) => entry.path === submitPath)!.body as Record<string, unknown>;
  assert.deepEqual([body.task, body.mv, body.continue_clip_id, body.stem_type_id, body.stem_type_group_name, body.stem_task],
    ["gen_stem", "chirp-v3-5-b", C, 91, "Twelve", "twelve"]);
  assert.equal(body.make_instrumental, true);
  const result = await h.adapter.inspect!(receipt.taskId, signal(), receipt.expectedOutputs);
  assert.equal(result.status, "completed");
  if (result.status !== "completed") return;
  assert.equal(result.outputs.length, 11);
  assert.deepEqual(result.failedOutputKeys, [stemIds[4]]);
  assert.ok(result.outputs.some((entry) => entry.role === "suno_stem_fx"), "a silent stem is still a real returned output");
  assert.equal(h.api().filter((entry) => entry.path === submitPath).length, 1);
  h.done();
});

test("two returned stem banks keep all 24 identities and roles when Stop races the receipt", async () => {
  const controller = new AbortController();
  const h = replay([...stemPreparation(), { path: submitPath, run: async () => {
    controller.abort(); return Response.json({ clips: stemClips(24) });
  } }]);
  await h.adapter.prepare!(request, controller.signal);
  const result = await h.adapter.submit(request, controller.signal);
  assert.equal(result.kind, "task");
  if (result.kind !== "task") return;
  assert.deepEqual(result.expectedOutputs, stemManifest(24));
  assert.equal(result.expectedOutputs![16]!.role, "suno_stem_guitar_alternative");
  assert.equal(h.api().filter((entry) => entry.path === submitPath).length, 1);
});

test("stem entitlement, special-model denial and source actions reject before paid dispatch", async () => {
  for (const options of [
    { features: [] },
    { models: [model({ external_key: "chirp-v3-5-b", can_use: false })] },
    { source: { user_id: "someone-else" } },
    { source: { action_config: { actions: [{ action_type: "get_stems", disabled: true }] } } },
  ]) {
    const h = replay(stemPreparation(options));
    await assert.rejects(h.adapter.prepare!(request, signal()));
    assert.equal(h.api().some((entry) => entry.path === submitPath), false);
  }
  const h = replay(stemPreparation({ features: [], account: { roles: { staff: true } } }));
  await h.adapter.prepare!(request, signal());
  h.done();
});

for (const index of [0, 12]) test(`selected stem from bank ${index / 12 + 1} authorizes its fresh root and downloads only its own clip`, async () => {
  const selected = stemClips(24)[index]!;
  const output = stemManifest(24)[index]!;
  const url = `https://cdn1.suno.ai/${output.key}.mp3`;
  const h = replay([
    { path: `/api/feed/?ids=${output.key}`, value: [selected] },
    { path: `/api/feed/?ids=${C}`, value: [clip(C, "complete", { is_download_unlocked: false })] },
    { path: "/api/download/authorize", value: { ok: true } },
    { path: `/api/feed/?ids=${C}`, value: [clip(C, "complete", { is_download_unlocked: true })] },
    { path: downloadPath(output.key), value: { ok: true, status: "ready", download_url: url } },
    { path: url, response: new Response(waveBytes().slice().buffer, { headers: { "Content-Type": "audio/wav" } }) },
  ], undefined, { authorizeDownloads: true });
  let guarded = 0;
  const bytes = await h.adapter.downloadSelected!(output, signal(), async (_signal, operation) => { guarded++; return operation(); });
  assert.deepEqual(new Uint8Array(bytes), waveBytes());
  assert.equal(guarded, 1);
  assert.deepEqual(h.api().find((entry) => entry.path === "/api/download/authorize")!.body, { item_id: C, item_type: "clip" });
  assert.equal(h.api().filter((entry) => entry.path.startsWith("/api/download/clip/")).length, 1);
  h.done();
});

test("a stem whose instrument or lineage changed cannot spend download allowance", async () => {
  for (const metadata of [
    { type: "stem", stem_type_group_name: "Guitar", stem_from_id: C },
    { type: "stem", stem_type_group_name: "Vocals" },
  ]) {
    const h = replay([{ path: `/api/feed/?ids=${stemIds[0]}`, value: [clip(stemIds[0], "complete", { metadata })] }], undefined, { authorizeDownloads: true });
    await assert.rejects(h.adapter.downloadSelected!(stemManifest()[0]!, signal(), async (_signal, operation) => operation()));
    assert.equal(h.api().some((entry) => entry.path === "/api/download/authorize"), false);
  }
});

test("malformed or lost stem submissions never replay paid work", async () => {
  for (const body of [
    { clips: [stemClips()[0], { ...stemClips()[0], id: stemIds[1] }] },
    { clips: [{ id: stemIds[0], metadata: {} }] },
    { clips: Array.from({ length: 25 }, () => stemClips()[0]) },
  ]) {
    const h = replay([...stemPreparation(), { path: submitPath, value: body }]);
    const abort = signal();
    await h.adapter.prepare!(request, abort);
    await assert.rejects(h.adapter.submit(request, abort));
    assert.equal(h.api().filter((entry) => entry.path === submitPath).length, 1);
    h.done();
  }
  const h = replay([...stemPreparation(), { path: submitPath, run: async () => { throw new Error("Lost paid receipt"); } }]);
  const abort = signal();
  await h.adapter.prepare!(request, abort);
  await assert.rejects(h.adapter.submit(request, abort));
  assert.equal(h.api().filter((entry) => entry.path === submitPath).length, 1);
});
