import { formatUiMessage } from "../i18n/ui-message.js";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import test from "node:test";
import { listAudioJobs, updateAudioJob } from "../storage/audio-jobs.js";
import { audioJobViews, resumeAudioJob, separateAudioStems } from "./audio-processing.js";
import { audioRecoveryHarness } from "./audio-recovery-test-helpers.js";
import { SessionMutationFence } from "./session-mutation-fence.js";

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

for (const provider of ["elevenlabs", "lalal"] as const) {
  test(`${provider} remains pre-submit while waiting for the settings fence`, async (t) => {
    const h = await audioRecoveryHarness(t, provider);
    const fence = new SessionMutationFence();
    const occupied = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const blocker = fence.run("settings", async () => {
      occupied.resolve();
      await release.promise;
    });
    await occupied.promise;
    const queued = Promise.withResolvers<void>();
    const controller = new AbortController();
    h.context.signal = controller.signal;
    h.context.withGenerationAuthorization = (signal, operation) => {
      queued.resolve();
      return fence.run("settings", signal, operation);
    };
    const pending = h.run();
    await queued.promise;
    const [stored] = await listAudioJobs(h.storage, h.session.id);
    controller.abort(new Error("Stopped before paid submission"));
    release.resolve();
    const [outcome] = await Promise.allSettled([pending, blocker]);
    assert.equal(stored?.status, "preparing", "an abandoned queued job must not recover as an unknown paid request");
    assert.equal(outcome.status, "rejected");
    assert.equal((await audioJobViews(h.storage, h.session.id))[0]?.status, "interrupted");
    assert.equal(h.calls.filter((call) => call === "submit").length, 0);
  });

  test(`${provider} holds the settings lifecycle through a paid submission`, async (t) => {
    const h = await audioRecoveryHarness(t, provider);
    const fence = new SessionMutationFence();
    h.context.withGenerationAuthorization = (signal, operation) => fence.run("settings", signal, operation);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    if (provider === "lalal") {
      const submit = h.adapter.submit;
      h.adapter.submit = async (...args) => {
        entered.resolve();
        await release.promise;
        return submit(...args);
      };
    } else {
      const submit = h.generationAdapter.submit;
      h.generationAdapter.submit = async (...args) => {
        entered.resolve();
        await release.promise;
        return submit(...args);
      };
    }
    const pending = h.run();
    let mutationStarted = false;
    await entered.promise;
    const change = fence.run("settings", async () => {
      mutationStarted = true;
      await h.change({ apiKey: "synthetic-replacement" });
    });
    await Promise.resolve();
    const startedBeforeReceipt = mutationStarted;
    release.resolve();
    const job = await pending;
    await change;
    assert.equal(startedBeforeReceipt, false, "the settings write must wait for the paid receipt");
    assert.equal(job.status, "completed");
    assert.equal(mutationStarted, true);
    assert.equal(h.calls.filter((call) => call === "submit").length, 1);
  });

  test(`${provider} rechecks the admitted connection after acquiring submission authorization`, async (t) => {
    const h = await audioRecoveryHarness(t, provider);
    let authorizations = 0;
    h.context.withGenerationAuthorization = async (_signal, operation) => {
      authorizations += 1;
      await h.change({ apiKey: "synthetic-replacement" });
      return operation();
    };
    const job = await h.run();
    assert.equal(authorizations, 1);
    assert.equal(job.status, "failed");
    assert.deepEqual(h.calls, provider === "lalal" ? ["upload"] : []);
    assert.doesNotMatch(formatUiMessage(job.message!), /synthetic-/);
  });

  test(`${provider} keeps a lost paid submission outcome unknown under the settings fence`, async (t) => {
    const h = await audioRecoveryHarness(t, provider);
    const fence = new SessionMutationFence();
    h.context.withGenerationAuthorization = (signal, operation) => fence.run("settings", signal, operation);
    if (provider === "lalal") {
      h.adapter.submit = async () => { h.calls.push("submit"); throw new Error("fixture response lost"); };
    } else {
      h.generationAdapter.submit = async () => { h.calls.push("submit"); throw new Error("fixture response lost"); };
    }
    const job = await h.run();
    assert.equal(job.status, "unknown");
    assert.equal(h.calls.filter((call) => call === "submit").length, 1);
    assert.equal(fence.queuedOrActiveCount("settings"), 0);
  });
}

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
