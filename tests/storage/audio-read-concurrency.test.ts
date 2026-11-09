import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { createHostAbortController } from "../../src/runtime/host.js";
import { readAudioAsset } from "../../src/storage/audio-assets.js";
import { AudioStorageError, bindAudioDirectory, listAudioJobs, readBoundedAudioFile } from "../../src/storage/audio-jobs.js";
import { storedEntry, writeStoredBytes, removeStoredEntry } from "../../src/storage/sqlite.js";
import { MEDIA_DIRECTORY_NAME } from "../../src/storage/media-files.js";
import { audioStorageHarness, waveBytes } from "./support/audio-storage-test-helpers.js";

async function fixture(t: TestContext) {
  const h = await audioStorageHarness(t);
  const bytes = waveBytes(300);
  const asset = await h.save("source", bytes);
  const name = `${asset.id}.audio`;
  const target = path.join(h.directory, name);
  const binding = (await bindAudioDirectory(h.storage, h.session.id))!;
  return { ...h, bytes, asset, name, target, binding,
    read: (signal?: AbortSignal) => readBoundedAudioFile(binding, name, asset.byteLength, signal) };
}

async function interceptFirstMediaRead(t: TestContext, h: Awaited<ReturnType<typeof fixture>>, action: () => void | Promise<void>) {
  const entry=(await storedEntry(h.storage,h.target))!;
  const handle=await fs.open(path.join(h.storage,MEDIA_DIRECTORY_NAME,entry.sha256),"r");
  const expected=await handle.stat();
  const prototype=Object.getPrototypeOf(handle) as fs.FileHandle;
  const read=prototype.read;
  await handle.close();
  let consumed:fs.FileHandle|undefined;
  const fault=t.mock.method(prototype,"read",async function(this:fs.FileHandle,...args:unknown[]){
    const result=await Reflect.apply(read,this,args);
    if(!consumed) {
      const actual=await this.stat();
      if(actual.dev===expected.dev && actual.ino===expected.ino){consumed=this;await action();}
    }
    return result;
  });
  return {restore:()=>fault.mock.restore(),consumed:()=>consumed};
}

test("concurrent audio readers and job listings preserve exact bytes and stored revisions", async t => {
  const h = await fixture(t);
  const before = await storedEntry(h.storage, h.target);
  await Promise.all(Array.from({ length: 4 }, async () => {
    const [jobs, asset] = await Promise.all([listAudioJobs(h.storage, h.session.id), readAudioAsset(h.storage, h.session.id, h.asset.id)]);
    assert.deepEqual(jobs, [h.job]); assert.deepEqual(asset, { asset: h.asset, bytes: h.bytes });
  }));
  assert.deepEqual(await storedEntry(h.storage, h.target), before);
});

test("a cancelled chunked read releases its reader while independent reads continue", async t => {
  const h = await fixture(t);
  const controller = createHostAbortController();
  const reason = new Error("cancel audio read");
  let cancelled = false;
  const fault = await interceptFirstMediaRead(t,h,()=>{cancelled=true;controller.abort(reason);});
  await assert.rejects(h.read(controller.signal), error => error === reason);
  fault.restore();
  assert.equal(cancelled, true);
  assert.equal(fault.consumed()?.fd,-1);
  assert.deepEqual(await h.read(), h.bytes);
  await assert.rejects(readBoundedAudioFile(h.binding, h.name, h.asset.byteLength - 1), AudioStorageError);
  assert.deepEqual(await h.read(), h.bytes);
});

for (const operation of ["replace", "delete"] as const) test(`audio readers reject a ${operation} during chunk consumption`, async t => {
  const h = await fixture(t);
  let changed = false;
  const fault = await interceptFirstMediaRead(t,h,async()=>{
    changed=true;
    if(operation==="replace")await writeStoredBytes(h.storage,h.target,h.bytes,{storage:"file"});
    else await removeStoredEntry(h.storage,h.target);
  });
  await assert.rejects(h.read(), AudioStorageError);
  fault.restore();
  assert.equal(changed, true);
  assert.equal(fault.consumed()?.fd,-1);
});
