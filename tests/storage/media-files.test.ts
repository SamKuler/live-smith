import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { execPath } from "node:process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { MEDIA_DIRECTORY_NAME } from "../../src/storage/media-files.js";
import {
  createStoredFileWriter, copyStoredReference, initializeSqliteStorage, openStoredRangeReader,
  readStoredBytes, readStoredText, removeStoredEntry, removeStoredTree, storedEntry, writeStoredBytes,
  STORAGE_CHUNK_BYTES, STORAGE_DATABASE_NAME, STORAGE_V1_BACKUP_NAME,
} from "../../src/storage/sqlite.js";
async function temporary(t:test.TestContext){const root=await fs.mkdtemp(path.join(os.tmpdir(),"live-smith-media-"));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}
async function objects(root:string){return (await fs.readdir(path.join(root,MEDIA_DIRECTORY_NAME))).filter(name=>!name.startsWith("."));}

test("streamed staging supports inspection, bounded ranges, shared references and final reference cleanup",async t=>{
  const root=await temporary(t);const bytes=Buffer.alloc(STORAGE_CHUNK_BYTES*3+27,71);bytes[STORAGE_CHUNK_BYTES]=22;
  const writer=await createStoredFileWriter(root,{expectedByteLength:bytes.length,expectedSha256:createHash("sha256").update(bytes).digest("hex")});
  await writer.append(bytes.subarray(0,100));await writer.append(bytes.subarray(100));
  assert.equal(writer.byteLength,bytes.length);assert.deepEqual(await writer.readRange(STORAGE_CHUNK_BYTES-2,5),bytes.subarray(STORAGE_CHUNK_BYTES-2,STORAGE_CHUNK_BYTES+3));
  assert.equal(await storedEntry(root,"first"),undefined);
  const first=await writer.publish("first",{createOnly:true});await writer.abort();
  const second=await copyStoredReference(root,"first","second",{createOnly:true});
  assert.equal(second.key,"second");assert.notEqual(first.revision,second.revision);assert.equal((await objects(root)).length,1);
  const db=new DatabaseSync(path.join(root,STORAGE_DATABASE_NAME));
  try{assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chunks").get()!.n,0);}finally{db.close();}
  const reader=await openStoredRangeReader(root,"first");
  try{
    assert.deepEqual(await reader.readRange(STORAGE_CHUNK_BYTES-2,5),bytes.subarray(STORAGE_CHUNK_BYTES-2,STORAGE_CHUNK_BYTES+3));
    await assert.rejects(reader.readRange(0,STORAGE_CHUNK_BYTES+1));
    await removeStoredEntry(root,"first");await assert.rejects(reader.readRange(0,10));
    assert.deepEqual(await readStoredBytes(root,"second"),bytes);assert.equal((await objects(root)).length,1);
  }finally{await reader.close();}
  await removeStoredEntry(root,"second");assert.deepEqual(await objects(root),[]);
});

test("abort, input length mismatch, digest mismatch and create-only failures leave existing bytes and revisions",async t=>{
  const root=await temporary(t);await writeStoredBytes(root,"media",Buffer.from("original"),{storage:"file"});const old=await storedEntry(root,"media");
  for(const kind of ["cancel","short","long","digest","exists"]){
    const writer=await createStoredFileWriter(root,kind==="short"?{expectedByteLength:20}:kind==="long"?{expectedByteLength:2}:kind==="digest"?{expectedSha256:"0".repeat(64)}:{});
    try{
      if(kind==="long")await assert.rejects(writer.append(Buffer.from("new content")));
      else {await writer.append(Buffer.from("new content"));
        if(kind==="cancel")await writer.abort();
        else await assert.rejects(writer.publish("media",{createOnly:kind==="exists"}));
      }
    }finally{await writer.abort();}
    assert.deepEqual(await storedEntry(root,"media"),old);assert.equal((await readStoredBytes(root,"media")).toString(),"original");
    assert.equal((await fs.readdir(path.join(root,MEDIA_DIRECTORY_NAME))).length,1);
  }
});

test("same-byte replacement invalidates old file readers including empty media",async t=>{
  const root=await temporary(t);
  for(const bytes of [Buffer.alloc(0),Buffer.from("same")]){
    await writeStoredBytes(root,"key",bytes,{storage:"file"});const reader=await openStoredRangeReader(root,"key");
    try{await writeStoredBytes(root,"key",bytes,{storage:"file"});await assert.rejects(reader.readRange(0,bytes.length));}finally{await reader.close();}
    assert.deepEqual(await readStoredBytes(root,"key"),bytes);
  }
});

test("failed metadata publication retains old references and cleans unreferenced new file",async t=>{
  const root=await temporary(t);await writeStoredBytes(root,"key",Buffer.from("old"),{storage:"file"});
  const db=new DatabaseSync(path.join(root,STORAGE_DATABASE_NAME));
  try{db.exec("CREATE TRIGGER reject_replacement BEFORE INSERT ON entries WHEN NEW.path='key' BEGIN SELECT RAISE(ABORT,'injected metadata failure'); END;");}finally{db.close();}
  await assert.rejects(writeStoredBytes(root,"key",Buffer.from("new"),{storage:"file"}),/injected metadata failure/);
  assert.equal((await readStoredBytes(root,"key")).toString(),"old");assert.equal((await objects(root)).length,1);
});

test("inline ranges cross chunk boundaries and whole reads detect corrupted media",async t=>{
  const root=await temporary(t);const bytes=Buffer.alloc(STORAGE_CHUNK_BYTES+12,4);await writeStoredBytes(root,"inline",bytes);
  const reader=await openStoredRangeReader(root,"inline");try{assert.deepEqual(await reader.readRange(STORAGE_CHUNK_BYTES-5,17),bytes.subarray(STORAGE_CHUNK_BYTES-5));}finally{await reader.close();}
  await writeStoredBytes(root,"media",Buffer.from("correct"),{storage:"file"});const entry=(await storedEntry(root,"media"))!;
  await fs.writeFile(path.join(root,MEDIA_DIRECTORY_NAME,entry.sha256),"corrupt");await assert.rejects(readStoredBytes(root,"media"));
  await assert.rejects(writeStoredBytes(root,"another",Buffer.from("correct"),{storage:"file"}));assert.equal(await storedEntry(root,"another"),undefined);
  await fs.unlink(path.join(root,MEDIA_DIRECTORY_NAME,entry.sha256));await assert.rejects(openStoredRangeReader(root,"media"));
});

test("media directories and object symlinks cannot access external content",{skip:os.platform()==="win32"},async t=>{
  const root=await temporary(t);const outside=await temporary(t);await initializeSqliteStorage(root);
  await fs.rm(path.join(root,MEDIA_DIRECTORY_NAME),{recursive:true,force:true});await fs.symlink(outside,path.join(root,MEDIA_DIRECTORY_NAME));
  await assert.rejects(createStoredFileWriter(root));assert.deepEqual(await fs.readdir(outside),[]);
  await fs.unlink(path.join(root,MEDIA_DIRECTORY_NAME));await writeStoredBytes(root,"key",Buffer.from("private"),{storage:"file"});
  const entry=(await storedEntry(root,"key"))!;const target=path.join(outside,"data");await fs.writeFile(target,"private");
  const object=path.join(root,MEDIA_DIRECTORY_NAME,entry.sha256);await fs.unlink(object);await fs.symlink(target,object);
  await assert.rejects(openStoredRangeReader(root,"key"));assert.equal(await fs.readFile(target,"utf8"),"private");
});

function seedV1(root:string,entries:Array<[string,Buffer,number]>) {
  const db=new DatabaseSync(path.join(root,STORAGE_DATABASE_NAME));
  try{
    db.exec(`CREATE TABLE storage_state(id INTEGER PRIMARY KEY,migrated INTEGER,revision INTEGER,imported_files INTEGER,imported_bytes INTEGER,preserved_plugin_files INTEGER);
      INSERT INTO storage_state VALUES(1,1,20,3,10,1);
      CREATE TABLE entries(path TEXT PRIMARY KEY,byte_length INTEGER,sha256 TEXT,revision INTEGER,preserved INTEGER);
      CREATE TABLE chunks(path TEXT REFERENCES entries(path) ON DELETE CASCADE,chunk_index INTEGER,bytes BLOB,PRIMARY KEY(path,chunk_index));
      PRAGMA application_id=1280527700;PRAGMA user_version=1;`);
    for(const [key,bytes,preserved]of entries){
      db.prepare("INSERT INTO entries VALUES(?,?,?,?,?)").run(key,bytes.length,createHash("sha256").update(bytes).digest("hex"),1,preserved);
      for(let offset=0,index=0;offset<bytes.length;offset+=STORAGE_CHUNK_BYTES,index++)db.prepare("INSERT INTO chunks VALUES(?,?,?)").run(key,index,bytes.subarray(offset,offset+STORAGE_CHUNK_BYTES));
    }
  }finally{db.close();}
}
test("SQLite v1 migration backs up original records and streams registered media while JSON and Plugin data stay intact",async t=>{
  const root=await temporary(t);const bytes=Buffer.alloc(STORAGE_CHUNK_BYTES*4+3,19);
  seedV1(root,[["live-smith-attachments/s/original.bin",bytes,0],["live-smith-settings.json",Buffer.from('{"value":1}'),0],["live-smith-plugins/data/private.bin",Buffer.from("external"),1]]);
  await initializeSqliteStorage(root);const backup=await fs.readFile(path.join(root,STORAGE_V1_BACKUP_NAME));
  assert.deepEqual(await readStoredBytes(root,"live-smith-attachments/s/original.bin"),bytes);assert.equal(await readStoredText(root,"live-smith-settings.json"),'{"value":1}');
  const db=new DatabaseSync(path.join(root,STORAGE_DATABASE_NAME));
  try{assert.equal(db.prepare("PRAGMA user_version").get()!.user_version,2);assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE path LIKE 'live-smith-attachments/%'").get()!.n,0);assert.equal(db.prepare("SELECT preserved FROM entries WHERE path='live-smith-plugins/data/private.bin'").get()!.preserved,1);}finally{db.close();}
  await removeStoredTree(root,"live-smith-attachments");await initializeSqliteStorage(root);assert.deepEqual(await fs.readFile(path.join(root,STORAGE_V1_BACKUP_NAME)),backup);
  const old=new DatabaseSync(path.join(root,STORAGE_V1_BACKUP_NAME),{readOnly:true});try{assert.equal(old.prepare("PRAGMA user_version").get()!.user_version,1);assert.equal(old.prepare("SELECT COUNT(*) AS n FROM chunks WHERE path LIKE 'live-smith-attachments/%'").get()!.n,5);}finally{old.close();}
});

test("copying an inline legacy reference streams to one reusable media object",async t=>{
  const root=await temporary(t);const bytes=Buffer.alloc(STORAGE_CHUNK_BYTES*2+5,8);await writeStoredBytes(root,"inline-source",bytes);
  const copied=await copyStoredReference(root,"inline-source","file-target");assert.equal(copied.key,"file-target");
  await copyStoredReference(root,"file-target","another-target");assert.equal((await objects(root)).length,1);
  await removeStoredEntry(root,"file-target");assert.deepEqual(await readStoredBytes(root,"another-target"),bytes);assert.deepEqual(await readStoredBytes(root,"inline-source"),bytes);
});

test("failed v1 conversion rolls back its schema and references while the immutable backup permits retry",async t=>{
  const root=await temporary(t);const bytes=Buffer.from("preserved-media");seedV1(root,[["live-smith-audio/s/a.audio",bytes,0]]);
  const db=new DatabaseSync(path.join(root,STORAGE_DATABASE_NAME));
  try{db.exec("CREATE TRIGGER reject_media BEFORE UPDATE ON entries BEGIN SELECT RAISE(ABORT,'injected conversion failure'); END;");}finally{db.close();}
  await assert.rejects(initializeSqliteStorage(root));const backup=await fs.readFile(path.join(root,STORAGE_V1_BACKUP_NAME));
  const failed=new DatabaseSync(path.join(root,STORAGE_DATABASE_NAME));
  try{assert.equal(failed.prepare("PRAGMA user_version").get()!.user_version,1);assert.equal(failed.prepare("SELECT COUNT(*) AS n FROM chunks").get()!.n,1);failed.exec("DROP TRIGGER reject_media");}finally{failed.close();}
  await initializeSqliteStorage(root);assert.deepEqual(await readStoredBytes(root,"live-smith-audio/s/a.audio"),bytes);assert.deepEqual(await fs.readFile(path.join(root,STORAGE_V1_BACKUP_NAME)),backup);
});

test("reopening storage removes abandoned staging and unreferenced objects while keeping committed media",async t=>{
  const root=await temporary(t);
  const source=new URL("../../src/storage/sqlite.ts",import.meta.url).href;
  await promisify(execFile)(execPath,["--import","tsx","--input-type=module","-e",`
    import {writeStoredBytes,createStoredFileWriter} from ${JSON.stringify(source)};
    await writeStoredBytes(${JSON.stringify(root)},"saved",new Uint8Array([1,2,3]),{storage:"file"});
    const writer=await createStoredFileWriter(${JSON.stringify(root)});await writer.append(new Uint8Array([4,5,6]));
    process.exit(0);
  `]);
  const directory=path.join(root,MEDIA_DIRECTORY_NAME);
  assert.ok((await fs.readdir(directory)).some(name=>name.startsWith(".staging-")));
  await fs.writeFile(path.join(directory,"0".repeat(64)),"orphan");
  await initializeSqliteStorage(root);assert.deepEqual(await readStoredBytes(root,"saved"),Buffer.from([1,2,3]));
  assert.equal((await fs.readdir(directory)).length,1);
});

test("an absolute logical key through a storage-root alias resolves inside its canonical root",{skip:os.platform()==="win32"},async t=>{
  const parent=await temporary(t);const root=path.join(parent,"actual");const alias=path.join(parent,"alias");await fs.mkdir(root);await fs.symlink(root,alias);
  const writer=await createStoredFileWriter(alias);await writer.append(Buffer.from("aliased"));await writer.publish(path.join(alias,"media","clip"));
  assert.equal((await readStoredBytes(root,"media/clip")).toString(),"aliased");
  assert.equal((await copyStoredReference(alias,path.join(alias,"media/clip"),path.join(alias,"media/copy"))).key,"media/copy");
  await removeStoredEntry(root,"media/clip");assert.equal((await readStoredBytes(alias,"media/copy")).toString(),"aliased");
});

async function crashAfterPublicationLink(root:string,kind:"media"|"backup") {
  const source=new URL("../../src/storage/sqlite.ts",import.meta.url).href;
  await assert.rejects(promisify(execFile)(execPath,["--import","tsx","--input-type=module","-e",`
    import fs from "node:fs/promises";
    import path from "node:path";
    import {syncBuiltinESMExports} from "node:module";
    const storage=await import(${JSON.stringify(source)});
    const root=${JSON.stringify(root)};
    if(${JSON.stringify(kind)}==="media") {
      await storage.writeStoredJson(root,"live-smith-settings.json",{existing:true});
      await storage.writeStoredBytes(root,"saved",new Uint8Array([1,2,3]),{storage:"file"});
    }
    const link=fs.link;
    fs.link=async function(from,to) {
      await link(from,to);
      if(${JSON.stringify(kind)}==="media" ? /^[a-f0-9]{64}$/.test(path.basename(to)) : path.basename(to)===storage.STORAGE_V1_BACKUP_NAME) process.exit(73);
    };
    syncBuiltinESMExports();
    if(${JSON.stringify(kind)}==="media") await storage.writeStoredBytes(root,"uncommitted",new Uint8Array([4,5,6]),{storage:"file"});
    else await storage.initializeSqliteStorage(root);
    process.exit(74);
  `]),(error:unknown)=>(error as {code?:number}).code===73);
}

test("process exit after media publication link recovers settings and committed media and discards the uncommitted object",async t=>{
  const root=await temporary(t);await crashAfterPublicationLink(root,"media");
  const directory=path.join(root,MEDIA_DIRECTORY_NAME);
  const staging=(await fs.readdir(directory)).find(name=>name.startsWith(".staging-"))!;
  assert.equal((await fs.lstat(path.join(directory,staging))).nlink,2);
  await initializeSqliteStorage(root);
  assert.deepEqual(JSON.parse(await readStoredText(root,"live-smith-settings.json")),{existing:true});
  assert.deepEqual(await readStoredBytes(root,"saved"),Buffer.from([1,2,3]));
  assert.equal(await storedEntry(root,"uncommitted"),undefined);
  assert.equal((await fs.readdir(directory)).length,1);
  await initializeSqliteStorage(root);assert.deepEqual(await readStoredBytes(root,"saved"),Buffer.from([1,2,3]));
});

test("process exit after v1 backup publication link preserves the backup and resumes conversion",async t=>{
  const root=await temporary(t);const bytes=Buffer.from("migration-media");
  seedV1(root,[["live-smith-settings.json",Buffer.from('{"existing":true}'),0],["live-smith-audio/s/a.audio",bytes,0]]);
  await crashAfterPublicationLink(root,"backup");
  const backupPath=path.join(root,STORAGE_V1_BACKUP_NAME);const backup=await fs.readFile(backupPath);
  assert.equal((await fs.lstat(backupPath)).nlink,2);
  await initializeSqliteStorage(root);
  assert.deepEqual(await readStoredBytes(root,"live-smith-audio/s/a.audio"),bytes);
  assert.equal(await readStoredText(root,"live-smith-settings.json"),'{"existing":true}');
  assert.equal((await fs.lstat(backupPath)).nlink,1);
  assert.deepEqual(await fs.readFile(backupPath),backup);
  assert.equal((await fs.readdir(root)).some(name=>name.startsWith(".sqlite-v1-backup-")),false);
  await initializeSqliteStorage(root);assert.deepEqual(await fs.readFile(backupPath),backup);
});

test("process exit publishing migrated media resumes v1 conversion after recovering its paired link",async t=>{
  const root=await temporary(t);const bytes=Buffer.from("migrated-content");
  seedV1(root,[["live-smith-audio/s/a.audio",bytes,0]]);
  const source=new URL("../../src/storage/sqlite.ts",import.meta.url).href;
  await assert.rejects(promisify(execFile)(execPath,["--import","tsx","--input-type=module","-e",`
    import fs from "node:fs/promises";
    import path from "node:path";
    import {syncBuiltinESMExports} from "node:module";
    const link=fs.link;fs.link=async function(from,to){await link(from,to);if(/^[a-f0-9]{64}$/.test(path.basename(to)))process.exit(73);};syncBuiltinESMExports();
    const storage=await import(${JSON.stringify(source)});await storage.initializeSqliteStorage(${JSON.stringify(root)});process.exit(74);
  `]),(error:unknown)=>(error as {code?:number}).code===73);
  await initializeSqliteStorage(root);assert.deepEqual(await readStoredBytes(root,"live-smith-audio/s/a.audio"),bytes);
  const files=await fs.readdir(path.join(root,MEDIA_DIRECTORY_NAME));assert.equal(files.length,1);assert.equal((await fs.lstat(path.join(root,MEDIA_DIRECTORY_NAME,files[0]!))).nlink,1);
});

test("publication recovery rejects external hardlinks and leaves every original name intact",async t=>{
  for(const extraOwnedLink of [false,true]) {
    const root=await temporary(t),outside=await temporary(t);const directory=path.join(root,MEDIA_DIRECTORY_NAME);await fs.mkdir(directory);
    const stage=path.join(directory,".staging-11111111-1111-1111-1111-111111111111");
    await fs.writeFile(stage,"external-preserved");
    const external=path.join(outside,"external");await fs.link(stage,external);
    if(extraOwnedLink)await fs.link(stage,path.join(directory,"1".repeat(64)));
    await assert.rejects(initializeSqliteStorage(root));
    assert.equal(await fs.readFile(external,"utf8"),"external-preserved");
    assert.equal((await fs.lstat(stage)).nlink,extraOwnedLink?3:2);
  }
  const root=await temporary(t),outside=await temporary(t);
  seedV1(root,[["live-smith-settings.json",Buffer.from('{"existing":true}'),0]]);
  const backup=path.join(root,STORAGE_V1_BACKUP_NAME);
  await fs.copyFile(path.join(root,STORAGE_DATABASE_NAME),backup);
  const external=path.join(outside,"backup");await fs.link(backup,external);const original=await fs.readFile(external);
  await assert.rejects(initializeSqliteStorage(root));
  assert.equal((await fs.lstat(backup)).nlink,2);assert.deepEqual(await fs.readFile(external),original);
});
