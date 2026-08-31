import assert from "node:assert/strict";
import test from "node:test";

import {
  inputTransportSupport,
  isModelInputMediaType,
  mimeBackedInputCapabilities,
  providerSupportsMimeType,
} from "./input-support.js";

test("model input media rules share exact, wildcard, and transport boundaries", () => {
  assert.equal(isModelInputMediaType("image", "image/webp"), true);
  assert.equal(isModelInputMediaType("image", "image/gif"), false);
  assert.equal(providerSupportsMimeType({ "*/*": true }, "audio/mpeg"), true);
  assert.equal(providerSupportsMimeType({
    "*/*": true,
    "audio/*": true,
    "audio/mpeg": false,
  }, "audio/mpeg"), false);
  assert.deepEqual(inputTransportSupport({
    kind: "direct-api",
    apiFamily: "openai",
    apiMode: "chat-completions",
    baseUrl: "https://example.test",
    apiKey: "local-test-key",
  }), { image: true, audio: true, pdf: false });
});

test("coarse positive evidence stays unverified until MIME coverage is complete", () => {
  const transport = { image: true, audio: true, pdf: true };
  assert.equal(mimeBackedInputCapabilities({
    supportsImages: true,
    inputModalities: ["image", "audio"],
  }, transport), undefined);
  assert.deepEqual(mimeBackedInputCapabilities({
    supportedMimeTypes: {
      "image/png": true,
      "image/jpeg": true,
      "image/webp": false,
      "audio/*": true,
      "application/pdf": true,
    },
  }, transport), { image: false, audio: true, pdf: true });
  assert.deepEqual(mimeBackedInputCapabilities({
    supportsImages: false,
    supportsPdf: false,
    supportedMimeTypes: { "*/*": true },
  }, transport), { image: false, audio: true, pdf: false });
});

test("provider evidence is intersected with what the wire protocol can send", () => {
  assert.deepEqual(mimeBackedInputCapabilities({
    supportedMimeTypes: { "*/*": true },
  }, { image: true, audio: false, pdf: true }), {
    image: true,
    audio: false,
    pdf: true,
  });
  assert.deepEqual(mimeBackedInputCapabilities({
    inputModalities: ["audio"],
  }, { image: true, audio: false, pdf: true }), { audio: false });
});
