import assert from "node:assert/strict";
import test from "node:test";

import {
  SteeringCapacityError,
  SteeringChannel,
  SteeringClosedError,
  SteeringConflictError,
} from "./steering.js";

test("a new steering submission interrupts only the active model turn", async () => {
  const channel = new SteeringChannel();
  const parent = new AbortController();
  const turn = channel.beginModelTurn(parent.signal);

  const submitted = channel.submit("request-1", "Turn the selected track down.");

  assert.equal(turn.signal.aborted, true);
  assert.equal(turn.wasInterrupted(), true);
  assert.equal(parent.signal.aborted, false);

  takeOnlyEntry(channel).accept();
  await submitted;
  turn.dispose();
});

test("parent cancellation propagates without being reported as steering", () => {
  const channel = new SteeringChannel();
  const parent = new AbortController();
  const reason = new Error("Session stopped.");
  const turn = channel.beginModelTurn(parent.signal);

  parent.abort(reason);

  assert.equal(turn.signal.aborted, true);
  assert.equal(turn.signal.reason, reason);
  assert.equal(turn.wasInterrupted(), false);
  turn.dispose();
});

test("duplicate id and prompt share one pending result", async () => {
  const channel = new SteeringChannel();

  const first = channel.enqueue("request-1", "Add a MIDI track.");
  const duplicate = channel.enqueue("request-1", "Add a MIDI track.");

  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.completion, first.completion);
  const entry = takeOnlyEntry(channel);
  assert.deepEqual(channel.takePending(), []);

  entry.accept();
  await Promise.all([first.completion, duplicate.completion]);
});

test("reusing an id with a different prompt fails with a conflict", async () => {
  const channel = new SteeringChannel();
  const original = channel.submit("request-1", "Set the tempo to 120.");

  assert.throws(
    () => channel.submit("request-1", "Set the tempo to 124."),
    SteeringConflictError,
  );

  takeOnlyEntry(channel).accept();
  await original;
});

test("the pending limit includes entries already taken by the consumer", async () => {
  const channel = new SteeringChannel({ maxPending: 1 });
  const first = channel.submit("request-1", "Mute track one.");
  const entry = takeOnlyEntry(channel);

  assert.throws(
    () => channel.submit("request-2", "Mute track two."),
    SteeringCapacityError,
  );

  entry.accept();
  await first;
});

test("takePending transfers queued entries and each entry settles once", async () => {
  const channel = new SteeringChannel();
  const submitted = channel.submit("request-1", "Create an audio track.");

  assert.equal(channel.hasPending(), true);
  const entry = takeOnlyEntry(channel);
  assert.equal(channel.hasPending(), false);
  assert.equal(entry.id, "request-1");
  assert.equal(entry.prompt, "Create an audio track.");

  entry.accept();
  assert.throws(() => entry.accept(), /already settled/);
  assert.throws(() => entry.reject(new Error("too late")), /already settled/);
  await submitted;
});

test("close rejects queued submissions but lets the persistence owner settle taken work", async () => {
  const channel = new SteeringChannel();
  const takenSubmission = channel.submit("request-1", "Mute the selected track.");
  const takenEntry = takeOnlyEntry(channel);
  const queuedSubmission = channel.submit("request-2", "Solo the selected track.");
  const queuedRejected = assert.rejects(queuedSubmission, SteeringClosedError);
  let takenSettled = false;
  void takenSubmission.finally(() => {
    takenSettled = true;
  });

  channel.close();

  await queuedRejected;
  await Promise.resolve();
  assert.equal(takenSettled, false);
  takenEntry.accept();
  await takenSubmission;
  assert.throws(
    () => channel.submit("request-3", "Arm the selected track."),
    SteeringClosedError,
  );
  assert.equal(channel.hasPending(), false);
});

test("takePending can preserve FIFO work for a later persistence attempt", async () => {
  const channel = new SteeringChannel();
  const first = channel.submit("request-1", "Use Lead.");
  const second = channel.submit("request-2", "Use Rhythm.");

  const [firstEntry] = channel.takePending(1);
  assert.equal(firstEntry?.id, "request-1");
  assert.equal(channel.hasPending(), true);
  firstEntry?.accept();
  await first;

  const [secondEntry] = channel.takePending(1);
  assert.equal(secondEntry?.id, "request-2");
  secondEntry?.accept();
  await second;
});

test("a disposed model turn is not interrupted by later steering", async () => {
  const channel = new SteeringChannel();
  const parent = new AbortController();
  const turn = channel.beginModelTurn(parent.signal);
  turn.dispose();

  const submitted = channel.submit("request-1", "Rename the selected track.");

  assert.equal(turn.signal.aborted, false);
  assert.equal(turn.wasInterrupted(), false);
  takeOnlyEntry(channel).accept();
  await submitted;
});

test("a model turn started after steering is queued begins interrupted", async () => {
  const channel = new SteeringChannel();
  const submitted = channel.submit("request-1", "Use the Lead track instead.");
  const parent = new AbortController();

  const turn = channel.beginModelTurn(parent.signal);

  assert.equal(turn.signal.aborted, true);
  assert.equal(turn.wasInterrupted(), true);
  takeOnlyEntry(channel).accept();
  await submitted;
  turn.dispose();
});

test("the per-send submission limit bounds repeated accepted steering", async () => {
  const channel = new SteeringChannel({ maxPending: 1, maxSubmissions: 2 });
  const first = channel.submit("request-1", "Use Lead.");
  takeOnlyEntry(channel).accept();
  await first;
  const second = channel.submit("request-2", "Use Rhythm.");
  takeOnlyEntry(channel).accept();
  await second;

  assert.strictEqual(channel.submit("request-1", "Use Lead."), first);
  assert.throws(
    () => channel.submit("request-3", "Use Bass."),
    (error: unknown) =>
      error instanceof SteeringCapacityError && error.scope === "total",
  );
});

function takeOnlyEntry(channel: SteeringChannel) {
  const entries = channel.takePending();
  assert.equal(entries.length, 1);
  return entries[0]!;
}
