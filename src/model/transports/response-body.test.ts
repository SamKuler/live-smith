import assert from "node:assert/strict";
import test from "node:test";

import { readBoundedJsonResponse } from "./response-body.js";

test("bounded JSON response reader parses a streamed response", async () => {
  const response = new Response('{"ok":true}', {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

  assert.deepEqual(await readBoundedJsonResponse(response, {
    label: "Test provider",
    maximumBytes: 32,
  }), { ok: true });
});

test("bounded JSON response reader rejects declared and streamed excess", async (t) => {
  await t.test("declared length", async () => {
    const response = new Response("{}", {
      status: 200,
      headers: { "Content-Length": "9" },
    });
    await assert.rejects(
      readBoundedJsonResponse(response, {
        label: "Test provider",
        maximumBytes: 8,
      }),
      /larger than 8 bytes/,
    );
  });

  await t.test("streamed length", async () => {
    const response = new Response("123456789", { status: 200 });
    await assert.rejects(
      readBoundedJsonResponse(response, {
        label: "Test provider",
        maximumBytes: 8,
      }),
      /larger than 8 bytes/,
    );
  });
});
