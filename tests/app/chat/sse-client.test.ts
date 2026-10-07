import assert from "node:assert/strict";
import test from "node:test";
import { syncBuiltinESMExports } from "node:module";
import { setImmediate } from "node:timers/promises";
import { createSseClient } from "../../../src/app/chat/sse-client.js";
import { controlledSseResponse } from "./support/controlled-sse-response.js";

test("queued SSE frames resume in order without repeating an accepted frame", async () => {
  const socket = controlledSseResponse();
  let retired = 0;
  const client = createSseClient(socket.response, () => retired++);
  client.send("first"); client.send("second"); client.send("third");
  assert.deepEqual(socket.frames, ["first"]);
  socket.drain(); await setImmediate();
  assert.deepEqual(socket.frames, ["first", "second"]);
  socket.drain(); await setImmediate();
  assert.deepEqual(socket.frames, ["first", "second", "third"]);
  socket.drain(); await setImmediate();
  assert.equal(retired, 0);
  client.close(); client.close(); await setImmediate();
  assert.equal(retired, 1);
});

for (const limit of ["bytes", "frames"] as const) {
  test(`a stalled SSE client is retired at the pending ${limit} limit without affecting another client`, async () => {
    const stalled = controlledSseResponse(); const healthy = controlledSseResponse();
    let retired = 0;
    const client = createSseClient(stalled.response, () => retired++);
    const other = createSseClient(healthy.response, () => {});
    client.send("accepted");
    if (limit === "bytes") {
      client.send("界".repeat(1024 * 1024));
      assert.equal(retired, 0);
      client.send("x".repeat(2 * 1024 * 1024));
    } else {
      for (let index = 0; index < 4096; index++) client.send("x");
      assert.equal(retired, 0);
      client.send("excess");
    }
    assert.equal(stalled.stream.destroyed, true);
    assert.equal(retired, 1);
    other.send("healthy"); healthy.drain(); await setImmediate();
    assert.equal(healthy.stream.destroyed, false);
    assert.deepEqual(healthy.frames, ["healthy"]);
    stalled.drain(); client.send("late"); await setImmediate();
    assert.deepEqual(stalled.frames, ["accepted"]);
    other.close();
  });
}

test("SSE drain deadlines retire stalled sockets and are cleared after drain", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); syncBuiltinESMExports();
  t.after(() => { t.mock.timers.reset(); syncBuiltinESMExports(); });
  const stalled = controlledSseResponse(); const healthy = controlledSseResponse();
  let retired = 0;
  const client = createSseClient(stalled.response, () => retired++);
  const other = createSseClient(healthy.response, () => {});
  client.send("stalled"); other.send("accepted");
  healthy.drain(); await setImmediate();
  t.mock.timers.tick(14_999);
  assert.equal(stalled.stream.destroyed, false);
  t.mock.timers.tick(1);
  assert.equal(stalled.stream.destroyed, true);
  assert.equal(healthy.stream.destroyed, false);
  assert.equal(retired, 1);
  other.close(); await setImmediate();
});

for (const terminal of ["close", "error", "shutdown"] as const) {
  test(`SSE ${terminal} discards queued work and removes the drain listener`, async () => {
    const socket = controlledSseResponse(); let retired = 0;
    const client = createSseClient(socket.response, () => retired++);
    client.send("accepted"); client.send("queued");
    if (terminal === "shutdown") client.close();
    else socket.stream.destroy(terminal === "error" ? new Error("socket failed") : undefined);
    await setImmediate(); socket.drain(); await setImmediate(); client.send("late");
    assert.deepEqual(socket.frames, ["accepted"]);
    assert.equal(socket.stream.listenerCount("drain"), 0);
    assert.equal(retired, 1);
  });
}
