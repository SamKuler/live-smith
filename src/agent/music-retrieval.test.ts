import assert from "node:assert/strict";
import test from "node:test";
import { parseAudioToolRequest, validateAudioServiceRequest } from "./audio-tools.js";
import {
  builtInAudioLocalToolName,
  createBuiltInAudioToolsets,
} from "../plugins/builtins/audio-toolsets.js";
import type { BuiltInIntegrationConnectionChoice } from "../plugins/builtins/contracts.js";
import { builtInAudioPluginId } from "../plugins/builtins/index.js";

const choice = <Choice extends Omit<BuiltInIntegrationConnectionChoice, "pluginId">>(
  value: Choice,
): Choice & Pick<BuiltInIntegrationConnectionChoice, "pluginId"> => ({
  ...value,
  pluginId: builtInAudioPluginId(value.provider),
});
const service = choice({ id: "website", name: "Suno", provider: "suno" as const });
const clipIds = ["aaaaaaaa-1111-4111-8111-111111111111", "bbbbbbbb-2222-4222-8222-222222222222"];
const parse = (value: unknown) => parseAudioToolRequest("retrieve_music", JSON.stringify(value));

test("retrieve_music exposes only a connection and one or two unique canonical UUIDs", () => {
  const toolsFor = (connections: BuiltInIntegrationConnectionChoice[]) => createBuiltInAudioToolsets({
    services: connections,
    includeModelAudioInput: false,
    execute: async () => ({ content: "unused" }),
  }).flatMap((toolset) => toolset.tools());
  const tool = toolsFor([service]).find((entry) =>
    builtInAudioLocalToolName(entry.function.name) === "retrieve_music")!;
  assert.ok(tool);
  const schema = tool.function.parameters as { additionalProperties: boolean; required: string[]; properties: Record<string, unknown> };
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["connectionId", "clipIds"]);
  assert.deepEqual(Object.keys(schema.properties), ["connectionId", "clipIds"]);
  const ids = schema.properties.clipIds as { minItems: number; maxItems: number; uniqueItems: boolean; items: { pattern: string } };
  assert.deepEqual([ids.minItems, ids.maxItems, ids.uniqueItems], [1, 2, true]);
  assert.ok(new RegExp(ids.items.pattern).test(clipIds[0]!));
  assert.ok(!new RegExp(ids.items.pattern).test(clipIds[0]!.toUpperCase()));
  for (const count of [1, 2]) {
    const input = { connectionId: service.id, clipIds: clipIds.slice(0, count) };
    assert.deepEqual(parse(input), { kind: "retrieve_music", ...input });
    validateAudioServiceRequest(parse(input), [service]);
  }
  for (const provider of ["elevenlabs", "sunoapi", "lalal"] as const) {
    const other = [choice({ ...service, provider })];
    assert.ok(!toolsFor(other).some((entry) =>
      builtInAudioLocalToolName(entry.function.name) === "retrieve_music"));
    assert.throws(() => validateAudioServiceRequest(parse({ connectionId: service.id, clipIds }), other));
  }
});

test("retrieve_music parser rejects extra fields, invalid IDs, duplicate IDs and invalid bounds", () => {
  for (const ids of [[], [...clipIds, "cccccccc-3333-4333-8333-333333333333"], [clipIds[0], clipIds[0]],
    [clipIds[0]!.toUpperCase()], ["../clip"], [clipIds[0] + "\n"], [`https://suno.com/song/${clipIds[0]}`], [null], null]) {
    assert.throws(() => parse({ connectionId: service.id, clipIds: ids }));
  }
  for (const patch of [{ prompt: "generate" }, { expectedAccountId: "user" }, { url: "https://example.com" }, { connectionId: "../website" }]) {
    assert.throws(() => parse({ connectionId: service.id, clipIds, ...patch }));
  }
});
