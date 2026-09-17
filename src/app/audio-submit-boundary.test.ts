import { formatUiMessage } from "../i18n/ui-message.js";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import test from "node:test";
import { updateAudioJob } from "../storage/audio-jobs.js";
import { resumeAudioJob, separateAudioStems } from "./audio-processing.js";
import { audioRecoveryHarness } from "./audio-recovery-test-helpers.js";

test("a connection replacement during generation preparation does not submit or record an unknown paid outcome", async (t) => {
  const h = await audioRecoveryHarness(t, "elevenlabs");
  h.context.onProgress = async () => { await h.change({ apiKey: "synthetic-replacement" }); };
  const job = await h.run();
  assert.equal(job.status, "failed");
  assert.deepEqual(h.calls, []);
  assert.doesNotMatch(formatUiMessage(job.message!), /synthetic-/);
});

test("a connection replacement during stem source preparation cannot upload the source", async (t) => {
  const h = await audioRecoveryHarness(t, "lalal");
  const job = await separateAudioStems(h.context, h.connection.id, ["vocals"], async () => {
    await h.change({ apiKey: "synthetic-replacement" });
    return h.source();
  });
  assert.equal(job.status, "failed");
  assert.deepEqual(h.calls, []);
});

test("a connection replacement after upload cannot submit a paid separation or claim an unknown outcome", async (t) => {
  const h = await audioRecoveryHarness(t, "lalal");
  const upload = h.adapter.upload;
  h.adapter.upload = async (...args) => {
    const id = await upload(...args);
    await h.change({ apiKey: "synthetic-replacement" });
    return id;
  };
  const job = await h.run();
  assert.equal(job.status, "failed");
  assert.deepEqual(h.calls, ["upload"]);
});

for (const provider of ["lalal", "sunoapi"] as const) {
  test(`${provider} still rejects remote recovery under a replacement credential after partial local recovery`, async (t) => {
    const h = await audioRecoveryHarness(t, provider);
    h.mode.invalidFirst = true;
    const first = await h.run();
    assert.equal(first.status, "partial");
    await updateAudioJob(h.storage, h.session.id, first.id, { outputAssets: [] });
    await h.change({ apiKey: "synthetic-replacement" });
    const before = h.calls.length;
    await assert.rejects(resumeAudioJob(h.context, first.id), /different service connection/);
    assert.equal(h.calls.length, before);
  });

  test(`${provider} does not treat a systemic file-write failure as a skippable bad output`, async (t) => {
    const h = await audioRecoveryHarness(t, provider);
    const probe = await fs.open(h.storage);
    const prototype = Object.getPrototypeOf(probe) as fs.FileHandle;
    const original = prototype.writeFile;
    await probe.close();
    const adapter = provider === "lalal" ? h.adapter : h.generationAdapter;
    const inspect = adapter.inspect!;
    // Introduce the storage outage only after input upload and paid submission.
    adapter.inspect = (async (...args: unknown[]) => {
      const result = await (inspect as (...args: unknown[]) => Promise<unknown>)(...args);
      t.mock.method(prototype, "writeFile", async function (this: fs.FileHandle, ...values: Parameters<fs.FileHandle["writeFile"]>) {
        if (values[0] instanceof Uint8Array) throw new Error("disk unavailable");
        return original.apply(this, values);
      });
      return result;
    }) as NonNullable<typeof adapter.inspect>;
    const job = await h.run();
    assert.equal(job.status, "interrupted");
    assert.equal(h.calls.filter((call) => call.startsWith("download:")).length, 1);
    assert.equal(job.outputAssets.length, 0);
  });
}

test("local recovery verifies bytes before completing even when the remote connection was removed", async (t) => {
  const h = await audioRecoveryHarness(t, "elevenlabs");
  const first = await h.run();
  await updateAudioJob(h.storage, h.session.id, first.id, { status: "collecting", outputAssets: [] });
  const asset = first.outputAssets[0]!;
  await fs.writeFile(`${h.storage}/live-smith-audio/${h.session.id}/${asset.id}.audio`, new Uint8Array(asset.byteLength));
  await h.change("remove");
  await assert.rejects(resumeAudioJob(h.context, first.id), /invalid|changed/);
  assert.equal(h.calls.filter((call) => call === "submit").length, 1);
});
