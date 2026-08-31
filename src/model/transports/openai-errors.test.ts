import assert from "node:assert/strict";
import test from "node:test";

import { ModelRetryableError } from "../connection-error.js";
import { openAIProviderFailure } from "./openai-errors.js";

test("OpenAI provider failures display only bounded canonical codes", () => {
  const safeCodes = [
    "future_provider_failure",
    `a${"0".repeat(63)}`,
  ];
  for (const code of safeCodes) {
    const failure = openAIProviderFailure({
      error: {
        code,
        message: "private provider detail",
        metadata: { private_value: "private metadata" },
      },
    }, "OpenAI Test");
    assert.equal(failure.message, `OpenAI Test failed. [code=${code}]`);
    assert.doesNotMatch(failure.message, /provider detail|metadata/u);
  }

  for (const code of [
    "",
    "UPPER_CASE",
    "contains-hyphen",
    "contains space",
    "échec",
    `a${"0".repeat(64)}`,
  ]) {
    const failure = openAIProviderFailure({
      error: { code, message: "private provider detail" },
    }, "OpenAI Test");
    assert.equal(failure.message, "OpenAI Test failed.", code);
  }
});

test("OpenAI future canonical failure codes can use the caller's retry policy", () => {
  const failure = openAIProviderFailure({
    error: { code: "future_transient_failure", message: "private detail" },
  }, "OpenAI Test", {
    retryAfterMs: 1_500,
    unknownIsRetryable: true,
  });

  assert.ok(failure instanceof ModelRetryableError);
  assert.equal(failure.retryAfterMs, 1_500);
  assert.equal(
    failure.message,
    "OpenAI Test reported a retryable failure. [code=future_transient_failure]",
  );
  assert.doesNotMatch(failure.message, /private detail/u);
});

test("OpenAI provider failures retain bounded code and type as distinct fields", () => {
  const failure = openAIProviderFailure({
    error: {
      code: "invalid_prompt",
      type: "invalid_request_error",
      message: "private provider detail",
      metadata: { private_value: "private metadata" },
    },
  }, "OpenAI Test");

  assert.equal(
    failure.message,
    "OpenAI Test rejected the request. " +
      "[code=invalid_prompt; type=invalid_request_error]",
  );
  assert.doesNotMatch(failure.message, /provider detail|private metadata/u);
});

test("OpenAI provider failures classify every safe code and type with fatal priority", () => {
  const rejected = openAIProviderFailure({
    error: {
      code: "future_provider_failure",
      type: "invalid_request_error",
      message: "private rejected detail",
    },
  }, "OpenAI Test", { unknownIsRetryable: true });
  assert.equal(rejected instanceof ModelRetryableError, false);
  assert.equal(
    rejected.message,
    "OpenAI Test rejected the request. " +
      "[code=future_provider_failure; type=invalid_request_error]",
  );

  for (const type of ["server_error", "rate_limit_error"]) {
    const retryable = openAIProviderFailure({
      error: {
        code: "future_provider_failure",
        type,
        message: "private retry detail",
      },
    }, "OpenAI Test");
    assert.ok(retryable instanceof ModelRetryableError);
    assert.equal(
      retryable.message,
      "OpenAI Test reported a retryable failure. " +
        `[code=future_provider_failure; type=${type}]`,
    );
    assert.doesNotMatch(
      `${rejected.message}\n${retryable.message}`,
      /private rejected|private retry/u,
    );
  }
});
