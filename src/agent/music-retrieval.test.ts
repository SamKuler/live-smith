import assert from "node:assert/strict";
import test from "node:test";
import { parseAudioToolRequest, validateAudioServiceRequest } from "./audio-tools.js";
import {
  builtInAudioLocalToolName,
  createBuiltInAudioToolsets,
} from "../plugins/builtins/audio-toolsets.js";
import type { AudioServiceChoice } from "../audio-services/capabilities.js";

const service = { id: "website", name: "Suno", provider: "suno" as const };
const clipIds = ["aaaaaaaa-1111-4111-8111-111111111111", "bbbbbbbb-2222-4222-8222-222222222222"];
const parse = (value: unknown) => parseAudioToolRequest("retrieve_music", JSON.stringify(value));

test("retrieve_music exposes only a connection and one or two unique canonical UUIDs", () => {
  const toolsFor = (connections: AudioServiceChoice[]) => createBuiltInAudioToolsets({
    services: connections,
    includeModelAudioInput: false,
    execute: async () => ({ content: "unused" }),
  }).flatMap((toolset) => toolset.tools());
  const tool = toolsFor([service]).find((entry) =>
    builtInAudioLocalToolName(entry.function.name) === "retrieve_music")!;
  assert.ok(tool);
  const schema = tool.function.parameters as { additionalProperties: boolean; required: string[]; properties: Record<string, unknown> };
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["serviceId", "clipIds"]);
  assert.deepEqual(Object.keys(schema.properties), ["serviceId", "clipIds"]);
  const ids = schema.properties.clipIds as { minItems: number; maxItems: number; uniqueItems: boolean; items: { pattern: string } };
  assert.deepEqual([ids.minItems, ids.maxItems, ids.uniqueItems], [1, 2, true]);
  assert.ok(new RegExp(ids.items.pattern).test(clipIds[0]!));
  assert.ok(!new RegExp(ids.items.pattern).test(clipIds[0]!.toUpperCase()));
  for (const count of [1, 2]) {
    const input = { serviceId: service.id, clipIds: clipIds.slice(0, count) };
    assert.deepEqual(parse(input), { kind: "retrieve_music", ...input });
    validateAudioServiceRequest(parse(input), [service]);
  }
  for (const provider of ["elevenlabs", "sunoapi", "lalal"] as const) {
    const other = [{ ...service, provider }];
    assert.ok(!toolsFor(other).some((entry) =>
      builtInAudioLocalToolName(entry.function.name) === "retrieve_music"));
    assert.throws(() => validateAudioServiceRequest(parse({ serviceId: service.id, clipIds }), other));
  }
});

test("retrieve_music parser rejects extra fields, invalid IDs, duplicate IDs and invalid bounds", () => {
  for (const ids of [[], [...clipIds, "cccccccc-3333-4333-8333-333333333333"], [clipIds[0], clipIds[0]],
    [clipIds[0]!.toUpperCase()], ["../clip"], [clipIds[0] + "\n"], [`https://suno.com/song/${clipIds[0]}`], [null], null]) {
    assert.throws(() => parse({ serviceId: service.id, clipIds: ids }));
  }
  for (const patch of [{ prompt: "generate" }, { expectedAccountId: "user" }, { url: "https://example.com" }, { serviceId: "../website" }]) {
    assert.throws(() => parse({ serviceId: service.id, clipIds, ...patch }));
  }
});
