import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import { createSession } from "../../../src/storage/sessions.js";
import { createRequestAudioTools } from "../../../src/app/audio/request-audio-tools.js";
import { savePluginAudioArtifact } from "../../../src/storage/audio-artifacts.js";
import { listAudioJobs } from "../../../src/storage/audio-jobs.js";
import { waveBytes } from "../../storage/support/audio-storage-test-helpers.js";

test("granted Plugin audio can register and be listened to within the current request without a provider job", async (t) => {
  const storage = await fs.mkdtemp('/private/tmp/live-smith-plugin-audio-request-');
  t.after(() => fs.rm(storage, { recursive: true, force: true }));
  const session = await createSession(storage, { title: 'Plugin audio', projectKey: 'test-project', scope: { kind: 'track', identity: '1', label: 'Track' } });
  const h = { storage, session, signal: new AbortController().signal };
  const observed: string[] = [];
  const options = { context: {} as never, storageDirectory: h.storage, sessionId: h.session.id, requestId: 'request-audio',
    attachmentRefs: [], target: {}, signal: h.signal, onProgress() {},
    onAssets: async (assets: readonly { id: string }[]) => { observed.push(...assets.map((asset) => asset.id)); },
    modelAudioInput: { canAccept: () => true } };
  const beforeJobs = await listAudioJobs(h.storage, h.session.id);
  assert.deepEqual(beforeJobs, []);
  const tools = await createRequestAudioTools({ assertLiveSetCurrent: () => {}, ...{ ...options, hasPluginAudioOutputs: true } });
  assert.ok(tools.tools.some((tool) => tool.function.name === 'listen_to_audio_asset'));
  const audio = await savePluginAudioArtifact(h.storage, h.session.id, { connectionId: 'renderer', serverId: 'local', toolName: 'render',
    label: 'Rendered take', format: 'wav', bytes: waveBytes(), signal: h.signal });
  await tools.registerArtifacts([audio]);
  assert.ok(observed.includes(audio.id));
  const listen = await tools.execute({ id: 'listen', name: 'listen_to_audio_asset', arguments: JSON.stringify({ assetRef: audio.id }) });
  assert.equal(listen.failed, undefined);
  assert.equal(listen.modelInputPart?.type, 'audio');
  if (listen.modelInputPart?.type === 'audio') assert.deepEqual(listen.modelInputPart.bytes, waveBytes());
  assert.deepEqual(await listAudioJobs(h.storage, h.session.id), beforeJobs);
  const reopened = await createRequestAudioTools({ assertLiveSetCurrent: () => {}, ...options });
  assert.ok(reopened.tools.some((tool) => tool.function.name === 'listen_to_audio_asset'));
  assert.equal((await reopened.execute({ id: 'later', name: 'listen_to_audio_asset', arguments: JSON.stringify({ assetRef: audio.id }) })).failed, undefined);
});
