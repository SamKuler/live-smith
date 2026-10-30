import assert from "node:assert/strict";
import test from "node:test";
import { syncBuiltinESMExports } from "node:module";
import { setImmediate } from "node:timers/promises";
import { createEventStreamClient } from "../../../src/app/chat/event-stream-client.js";
import { controlledEventStream } from "./support/controlled-event-stream.js";

test("queued event-stream frames resume in order without repeating an accepted frame", async () => {
  const socket = controlledEventStream();
  let retired = 0;
  const client = createEventStreamClient(socket.stream, () => retired++);
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
  test(`a stalled event-stream client is retired at the pending ${limit} limit without affecting another client`, async () => {
    const stalled = controlledEventStream(); const healthy = controlledEventStream();
    let retired = 0;
    const client = createEventStreamClient(stalled.stream, () => retired++);
    const other = createEventStreamClient(healthy.stream, () => {});
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

test("event-stream drain deadlines retire stalled sockets and are cleared after drain", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); syncBuiltinESMExports();
  t.after(() => { t.mock.timers.reset(); syncBuiltinESMExports(); });
  const stalled = controlledEventStream(); const healthy = controlledEventStream();
  let retired = 0;
  const client = createEventStreamClient(stalled.stream, () => retired++);
  const other = createEventStreamClient(healthy.stream, () => {});
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
  test(`event-stream ${terminal} discards queued work and removes the drain listener`, async () => {
    const socket = controlledEventStream(); let retired = 0;
    const client = createEventStreamClient(socket.stream, () => retired++);
    client.send("accepted"); client.send("queued");
    if (terminal === "shutdown") {
      client.close();
      assert.equal(socket.stream.destroyed, true, "Shutdown must release an upgraded socket even when its accepted write never drains");
    }
    else socket.stream.destroy(terminal === "error" ? new Error("socket failed") : undefined);
    await setImmediate(); socket.drain(); await setImmediate(); client.send("late");
    assert.deepEqual(socket.frames, ["accepted"]);
    assert.equal(socket.stream.listenerCount("drain"), 0);
    assert.equal(retired, 1);
  });
}
