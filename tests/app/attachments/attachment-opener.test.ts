import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import process from "node:process";
import test from "node:test";

import { createAttachmentOpener } from "../../../src/app/attachments/attachment-opener.js";
import { createHostAbortController } from "../../../src/runtime/host.js";
import {
  readSessionAttachment,
  saveSessionAttachment,
  type ReadSessionAttachmentResult,
} from "../../../src/storage/attachments.js";

async function fixture(t: test.TestContext): Promise<{
  root: string;
  storageDirectory: string;
  temporaryDirectory: string;
  blob: string;
  value: ReadSessionAttachmentResult;
}> {
  const root = await fs.mkdtemp(path.join(tmpdir(), "live-smith-attachment-opener-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const storageDirectory = path.join(root, "storage");
  const temporaryDirectory = path.join(root, "exports");
  await fs.mkdir(storageDirectory);
  await fs.mkdir(temporaryDirectory);
  const stored = await saveSessionAttachment(storageDirectory, "session-open", {
    fileName: "notes.html",
    bytes: new Uint8Array(Buffer.from("<script>window.alert('notes');</script>")),
  }, { preSavePendingAttachmentRefs: [] });
  return {
    root,
    storageDirectory,
    temporaryDirectory,
    blob: path.join(storageDirectory, "live-smith-attachments", "session-open", `${stored.id}.bin`),
    value: await readSessionAttachment(storageDirectory, "session-open", stored.id),
  };
}

test("the default application receives a private MIME-named copy, and edits survive reuse and close", async (t) => {
  const input = await fixture(t);
  const opened: string[] = [];
  const opener = createAttachmentOpener({
    platform: "darwin",
    temporaryDirectory: input.temporaryDirectory,
    runOpenCommand: async (executable, args) => {
      assert.equal(executable, "/usr/bin/open");
      assert.equal(args.length, 1);
      opened.push(args[0]!);
    },
  });
  assert.equal(input.value.attachment.fileName, "notes.html");
  assert.equal(input.value.attachment.mediaType, "text/plain");
  await opener.open(input.value);
  const target = opened[0]!;
  assert.equal(path.extname(target), ".txt");
  assert.equal(path.relative(input.temporaryDirectory, target).startsWith(".."), false);
  assert.notEqual(target, input.blob);
  assert.deepEqual(new Uint8Array(await fs.readFile(target)), input.value.bytes);
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(path.dirname(target))).mode & 0o777, 0o700);
    assert.equal((await fs.stat(target)).mode & 0o777, 0o600);
  }
  await fs.writeFile(target, "Edited in the default application.");
  await opener.open(await readSessionAttachment(input.storageDirectory, "session-open", input.value.attachment.id));
  assert.deepEqual(opened, [target, target]);
  assert.deepEqual(new Uint8Array(await fs.readFile(input.blob)), input.value.bytes);
  assert.equal(await fs.readFile(target, "utf8"), "Edited in the default application.");
  assert.equal((await fs.readdir(input.temporaryDirectory)).length, 1);
  assert.equal((await fs.readdir(path.dirname(target))).length, 1);
  opener.close();
  assert.equal(await fs.readFile(target, "utf8"), "Edited in the default application.");
  await assert.rejects(opener.open(input.value), /opener is closed/u);
  assert.equal(opened.length, 2);
});

test("the Windows fixed system handler receives the canonical PDF copy as one argument", async (t) => {
  const input = await fixture(t);
  const stored = await saveSessionAttachment(input.storageDirectory, "session-open", {
    fileName: "score.pdf",
    bytes: new Uint8Array(Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n")),
  }, { preSavePendingAttachmentRefs: [] });
  const value = await readSessionAttachment(input.storageDirectory, "session-open", stored.id);
  let target: string | undefined;
  const opener = createAttachmentOpener({
    platform: "win32",
    windowsSystemRoot: "C:/Windows/",
    temporaryDirectory: input.temporaryDirectory,
    runOpenCommand: async (executable, args) => {
      assert.equal(executable, "C:\\Windows\\System32\\rundll32.exe");
      assert.equal(args.length, 2);
      assert.equal(args[0], "url.dll,FileProtocolHandler");
      target = args[1]!;
      assert.equal(path.extname(target), ".pdf");
      assert.deepEqual(new Uint8Array(await fs.readFile(target)), value.bytes);
    },
  });
  await opener.open(value);
  opener.close();
  assert.ok(target);
  assert.deepEqual(new Uint8Array(await fs.readFile(target)), value.bytes);
});

test("cancellation or close during preparation removes an undispatched copy", async (t) => {
  const input = await fixture(t);
  const controller = createHostAbortController();
  const reason = new Error("Stop before dispatch.");
  const opener = createAttachmentOpener({
    platform: "darwin",
    temporaryDirectory: input.temporaryDirectory,
    runOpenCommand: async () => assert.fail("A canceled open must not reach the handler."),
  });
  const pending = opener.open(input.value, controller.signal);
  const cancelled = assert.rejects(pending, (error: unknown) => error === reason);
  controller.abort(reason);
  await cancelled;
  const directories = await fs.readdir(input.temporaryDirectory);
  assert.equal(directories.length, 1);
  assert.deepEqual(await fs.readdir(path.join(input.temporaryDirectory, directories[0]!)), []);
  const closed = assert.rejects(opener.open(input.value), /opener is closed/u);
  opener.close();
  await closed;
  assert.deepEqual(await fs.readdir(path.join(input.temporaryDirectory, directories[0]!)), []);
});

test("launch failures and cancellation retain dispatched copies without exposing paths", async (t) => {
  const input = await fixture(t);
  const controller = createHostAbortController();
  const reason = new Error("Stop after dispatch.");
  const opened: string[] = [];
  const opener = createAttachmentOpener({
    platform: "darwin",
    temporaryDirectory: input.temporaryDirectory,
    runOpenCommand: async (_executable, args, signal) => {
      opened.push(args[0]!);
      if (signal) {
        assert.equal(signal, controller.signal);
        controller.abort(reason);
      }
      throw new Error(`The external app failed reading ${args[0]!}.`);
    },
  });
  await assert.rejects(opener.open(input.value), (error: unknown) => {
    assert.equal((error as Error).message, "The attachment could not be opened.");
    return true;
  });
  await assert.rejects(opener.open(input.value, controller.signal), (error: unknown) => error === reason);
  opener.close();
  assert.deepEqual(opened, [opened[0], opened[0]]);
  assert.deepEqual(new Uint8Array(await fs.readFile(opened[0]!)), input.value.bytes);
});

test("failed preparation can be retried and does not reveal a private path", async (t) => {
  const input = await fixture(t);
  const temporaryDirectory = path.join(input.root, "missing-directory");
  let calls = 0;
  const opener = createAttachmentOpener({
    platform: "darwin",
    temporaryDirectory,
    runOpenCommand: async () => { calls += 1; },
  });
  await assert.rejects(opener.open(input.value), (error: unknown) => {
    assert.equal((error as Error).message, "The attachment could not be opened.");
    return true;
  });
  assert.equal(calls, 0);
  await fs.mkdir(temporaryDirectory);
  await opener.open(input.value);
  assert.equal(calls, 1);
  assert.equal((await fs.readdir(temporaryDirectory)).length, 1);
  opener.close();
});

test("close preserves a copy while the external handler is still opening it", async (t) => {
  const input = await fixture(t);
  let finish!: () => void;
  const pendingHandler = new Promise<void>((resolve) => { finish = resolve; });
  let started!: () => void;
  const handlerStarted = new Promise<void>((resolve) => { started = resolve; });
  let target: string | undefined;
  const opener = createAttachmentOpener({
    platform: "darwin",
    temporaryDirectory: input.temporaryDirectory,
    runOpenCommand: async (_executable, args) => {
      target = args[0]!;
      started();
      await pendingHandler;
      assert.deepEqual(new Uint8Array(await fs.readFile(target)), input.value.bytes);
    },
  });
  const pending = opener.open(input.value);
  await handlerStarted;
  opener.close();
  finish();
  await pending;
  assert.ok(target);
  assert.deepEqual(new Uint8Array(await fs.readFile(target)), input.value.bytes);
});
