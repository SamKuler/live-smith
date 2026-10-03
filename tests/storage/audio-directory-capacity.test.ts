import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";

import type { AudioAsset } from "../../src/audio-services/contracts.js";
import { AUDIO_STEM_ROLES } from "../../src/audio-services/audio-output.js";
import { readAudioAsset, readAudioSessionState } from "../../src/storage/audio-assets.js";
import {
  AudioStorageError, audioAssetId, createAudioJob, listAudioJobs, updateAudioJob,
} from "../../src/storage/audio-jobs.js";
import {
  audioStorageHarness, fingerprint, overwriteJson, waveBytes,
} from "./support/audio-storage-test-helpers.js";

test("completed Suno stem history stays available beyond 1024 files", async (t) => {
  const input = {
    provider: "suno", serviceId: "suno-stems", operation: "extract_music_stems",
    connectionFingerprint: fingerprint, stems: [],
  } as const;
  const h = await audioStorageHarness(t, { ...input, stems: [] });
  const bytes = waveBytes(0.01);
  const template = await h.save(AUDIO_STEM_ROLES[0], bytes);
  const expectedAssets: AudioAsset[] = [];

  for (let jobIndex = 0; jobIndex < 21; jobIndex++) {
    const job = jobIndex === 0 ? h.job : await createAudioJob(h.storage, h.session.id, { ...input, stems: [] });
    const expectedOutputs = AUDIO_STEM_ROLES.map((role, outputIndex) => ({
      key: `00000000-0000-4000-8000-${(jobIndex * AUDIO_STEM_ROLES.length + outputIndex + 1).toString().padStart(12, "0")}`,
      role,
    }));
    const outputAssets = expectedOutputs.map(({ role }) => ({
      ...template, id: audioAssetId(job.id, role), jobId: job.id, role,
      version: { groupId: audioAssetId(job.id, role), number: 1 },
    }));
    // Seed complete immutable files from a validated audio snapshot, then admit
    // every manifest and asset through the ordinary job storage boundary.
    for (const asset of outputAssets) {
      await overwriteJson(path.join(h.directory, `${asset.id}.asset.json`), asset);
      await fs.writeFile(path.join(h.directory, `${asset.id}.audio`), bytes, { mode: 0o600 });
    }
    await updateAudioJob(h.storage, h.session.id, job.id, {
      remoteTaskId: expectedOutputs[0]!.key, expectedOutputs,
      remoteOutputs: expectedOutputs, outputAssets, status: "completed",
    });
    expectedAssets.push(...outputAssets);
  }

  const jobs = await listAudioJobs(h.storage, h.session.id);
  assert.equal(jobs.length, 21);
  assert.ok(jobs.every((job) => job.status === "completed" && job.outputAssets.length === 24));
  const state = await readAudioSessionState(h.storage, h.session.id);
  assert.deepEqual(state.jobs, jobs);
  assert.deepEqual(state.assets, [...expectedAssets].sort((a, b) => a.id.localeCompare(b.id)));
  for (const asset of [expectedAssets[0]!, expectedAssets.at(-1)!]) {
    assert.deepEqual(await readAudioAsset(h.storage, h.session.id, asset.id), { asset, bytes });
  }
});

test("an excessive audio directory remains unavailable before metadata is admitted", async (t) => {
  const h = await audioStorageHarness(t);
  for (let offset = 0; offset < 5000; offset += 100) {
    await Promise.all(Array.from({ length: 100 }, (_, index) =>
      fs.writeFile(path.join(h.directory, `.audiojob_interrupted.tmp_${offset + index}`), "")
    ));
  }
  await assert.rejects(listAudioJobs(h.storage, h.session.id), AudioStorageError);
  await assert.rejects(readAudioSessionState(h.storage, h.session.id), AudioStorageError);
});
