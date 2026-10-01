import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";

import { AgentPlanExecutionError } from "../../src/live/executor.js";
import { addAudioAssetSampleSources } from "../../src/app/audio-asset-sources.js";
import { assetHarness, sourceBindings } from "./support/audio-asset-sources-test-helpers.js";
import { mergeRequestAudioImportProgress, prepareRequestAudioSampleSources } from "../../src/app/request-audio-sources.js";

test("asset staging respects the final import boundary and cancellation before the SDK call", async (t) => {
  const h = await assetHarness(t);
  const asset = await h.save();
  await addAudioAssetSampleSources(h.input, h.sources, [asset]);
  const bindings = sourceBindings(...h.sources.values());
  const filesBefore = await fs.readdir(h.directory);
  await assert.rejects(prepareRequestAudioSampleSources(bindings, h.controller.signal, () => {
    throw new Error("Edit Scope changed");
  }), /Edit Scope changed/);
  assert.deepEqual(await fs.readdir(h.directory), filesBefore);
  assert.equal(h.staged.length, 0);
  await assert.rejects(prepareRequestAudioSampleSources(bindings, h.controller.signal, () => {
    h.controller.abort(new Error("Stopped"));
  }), /Stopped/);
  assert.equal(h.staged.length, 0);
  assert.deepEqual(await fs.readdir(h.directory), filesBefore);
});

test("Stop after asset import retains its managed copy and partial key without starting the next source", async (t) => {
  const h = await assetHarness(t);
  const assets = [await h.save(), await h.save("drums")];
  await addAudioAssetSampleSources(h.input, h.sources, assets);
  const importIntoProject = h.host.resources.importIntoProject;
  h.host.resources.importIntoProject = async (filePath) => {
    const result = await importIntoProject(filePath);
    h.controller.abort(new Error("Stopped after import"));
    return result;
  };
  await assert.rejects(prepareRequestAudioSampleSources(sourceBindings(...h.sources.values()), h.controller.signal), (error: unknown) => {
    assert.ok(error instanceof AgentPlanExecutionError);
    assert.equal(error.completedMutationCount, 1);
    assert.equal(error.completedActionCount, 0);
    assert.deepEqual(error.completedActionKeys, [[`live-action-step:audio-asset-import:${assets[0]!.id}`]]);
    assert.match(error.message, /Stopped after import/);
    assert.doesNotMatch(error.message, /\/Live Project|live-smith-asset-import|untrusted/);
    return true;
  });
  assert.equal(h.staged.length, 1);
  assert.equal(h.sources.get(assets[0]!.id)!.filePath, "/Live Project/Samples/1.wav");
  assert.throws(() => h.sources.get(assets[1]!.id)!.filePath, /not prepared/);
  await assert.rejects(fs.stat(path.dirname(h.staged[0]!.filePath)), { code: "ENOENT" });
});

test("a later failed asset import keeps earlier progress and keys and sanitizes host paths", async (t) => {
  const h = await assetHarness(t);
  const assets = [await h.save(), await h.save("drums")];
  await addAudioAssetSampleSources(h.input, h.sources, assets);
  const importIntoProject = h.host.resources.importIntoProject;
  let calls = 0;
  let failedStagingPath = "";
  h.host.resources.importIntoProject = async (filePath) => {
    calls += 1;
    if (calls === 2) {
      failedStagingPath = filePath;
      throw new Error(`Import ${filePath} to /project/secret.wav failed`);
    }
    return importIntoProject(filePath);
  };
  const bindings = sourceBindings(...h.sources.values());
  await assert.rejects(prepareRequestAudioSampleSources(bindings, h.controller.signal), (error: unknown) => {
    assert.ok(error instanceof AgentPlanExecutionError);
    assert.equal(error.completedMutationCount, 1);
    assert.equal(error.completedActionCount, 0);
    assert.deepEqual(error.completedActionKeys, [[`live-action-step:audio-asset-import:${assets[0]!.id}`]]);
    assert.match(error.message, /could not import the audio asset/);
    assert.doesNotMatch(error.message, /secret|\/project|live-smith-asset-import|untrusted/);
    return true;
  });
  await assert.rejects(fs.stat(path.dirname(failedStagingPath)), { code: "ENOENT" });
  const retried = await prepareRequestAudioSampleSources(bindings, h.controller.signal);
  assert.deepEqual(retried.keys, [`live-action-step:audio-asset-import:${assets[1]!.id}`]);
  assert.equal(h.staged.length, 2);
  assert.equal(calls, 3);
});

test("post-import drift failure retains asset preparation keys without completing a Live action", async (t) => {
  const h = await assetHarness(t);
  const asset = await h.save();
  await addAudioAssetSampleSources(h.input, h.sources, [asset]);
  const progress = await prepareRequestAudioSampleSources(sourceBindings(...h.sources.values()), h.controller.signal);
  const merged = mergeRequestAudioImportProgress(progress, new Error("Live target changed after import"));
  assert.ok(merged instanceof AgentPlanExecutionError);
  assert.equal(merged.completedActionCount, 0);
  assert.equal(merged.completedMutationCount, 1);
  assert.deepEqual(merged.completedActionKeys, [progress.keys]);
});

test("asset byte tampering after binding is rejected before a project import", async (t) => {
  const h = await assetHarness(t);
  const asset = await h.save();
  await addAudioAssetSampleSources(h.input, h.sources, [asset]);
  const blobPath = path.join(h.directory, "live-smith-audio", h.session.id, `${asset.id}.audio`);
  const bytes = await fs.readFile(blobPath);
  bytes[bytes.length - 1] = 127;
  await fs.writeFile(blobPath, bytes);
  await assert.rejects(prepareRequestAudioSampleSources(sourceBindings(...h.sources.values()), h.controller.signal));
  assert.equal(h.staged.length, 0);
});
