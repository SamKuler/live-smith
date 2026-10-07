import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AudioClip, AudioTrack } from '@ableton-extensions/sdk';
import { createRequestAudioTools } from '../../../src/app/audio/request-audio-tools.js';
import { createLiveSetGuard } from '../../../src/live/set-identity.js';
import { retrievalHarness, connection, clipIds } from './support/audio-retrieval-test-helpers.js';
import { waveBytes } from '../../storage/support/audio-storage-test-helpers.js';
import type { SunoUploadAdapter } from '../../../src/audio-services/suno/suno-upload.js';

function sdkObject(prototype: object, properties: Record<string, unknown>) {
  return Object.defineProperties(Object.create(prototype), Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, { value, writable: true, enumerable: true }])));
}
for (const phase of ['before-tool', 'before-snapshot', 'during-render', 'before-provider'] as const) {
  test(`Arrangement upload rejects a Set change ${phase}`, async t => {
    const h = await retrievalHarness(t);
    const audioPath = join(h.directory, 'render.wav'); await writeFile(audioPath, waveBytes(6));
    const clip = sdkObject(AudioClip.prototype, { handle: { id: 3n }, name: 'Reference', startTime: 0, endTime: 12, duration: 12, startMarker: 0, endMarker: 12, looping: false, loopStart: 0, loopEnd: 12, muted: false, filePath: '/source.wav', warping: true, warpMode: 'complex', warpMarkers: [] });
    const track = sdkObject(AudioTrack.prototype, { handle: { id: 2n }, name: 'Reference', arrangementClips: [clip], clipSlots: [] });
    const song = { handle: { id: 1n }, tempo: 120, tracks: [track] };
    let renders = 0; let uploads = 0;
    const context = { application: { song }, resources: { renderPreFxAudio: async () => { renders++; if (phase === 'during-render') song.handle.id = 99n; return audioPath; } } };
    const adapter: SunoUploadAdapter = { limits: async () => ({ minimumSeconds: 1, maximumSeconds: 60 }), create: async () => { uploads++; return { uploadId: clipIds[0]!, url: 'https://suno-data-uploads.s3.amazonaws.com/', fields: {} }; }, upload: async () => {}, finish: async () => {}, inspect: async () => ({ status: 'complete' }), initialize: async () => clipIds[1]! };
    const tools = await createRequestAudioTools({ context: context as never, assertLiveSetCurrent: createLiveSetGuard(context as never), storageDirectory: h.directory, sessionId: h.session.id, requestId: 'source-request', attachmentRefs: [], target: {}, signal: h.controller.signal,
      onProgress: () => { if (phase === 'before-snapshot') song.handle.id = 99n; }, onAssets: () => {},
      withGenerationAuthorization: async (_signal, run) => { if (phase === 'before-provider') song.handle.id = 99n; return run(); }, processing: { pluginOverrides: { uploadAdapter: adapter }, wait: async () => {} } });
    if (phase === 'before-tool') song.handle.id = 99n;
    const result = await tools.execute({ id: 'upload', name: 'builtin_suno_upload_music', arguments: JSON.stringify({ connectionId: connection.id, rightsConfirmed: true, source: { kind: 'arrangement_audio', trackName: 'Reference', clipName: 'Reference', clipStartBeat: 0, startBeat: 0, endBeat: 12 } }) });
    assert.equal(result.failed, true);
    assert.equal(uploads, 0);
    if (phase === 'before-tool' || phase === 'before-snapshot') assert.equal(renders, 0);

  });
}
