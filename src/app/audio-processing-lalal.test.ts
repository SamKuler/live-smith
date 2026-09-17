import { formatUiMessage } from "../i18n/ui-message.js";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";

import { MAX_AUDIO_ASSET_BYTES } from "../audio-services/contracts.js";
import { createLalalAudioAdapter } from "../audio-services/lalal.js";
import { readAudioAsset } from "../storage/audio-assets.js";
import { waveBytes } from "../storage/audio-storage-test-helpers.js";
import { resumeAudioJob, separateAudioStems } from "./audio-processing.js";
import { audioRecoveryHarness } from "./audio-recovery-test-helpers.js";

const SOURCE_ID = "e1fc1d8f-502e-4de0-bf3b-b30543d11c77";
const TASK_ID = "2fe8f214-1771-4900-9e7e-570f823bd359";

test("an oversized LALAL stem preserves valid siblings and resumes only the missing file", async (t) => {
  for (const size of [undefined, null, MAX_AUDIO_ASSET_BYTES + 1]) {
    const h = await audioRecoveryHarness(t, "lalal");
    const bytes = waveBytes();
    const requests: string[] = [];
    let oversized = true;
    h.context.adapter = createLalalAudioAdapter(h.connection.apiKey, { fetchImpl: async (input, init) => {
      const url = String(input);
      requests.push(`${init?.method} ${url}`);
      if (init?.method === "GET") {
        if (oversized && url.endsWith("/no_multistem")) {
          return new Response(null, { headers: { "Content-Length": String(MAX_AUDIO_ASSET_BYTES + 1) } });
        }
        return new Response(Buffer.from(bytes));
      }
      if (url.endsWith("/upload/")) return Response.json({ id: SOURCE_ID, name: "audio.wav",
        size: bytes.length, duration: 1, expires: 2_000_000_000 });
      if (url.endsWith("/split/multistem/")) return Response.json({ task_id: TASK_ID });
      assert.ok(url.endsWith("/check/"), "Unexpected provider request");
      return Response.json({ result: { [TASK_ID]: {
        status: "success", source_id: SOURCE_ID,
        presets: { task_type: "split", label: "multistem", stem_list: ["vocals", "drum"], encoder_format: "wav" },
        result: { duration: 1, tracks: [
          // Put the unavailable output first so siblings after it must still be collected.
          { type: "back", label: "no_multistem", size, url: `https://d.lalal.ai/${TASK_ID}/no_multistem` },
          { type: "stem", label: "vocals", size: bytes.length, url: `https://d.lalal.ai/${TASK_ID}/vocals` },
          { type: "stem", label: "drum", size: bytes.length, url: `https://d.lalal.ai/${TASK_ID}/drum` },
        ] },
      } } });
    } });
    const first = await separateAudioStems(h.context, h.connection.id, ["vocals", "drums"], h.source);
    assert.equal(first.status, "partial");
    assert.equal(first.remoteTaskId, TASK_ID);
    assert.deepEqual(first.outputAssets.map((asset) => asset.role), ["vocals", "drums"]);
    assert.match(formatUiMessage(first.message!), /residual.*byte limit/);
    for (const asset of first.outputAssets) {
      assert.deepEqual((await readAudioAsset(h.storage, h.session.id, asset.id)).bytes, new Uint8Array(bytes));
    }
    const beforeResume = requests.length;
    oversized = false;
    const resumed = await resumeAudioJob(h.context, first.id);
    assert.equal(resumed.status, "completed");
    assert.deepEqual(resumed.outputAssets.slice(0, 2), first.outputAssets);
    assert.deepEqual(resumed.outputAssets.map((asset) => asset.role), ["vocals", "drums", "residual"]);
    assert.deepEqual(requests.slice(beforeResume), [
      "POST https://www.lalal.ai/api/v1/check/",
      `GET https://d.lalal.ai/${TASK_ID}/no_multistem`,
    ]);
    assert.equal(requests.filter((request) => request.endsWith("/split/multistem/")).length, 1);
  }
});
