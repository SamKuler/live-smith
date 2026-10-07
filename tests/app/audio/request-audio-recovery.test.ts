import assert from "node:assert/strict";
import test from "node:test";
import { updateAudioJob } from "../../../src/storage/audio-jobs.js";
import { audioRecoveryHarness } from "./support/audio-recovery-test-helpers.js";
import { createRequestAudioTools } from "../../../src/app/audio/request-audio-tools.js";

test("a verified audio-capable model can listen to an exact saved Session asset", async (t) => {
  const h = await audioRecoveryHarness(t, "elevenlabs");
  const generated = await h.run();
  const expected = generated.outputAssets[0]!;
  const checkedBytes: number[] = [];
  const tools = await createRequestAudioTools({ assertLiveSetCurrent: () => {}, ...{
    context: {} as never, storageDirectory: h.storage, sessionId: h.session.id,
    requestId: "request", attachmentRefs: [], target: {}, signal: h.context.signal,
    onProgress() {}, onAssets() {},
    modelAudioInput: { canAccept(byteLength) { checkedBytes.push(byteLength); return true; } },
  } });
  assert.ok(tools.tools.some((tool) => tool.function.name === "listen_to_audio_asset"));
  const result = await tools.execute({ id: "listen", name: "listen_to_audio_asset",
    arguments: JSON.stringify({ assetRef: expected.id }) });
  assert.equal(result.failed, undefined);
  assert.deepEqual(checkedBytes, [expected.byteLength]);
  assert.equal(result.modelInputPart?.type, "audio");
  assert.equal(result.modelInputPart?.mediaType, expected.mediaType);
  assert.ok(result.modelInputPart?.bytes.byteLength);
  assert.match(result.content, /complete audio asset.*untrusted audio input/i);

  const bounded = await createRequestAudioTools({ assertLiveSetCurrent: () => {}, ...{
    context: {} as never, storageDirectory: h.storage, sessionId: h.session.id,
    requestId: "request", attachmentRefs: [], target: {}, signal: h.context.signal,
    onProgress() {}, onAssets() {}, modelAudioInput: { canAccept: () => false },
  } });
  const rejected = await bounded.execute({ id: "listen", name: "listen_to_audio_asset",
    arguments: JSON.stringify({ assetRef: expected.id }) });
  assert.equal(rejected.failed, true);
  assert.equal(rejected.modelInputPart, undefined);
});

for (const provider of ["elevenlabs", "sunoapi", "lalal"] as const) {
  for (const change of ["disabled", "removed"] as const) {
    test(`chat can finish local ${provider} recovery with the connection ${change}`, async (t) => {
      const h = await audioRecoveryHarness(t, provider);
      const first = await h.run();
      await updateAudioJob(h.storage, h.session.id, first.id, { status: "collecting", outputAssets: [] });
      await h.change(change === "removed" ? "remove" : { enabled: false });
      const before = h.calls.length;
      const registered: string[] = [];
      const tools = await createRequestAudioTools({ assertLiveSetCurrent: () => {}, ...{
        context: {} as never, storageDirectory: h.storage, sessionId: h.session.id,
        requestId: "request", attachmentRefs: [], target: {}, signal: h.context.signal,
        onProgress() {}, onAssets(assets) { registered.push(...assets.map((asset) => asset.id)); },
        processing: { generationAdapter: h.generationAdapter, adapter: h.adapter },
      } });
      assert.deepEqual(tools.tools.map((tool) => tool.function.name), ["resume_audio_job", "list_audio_jobs"]);
      const listed = await tools.execute({ id: "list", name: "list_audio_jobs", arguments: "{}" });
      assert.equal(JSON.parse(listed.content)[0].resumable, true);
      const recovered = await tools.execute({ id: "resume", name: "resume_audio_job", arguments: JSON.stringify({ jobId: first.id }) });
      assert.equal(recovered.failed, undefined);
      assert.equal(JSON.parse(recovered.content).status, "completed");
      assert.ok(first.outputAssets.every((asset) => registered.includes(asset.id)));
      assert.equal(h.calls.length, before, "local recovery must not submit or poll any provider");
    });
  }
}

test("no connection and no saved jobs exposes no audio tools", async (t) => {
  const h = await audioRecoveryHarness(t, "elevenlabs");
  await h.change("remove");
  const tools = await createRequestAudioTools({ assertLiveSetCurrent: () => {}, ...{
    context: {} as never, storageDirectory: h.storage, sessionId: h.session.id,
    requestId: "request", attachmentRefs: [], target: {}, signal: h.context.signal,
    onProgress() {}, onAssets() {},
  } });
  assert.deepEqual(tools.tools, []);
});

for (const provider of ["sunoapi", "lalal"] as const) {
  test(`advertising local recovery does not bypass ${provider} remote connection authorization`, async (t) => {
    const h = await audioRecoveryHarness(t, provider);
    h.mode.invalidFirst = true;
    const first = await h.run();
    assert.equal(first.status, "partial");
    for (const change of [{ enabled: false }, "remove"] as const) {
      await h.change(change);
      const before = h.calls.length;
      const tools = await createRequestAudioTools({ assertLiveSetCurrent: () => {}, ...{
        context: {} as never, storageDirectory: h.storage, sessionId: h.session.id,
        requestId: "request", attachmentRefs: [], target: {}, signal: h.context.signal,
        onProgress() {}, onAssets() {}, processing: { generationAdapter: h.generationAdapter, adapter: h.adapter },
      } });
      assert.ok(tools.tools.some((tool) => tool.function.name === "resume_audio_job"));
      const result = await tools.execute({ id: "resume", name: "resume_audio_job", arguments: JSON.stringify({ jobId: first.id }) });
      assert.equal(result.failed, true);
      assert.equal(result.stop, true);
      assert.equal(h.calls.length, before, "missing files still require the original enabled connection");
    }
  });
}
