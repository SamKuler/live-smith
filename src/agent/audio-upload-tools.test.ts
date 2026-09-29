import assert from "node:assert/strict";
import test from "node:test";
import { parseAudioToolRequest, validateAudioServiceRequest } from "./audio-tools.js";
import { audioParameterGroups, parseAudioParameters } from "../plugins/builtins/parameter-panel.js";

const service = { id: "suno-account", name: "Suno account", pluginId: "live-smith.suno-website", provider: "suno" as const };

test("upload requires explicit rights confirmation and a host-owned source locator", () => {
  const args = { connectionId: service.id, source: { kind: "audio_asset", assetRef: "saved-audio" }, rightsConfirmed: true };
  const parsed = parseAudioToolRequest("upload_music", JSON.stringify(args));
  assert.deepEqual(parsed, { kind: "upload_music", ...args });
  validateAudioServiceRequest(parsed, [service]);
  for (const invalid of [
    { ...args, rightsConfirmed: false }, { ...args, rightsConfirmed: undefined },
    { ...args, source: { kind: "url", url: "https://example.com/audio.wav" } },
    { ...args, source: { kind: "audio_asset", assetRef: "../other-session" } },
    { ...args, source: { kind: "arrangement_audio", startBeat: 8, endBeat: 4 } },
  ]) assert.throws(() => parseAudioToolRequest("upload_music", JSON.stringify(invalid)));
});

test("manual upload exposes a confirmation control and excludes request-only attachments", async () => {
  const panel = audioParameterGroups({ services: [service], hasJobs: false, identity: () => "owner" })
    .flatMap((group) => group.tools).find((tool) => tool.name === "builtin_suno_upload_music")!.audioPanel!;
  const field = (panel.schema.properties as Record<string, Record<string, unknown>>).rightsConfirmed!;
  assert.equal(field.type, "boolean");
  assert.equal(Object.hasOwn(field, "const"), false);
  assert.doesNotMatch(JSON.stringify(panel.schema), /request_audio_attachment/);
  await assert.rejects(parseAudioParameters({ toolName: panel.toolName, services: [service], arguments: {
    connectionId: service.id, rightsConfirmed: true,
    source: { kind: "request_audio_attachment", requestId: "manual-audio", audioIndex: 0 },
  } }));
  const parsed = await parseAudioParameters({ toolName: panel.toolName, services: [service], arguments: {
    connectionId: service.id, rightsConfirmed: true,
    source: { kind: "arrangement_audio", trackName: "Vocal", startBeat: 0, endBeat: 16 },
  } });
  assert.equal(parsed.kind, "upload_music");
});
