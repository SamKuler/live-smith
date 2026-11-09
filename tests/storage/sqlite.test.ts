import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import test from "node:test";
import {
  initializeSqliteStorage, listStoredEntries, listStoredChildren, openStoredReader,
  readStoredBytes, readStoredText, removeStoredEntry, removeStoredTree, storedEntry,
  writeStoredBytes, writeStoredJson, STORAGE_CHUNK_BYTES, STORAGE_DATABASE_NAME,
} from "../../src/storage/sqlite.js";

async function temporary(t: test.TestContext) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"live-smith-sqlite-"));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;
}
async function seed(root:string,key:string,bytes:string|Uint8Array) {
  const file=path.join(root,key);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,bytes);return file;
}

test("migration preserves original bytes and recovery staging while freezing a separate Plugin data backup",async t=>{
  const root=await temporary(t);const large=Buffer.alloc(STORAGE_CHUNK_BYTES*2+17,37);
  const files=new Map<string,string|Uint8Array>([
    ["live-smith-settings.json",'{"schemaVersion":1}'],
    ["live-smith-events/session-one.json","[]"],
    ["live-smith-midi/session-one/part.mid",large],
    ["live-smith-skills/sound/.SKILL.md.skill_next.next","pending definition"],
    ["live-smith-plugins/packages/tool/user-config.json",'{"amount":0.5}'],
    ["live-smith-plugins/data/tool/private.bin",new Uint8Array([9,8,7])],
  ]);
  for(const [key,value] of files)await seed(root,key,value);
  await seed(root,"live-smith-exports/export-test/reference.wav","export copy");
  await seed(root,"live-smith-plugins/runtime/tool/digest/main.js","runtime cache");
  const reports=await Promise.all(Array.from({length:8},()=>initializeSqliteStorage(root)));
  assert.ok(reports.every(info=>info.importedFiles===6 && info.preservedPluginFiles===1));
  assert.equal((await listStoredEntries(root)).length,5);
  assert.deepEqual(await readStoredBytes(root,"live-smith-midi/session-one/part.mid"),large);
  assert.equal((await storedEntry(root,"live-smith-midi/session-one/part.mid"))!.sha256,createHash("sha256").update(large).digest("hex"));
  assert.deepEqual(await listStoredChildren(root,"live-smith-midi"),["session-one"]);
  await writeStoredJson(root,"live-smith-settings.json",{schemaVersion:10});
  await removeStoredTree(root,"live-smith-midi");
  await removeStoredTree(root,"live-smith-plugins");
  for(const [key,value] of files)assert.deepEqual(await fs.readFile(path.join(root,key)),Buffer.from(value));
  const db=new DatabaseSync(path.join(root,STORAGE_DATABASE_NAME));
  try {
    assert.deepEqual(db.prepare("SELECT path,preserved FROM entries WHERE preserved=1").all().map(row=>({...row})),[{path:"live-smith-plugins/data/tool/private.bin",preserved:1}]);
    assert.equal(db.prepare("PRAGMA integrity_check").get()!.integrity_check,"ok");
  } finally {db.close();}
  await assert.rejects(writeStoredBytes(root,"live-smith-plugins/data/tool/private.bin",new Uint8Array([0])),{code:"EEXIST"});
});

test("a completed import never rereads or resurrects modified legacy files",async t=>{
  const root=await temporary(t);const file=await seed(root,"live-smith-settings.json",'{"value":"original"}');
  await initializeSqliteStorage(root);
  await writeStoredJson(root,"live-smith-settings.json",{value:"database"});
  await fs.writeFile(file,'{"value":"late legacy writer"}');
  assert.deepEqual(JSON.parse(await readStoredText(root,"live-smith-settings.json")),{value:"database"});
  await removeStoredEntry(root,"live-smith-settings.json");
  await assert.rejects(readStoredText(root,"live-smith-settings.json"),{code:"ENOENT"});
  assert.equal(await fs.readFile(file,"utf8"),'{"value":"late legacy writer"}');
});

test("a source change during import rolls back every copied entry and permits a clean retry",async t=>{
  const root=await temporary(t);const file=await seed(root,"live-smith-settings.json",'{"value":"before"}');
  await seed(root,"live-smith-sessions.json","[]");
  const run=StatementSync.prototype.run;let changed=false;
  const mock=t.mock.method(StatementSync.prototype,"run",function(this:StatementSync,...args:Parameters<typeof run>){
    const result=run.apply(this,args);
    if(!changed && this.sourceSQL.startsWith("INSERT INTO chunks")) {changed=true;writeFileSync(file,'{"value":"changed during import"}');}
    return result;
  });
  await assert.rejects(initializeSqliteStorage(root),/preserved/);
  assert.equal(changed,true);mock.mock.restore();
  const db=new DatabaseSync(path.join(root,STORAGE_DATABASE_NAME));
  try {assert.equal(db.prepare("PRAGMA user_version").get()!.user_version,0);assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name='entries'").get()!.count,0);}finally{db.close();}
  const info=await initializeSqliteStorage(root);assert.equal(info.importedFiles,2);
  assert.equal(await readStoredText(root,"live-smith-settings.json"),'{"value":"changed during import"}');
});

test("failed multi-chunk replacement rolls back the whole record and create-only preserves existing content",async t=>{
  const root=await temporary(t);const key="live-smith-midi/session-one/part.mid";
  const old=Buffer.alloc(STORAGE_CHUNK_BYTES+9,17);await writeStoredBytes(root,key,old);
  const before=await storedEntry(root,key);
  const db=new DatabaseSync(path.join(root,STORAGE_DATABASE_NAME));
  try {db.exec("CREATE TRIGGER reject_second_chunk BEFORE INSERT ON chunks WHEN NEW.chunk_index=1 BEGIN SELECT RAISE(ABORT,'injected write failure'); END;");}finally{db.close();}
  await assert.rejects(writeStoredBytes(root,key,Buffer.alloc(STORAGE_CHUNK_BYTES*2,29)),/injected write failure/);
  assert.deepEqual(await readStoredBytes(root,key),old);assert.deepEqual(await storedEntry(root,key),before);
  await assert.rejects(writeStoredBytes(root,key,Buffer.from([1]),{createOnly:true}),{code:"EEXIST"});
  assert.deepEqual(await readStoredBytes(root,key),old);
});

for(const bytes of [Buffer.alloc(0),Buffer.from([1,2,3])])test(`a ${bytes.length}-byte reader rejects replacement and deletion`,async t=>{
  const root=await temporary(t);const key="live-smith-midi/session-one/test.mid";
  await writeStoredBytes(root,key,bytes);const reader=await openStoredReader(root,key);
  try {await writeStoredBytes(root,key,bytes);assert.throws(()=>reader.readChunk(0));}finally{reader.close();}
  const removed=await openStoredReader(root,key);
  try {await removeStoredEntry(root,key);assert.throws(()=>removed.readChunk(0));}finally{removed.close();}
});

test("unknown databases and unsafe legacy roots are rejected without importing or overwriting source files",async t=>{
  const root=await temporary(t);const original=await seed(root,"live-smith-settings.json",'{"original":true}');
  const db=new DatabaseSync(path.join(root,STORAGE_DATABASE_NAME));
  try {db.exec("PRAGMA journal_mode=WAL; CREATE TABLE other_product(value TEXT); INSERT INTO other_product VALUES('keep');");}finally{db.close();}
  await assert.rejects(initializeSqliteStorage(root),/preserved/);
  assert.equal(await fs.readFile(original,"utf8"),'{"original":true}');
  const reopened=new DatabaseSync(path.join(root,STORAGE_DATABASE_NAME));
  try {
    assert.equal(reopened.prepare("SELECT value FROM other_product").get()!.value,"keep");
    assert.equal(reopened.prepare("PRAGMA journal_mode").get()!.journal_mode,"wal");
  }finally{reopened.close();}
  const malformed=await temporary(t);await fs.mkdir(path.join(malformed,"live-smith-settings.json"));
  await assert.rejects(initializeSqliteStorage(malformed),/preserved/);
  assert.equal((await fs.stat(path.join(malformed,"live-smith-settings.json"))).isDirectory(),true);
});

test("tree operations isolate neighboring path prefixes", async t => {
  const root = await temporary(t);
  for (const key of ["library", "library/item", "library/nested/item", "library-two/item", "library.item", "library0/item"]) {
    await writeStoredBytes(root, key, Buffer.from(key));
  }
  assert.deepEqual((await listStoredEntries(root, "library")).map(entry => entry.key), ["library", "library/item", "library/nested/item"]);
  assert.deepEqual(await listStoredChildren(root, "library"), ["item", "nested"]);
  assert.equal(await removeStoredTree(root, "library"), 3);
  assert.deepEqual((await listStoredEntries(root)).map(entry => entry.key), ["library-two/item", "library.item", "library0/item"]);
});

test("linked databases and legacy media are rejected without writing their external targets", { skip: process.platform === "win32" }, async t => {
  const outside = await temporary(t);
  const target = path.join(outside, "external.bin");
  await fs.writeFile(target, "Preserved external content");
  for (const link of ["symbolic", "hard"] as const) {
    const root = await temporary(t);
    const database = path.join(root, STORAGE_DATABASE_NAME);
    if (link === "symbolic") await fs.symlink(target, database);
    else await fs.link(target, database);
    await assert.rejects(initializeSqliteStorage(root));
    assert.equal(await fs.readFile(target, "utf8"), "Preserved external content");
  }
  const root = await temporary(t);
  await fs.mkdir(path.join(root, "live-smith-midi"));
  await fs.symlink(outside, path.join(root, "live-smith-midi", "session-linked"));
  await assert.rejects(initializeSqliteStorage(root));
  assert.equal(await fs.readFile(target, "utf8"), "Preserved external content");
});
