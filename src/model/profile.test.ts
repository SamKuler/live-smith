import assert from "node:assert/strict";
import test from "node:test";

import {
  validateDraftProfileForDiscovery,
  validateDraftProfileForSave,
} from "./profile.js";

function profile(baseUrl: string): Record<string, unknown> {
  return {
    id: "deepseek-anthropic",
    name: "DeepSeek Anthropic",
    apiFamily: "anthropic",
    apiMode: "messages",
    baseUrl,
    apiKey: "test-key",
    model: "deepseek-v4-flash",
    parameters: {
      maxOutputTokens: 8192,
      reasoning: { mode: "default" },
    },
    advanced: {},
  };
}

test("Profile validation does not depend on an ambient URL constructor", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "URL");
  Object.defineProperty(globalThis, "URL", {
    configurable: true,
    value: undefined,
    writable: true,
  });
  try {
    const validated = validateDraftProfileForSave(
      profile("https://api.deepseek.com/anthropic"),
    );
    assert.equal(validated.baseUrl, "https://api.deepseek.com/anthropic");
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "URL", descriptor);
    else Reflect.deleteProperty(globalThis, "URL");
  }
});

test("Profile validation still rejects malformed and non-HTTP Base URLs", () => {
  assert.throws(
    () => validateDraftProfileForSave(profile("not a URL")),
    /Base URL is invalid/,
  );
  assert.throws(
    () => validateDraftProfileForSave(profile("file:///tmp/provider")),
    /Base URL must use HTTP or HTTPS/,
  );
});

test("Profile validation rejects Base URLs containing userinfo credentials", () => {
  for (const baseUrl of [
    "https://alice@example.test/v1",
    "https://alice:url-secret@example.test/v1",
  ]) {
    assert.throws(
      () => validateDraftProfileForSave(profile(baseUrl)),
      /Base URL must not include credentials/,
    );
  }
});

test("Profile validation permits plaintext HTTP only for loopback providers", () => {
  for (const baseUrl of [
    "http://localhost:11434/v1",
    "http://models.localhost/v1",
    "http://127.0.0.1:8080/v1",
    "http://127.42.0.7/v1",
    "http://[::1]:11434/v1",
    "http://[::ffff:127.0.0.1]/v1",
  ]) {
    assert.equal(validateDraftProfileForSave(profile(baseUrl)).baseUrl, baseUrl);
  }

  for (const baseUrl of [
    "http://example.com/v1",
    "http://192.168.1.20/v1",
    "http://10.0.0.20/v1",
    "http://169.254.1.1/v1",
  ]) {
    assert.throws(
      () => validateDraftProfileForSave(profile(baseUrl)),
      /HTTPS.*loopback|loopback.*HTTPS/i,
    );
  }
});

test("Profile validation rejects unsafe or overlong internal IDs", () => {
  for (const id of ["../profile", "profile.with-dot", "a".repeat(129)]) {
    assert.throws(
      () => validateDraftProfileForSave({
        ...profile("https://example.test/v1"),
        id,
      }),
      (error: unknown) =>
        error instanceof Error &&
        error.name === "ProfileValidationError" &&
        /Profile ID must be 1-128/.test(error.message),
    );
  }
});

test("Draft discovery validation permits blank Profile name and model", () => {
  const draft = validateDraftProfileForDiscovery({
    ...profile("https://example.test/v1"),
    name: "",
    model: "",
  });

  assert.equal(draft.name, "");
  assert.equal(draft.model, "");
  assert.equal(draft.baseUrl, "https://example.test/v1");
});

test("Draft save validation still requires Profile name and model", () => {
  assert.throws(
    () => validateDraftProfileForSave({
      ...profile("https://example.test/v1"),
      name: "",
      model: "",
    }),
    (error: unknown) =>
      error instanceof Error &&
      error.name === "ProfileValidationError" &&
      /Profile name is required/.test(error.message),
  );

  assert.throws(
    () => validateDraftProfileForSave({
      ...profile("https://example.test/v1"),
      name: "Complete Profile",
      model: "",
    }),
    (error: unknown) =>
      error instanceof Error &&
      error.name === "ProfileValidationError" &&
      /Model is required/.test(error.message),
  );
});

test("image capability override is strictly validated and preserved", () => {
  const validated = validateDraftProfileForSave({
    ...profile("https://example.test/v1"),
    advanced: {
      capabilityOverrides: {
        inputs: { image: true, audio: false },
      },
    },
  });
  assert.deepEqual(validated.advanced.capabilityOverrides?.inputs, {
    image: true,
    audio: false,
  });

  for (const inputs of [
    { image: "yes" },
    { image: true, video: true },
  ]) {
    assert.throws(
      () => validateDraftProfileForSave({
        ...profile("https://example.test/v1"),
        advanced: { capabilityOverrides: { inputs } },
      }),
      /capabilityOverrides\.inputs/,
    );
  }
});
