import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { constants, readSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getuid, platform } from "node:process";
import { backup as backupDatabase, DatabaseSync } from "node:sqlite";
import { isMissingFileError } from "./errors.js";
import { StorageCommitOutcomeUnknownError } from "./persistence.js";
import { cleanupMediaStages, createMediaStage, mediaDirectory, mediaObjectPath, openMediaObject, readMediaRange, recoverPublicationPair, verifyMediaObject } from "./media-files.js";

export const STORAGE_CHUNK_BYTES = 64 * 1024;
export const STORAGE_DATABASE_NAME = "live-smith.sqlite3";
const APPLICATION_ID = 0x4c534d54;
const SCHEMA_VERSION = 2;
export const STORAGE_V1_BACKUP_NAME = "live-smith.sqlite3.v1-backup";
const mutations = new Map<string, Promise<unknown>>();
async function mutate<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  const root = await privateRoot(directory);
  const current = (mutations.get(root) ?? Promise.resolve()).catch(() => {}).then(operation);
  mutations.set(root, current);
  try { return await current; } finally { if (mutations.get(root) === current) mutations.delete(root); }
}
const initializing = new Map<string, Promise<StorageMigrationInfo>>();
const recovered = new Set<string>();
const roots = new Set([
  "oauth", "live-smith-events", "live-smith-attachments", "live-smith-midi",
  "live-smith-audio", "live-smith-audio-artifacts", "live-smith-device-parameters", "live-smith-skills",
]);
const rootFiles = new Set([
  "live-smith-settings.json", "live-smith-sessions.json", "live-smith-mcp-oauth.json", "live-smith-mcp-server-clients.json",
]);
export interface StoredEntry { key: string; byteLength: number; sha256: string; revision: number }
export interface StorageMigrationInfo { importedFiles: number; importedBytes: number; preservedPluginFiles: number }
export interface StoredContentReader { entry: StoredEntry; readChunk(index: number): Buffer; close(): void }
interface LegacyFile { key: string; file: string; stat: Awaited<ReturnType<typeof fs.lstat>>; preserved: boolean }

export class StorageDatabaseError extends Error {
  constructor(cause?: unknown) {
    super("Saved data could not be opened or migrated. The original files have been preserved.", { cause });
    this.name = "StorageDatabaseError";
  }
}
function failure(code: "ENOENT" | "EEXIST"): Error & { code: string } {
  return Object.assign(new Error(code === "ENOENT" ? "Saved content is unavailable." : "Saved content already exists."), { code });
}
function keyOf(directory: string, input: string, allowEmpty = false): string {
  const relative = path.isAbsolute(input) ? path.relative(path.resolve(directory), input) : input;
  const key = relative.split(path.sep).join("/");
  if ((!key && !allowEmpty) || key.includes("\0") || key.includes("\\") || key.startsWith("/") ||
      key.split("/").some(part => part === "." || part === ".." || (!part && key !== ""))) throw new StorageDatabaseError();
  return key;
}
function owned(stat: Awaited<ReturnType<typeof fs.lstat>>): boolean {
  return platform === "win32" || !getuid || stat.uid === getuid();
}
async function privateRoot(directory: string): Promise<string> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const root = await fs.realpath(directory);
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !owned(stat)) throw new StorageDatabaseError();
  if (platform !== "win32" && (stat.mode & 0o7777) !== 0o700) {
    await fs.chmod(root, 0o700);
    const after = await fs.lstat(root);
    if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== stat.dev || after.ino !== stat.ino ||
        (after.mode & 0o7777) !== 0o700) throw new StorageDatabaseError();
  }
  return root;
}
async function privateDatabase(root: string): Promise<string> {
  const file = path.join(root, STORAGE_DATABASE_NAME);
  try { const handle = await fs.open(file, "wx", 0o600); await handle.close(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !owned(stat)) throw new StorageDatabaseError();
  if (platform !== "win32" && (stat.mode & 0o7777) !== 0o600) {
    await fs.chmod(file, 0o600);
    const after = await fs.lstat(file);
    if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1 || after.dev !== stat.dev || after.ino !== stat.ino ||
        (after.mode & 0o7777) !== 0o600) throw new StorageDatabaseError();
  }
  return file;
}
function connect(file: string): DatabaseSync {
  const db = new DatabaseSync(file, { timeout: 5000 });
  try {
    readInfo(db);
    db.exec("PRAGMA foreign_keys=ON; PRAGMA synchronous=EXTRA;");
    if (platform === "darwin") db.exec("PRAGMA fullfsync=ON;");
    const journal = db.prepare("PRAGMA journal_mode=DELETE").get();
    if (journal?.journal_mode !== "delete" || db.prepare("PRAGMA synchronous").get()?.synchronous !== 3 ||
        (platform === "darwin" && db.prepare("PRAGMA fullfsync").get()?.fullfsync !== 1)) throw new StorageDatabaseError();
    return db;
  } catch (error) { db.close(); throw error; }
}
function transaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = operation();
    try { db.exec("COMMIT"); } catch (error) { throw new StorageCommitOutcomeUnknownError(error); }
    return value;
  } catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; }
}
function readInfo(db: DatabaseSync): StorageMigrationInfo | undefined {
  const version = Number(db.prepare("PRAGMA user_version").get()?.user_version);
  const application = Number(db.prepare("PRAGMA application_id").get()?.application_id);
  if (version === 0 && application === 0 && !db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get()) return undefined;
  if ((version !== 1 && version !== SCHEMA_VERSION) || application !== APPLICATION_ID) throw new StorageDatabaseError();
  const row = db.prepare("SELECT imported_files, imported_bytes, preserved_plugin_files FROM storage_state WHERE id=1 AND migrated=1").get();
  if (!row) throw new StorageDatabaseError();
  return { importedFiles: Number(row.imported_files), importedBytes: Number(row.imported_bytes), preservedPluginFiles: Number(row.preserved_plugin_files) };
}
function schema(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE storage_state(id INTEGER PRIMARY KEY CHECK(id=1), migrated INTEGER NOT NULL, revision INTEGER NOT NULL,
      imported_files INTEGER NOT NULL, imported_bytes INTEGER NOT NULL, preserved_plugin_files INTEGER NOT NULL);
    INSERT INTO storage_state VALUES(1,0,0,0,0,0);
    CREATE TABLE entries(path TEXT PRIMARY KEY, byte_length INTEGER NOT NULL CHECK(byte_length>=0), sha256 TEXT NOT NULL,
      revision INTEGER NOT NULL, preserved INTEGER NOT NULL DEFAULT 0 CHECK(preserved IN (0,1)), media_object TEXT);
    CREATE INDEX entries_media_object ON entries(media_object) WHERE media_object IS NOT NULL;
    CREATE TABLE chunks(path TEXT NOT NULL REFERENCES entries(path) ON DELETE CASCADE, chunk_index INTEGER NOT NULL CHECK(chunk_index>=0),
      bytes BLOB NOT NULL CHECK(length(bytes)<=${STORAGE_CHUNK_BYTES}), PRIMARY KEY(path,chunk_index)) WITHOUT ROWID;
    CREATE TABLE legacy_sources(path TEXT PRIMARY KEY, fingerprint TEXT NOT NULL);
    PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${SCHEMA_VERSION};
  `);
}
function nextRevision(db: DatabaseSync): number {
  return Number(db.prepare("UPDATE storage_state SET revision=revision+1 WHERE id=1 RETURNING revision").get()!.revision);
}
function insertEntry(db: DatabaseSync, key: string, bytes: Uint8Array, createOnly: boolean) {
  const existing = db.prepare("SELECT preserved FROM entries WHERE path=?").get(key);
  if (existing && (createOnly || existing.preserved === 1)) throw failure("EEXIST");
  if (existing) db.prepare("DELETE FROM entries WHERE path=? AND preserved=0").run(key);
  const hash = createHash("sha256").update(bytes).digest("hex");
  db.prepare("INSERT INTO entries(path,byte_length,sha256,revision,preserved) VALUES(?,?,?,?,0)").run(key, bytes.byteLength, hash, nextRevision(db));
  const insert = db.prepare("INSERT INTO chunks VALUES(?,?,?)");
  for (let offset = 0, index = 0; offset < bytes.byteLength; offset += STORAGE_CHUNK_BYTES, index++) {
    insert.run(key, index, bytes.subarray(offset, offset + STORAGE_CHUNK_BYTES));
  }
}
function sourceSignature(files: LegacyFile[]): string {
  return files.map(({key,stat}) => [key,stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs].join(":" )).join("\n");
}
async function legacyFiles(root: string, includePluginData = true): Promise<LegacyFile[]> {
  const output: LegacyFile[] = [];
  const visit = async (file: string, key: string, preserved = false, expected?: "file" | "directory"): Promise<void> => {
    let stat;
    try { stat = await fs.lstat(file); } catch (error) { if (isMissingFileError(error)) return; throw error; }
    if (stat.isSymbolicLink() || !owned(stat)) throw new StorageDatabaseError();
    if ((expected === "file" && !stat.isFile()) || (expected === "directory" && !stat.isDirectory())) throw new StorageDatabaseError();
    if (stat.isDirectory()) {
      for (const name of (await fs.readdir(file)).sort()) await visit(path.join(file,name),`${key}/${name}`,preserved);
    } else if (stat.isFile() && stat.nlink === 1) output.push({key,file,stat,preserved});
    else throw new StorageDatabaseError();
  };
  for (const name of (await fs.readdir(root)).sort()) {
    if (rootFiles.has(name) || /^live-smith-models-.+\.json$/u.test(name) || /^suno-session-.+\.json$/u.test(name) || roots.has(name)) {
      await visit(path.join(root,name),name,false,roots.has(name) ? "directory" : "file");
    }
  }
  try {
    const plugins = await fs.lstat(path.join(root,"live-smith-plugins"));
    if (!plugins.isDirectory() || plugins.isSymbolicLink() || !owned(plugins)) throw new StorageDatabaseError();
    await visit(path.join(root,"live-smith-plugins/catalog.json"),"live-smith-plugins/catalog.json",false,"file");
    await visit(path.join(root,"live-smith-plugins/packages"),"live-smith-plugins/packages",false,"directory");
    if (includePluginData) await visit(path.join(root,"live-smith-plugins/data"),"live-smith-plugins/data",true,"directory");
  } catch (error) { if (!isMissingFileError(error)) throw error; }
  return output.sort((a,b)=>a.key.localeCompare(b.key,"en"));
}

async function legacyBackupCandidates(root: string): Promise<LegacyFile[]> {
  const files = await legacyFiles(root, false);
  const file = path.join(root, STORAGE_V1_BACKUP_NAME);
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !owned(stat)) throw new StorageDatabaseError();
    files.push({ key: STORAGE_V1_BACKUP_NAME, file, stat, preserved: false });
  } catch (error) { if (!isMissingFileError(error)) throw error; }
  return files.sort((a,b) => a.key.localeCompare(b.key,"en"));
}

function legacySourceFingerprint(file: LegacyFile): string { return sourceSignature([file]); }

async function indexVerifiedLegacySources(db: DatabaseSync, files: LegacyFile[]): Promise<void> {
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='legacy_sources'").get()) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("CREATE TABLE legacy_sources(path TEXT PRIMARY KEY, fingerprint TEXT NOT NULL)");
    const save = db.prepare("INSERT INTO legacy_sources VALUES(?,?)");
    for (const file of files) {
      if (file.key === STORAGE_V1_BACKUP_NAME) {
        let snapshot: DatabaseSync | undefined;
        let verified = false;
        try {
          snapshot = new DatabaseSync(file.file, { readOnly: true });
          if (Number(snapshot.prepare("PRAGMA user_version").get()?.user_version) !== 1 || !readInfo(snapshot)) continue;
          const records = "SELECT path,byte_length,sha256,revision,preserved FROM entries ORDER BY path";
          verified = JSON.stringify(snapshot.prepare(records).all()) === JSON.stringify(db.prepare(records).all());
        } catch { /* Unverified historical files remain outside managed cleanup. */ }
        finally { snapshot?.close(); }
        if (verified) save.run(file.key, legacySourceFingerprint(file));
        continue;
      }
      const entry = db.prepare("SELECT byte_length,sha256 FROM entries WHERE path=? AND preserved=0").get(file.key);
      if (!entry || entry.byte_length !== file.stat.size) continue;
      const handle = await fs.open(file.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => undefined);
      if (!handle) continue;
      let verified = false;
      try {
        const before = await handle.stat();
        if (legacySourceFingerprint({ ...file, stat: before }) !== legacySourceFingerprint(file)) continue;
        const digest = createHash("sha256");
        for (let offset = 0; offset < before.size;) {
          const bytes = Buffer.allocUnsafe(Math.min(STORAGE_CHUNK_BYTES, before.size - offset));
          const read = await handle.read(bytes, 0, bytes.length, offset);
          if (!read.bytesRead) throw new StorageDatabaseError();
          digest.update(bytes.subarray(0, read.bytesRead)); offset += read.bytesRead;
        }
        verified = digest.digest("hex") === entry.sha256 && legacySourceFingerprint({ ...file, stat: await handle.stat() }) === legacySourceFingerprint(file);
      } catch { /* An unreadable source has no deletion proof. */ }
      finally { await handle.close(); }
      if (verified) save.run(file.key, legacySourceFingerprint(file));
    }
    try { db.exec("COMMIT"); } catch (error) { throw new StorageCommitOutcomeUnknownError(error); }
  } catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; }
}

/** Only unchanged files with persisted proof of import are eligible for cleanup. */
export async function listLegacyBackupFiles(directory: string): Promise<LegacyFile[]> {
  await initializeSqliteStorage(directory);
  const root = await privateRoot(directory), files = await legacyBackupCandidates(root);
  const db = connect(await privateDatabase(root));
  try {
    await indexVerifiedLegacySources(db, files);
    const source = db.prepare("SELECT fingerprint FROM legacy_sources WHERE path=?");
    return files.filter(file => source.get(file.key)?.fingerprint === legacySourceFingerprint(file));
  } finally { db.close(); }
}
async function importLegacy(db: DatabaseSync, root: string): Promise<StorageMigrationInfo> {
  const files = await legacyFiles(root);
  const info = { importedFiles: files.length, importedBytes: 0, preservedPluginFiles: files.filter(file=>file.preserved).length };
  db.exec("BEGIN IMMEDIATE");
  try {
    // A different process may have completed the import while this one inspected the source.
    const ready = readInfo(db);
    if (ready) { db.exec("ROLLBACK"); return ready; }
    schema(db);
    const insert = db.prepare("INSERT INTO chunks VALUES(?,?,?)");
    for (const source of files) {
      const handle = await fs.open(source.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== source.stat.dev || opened.ino !== source.stat.ino ||
            opened.size !== source.stat.size || opened.mtimeMs !== source.stat.mtimeMs) throw new StorageDatabaseError();
        db.prepare("INSERT INTO entries(path,byte_length,sha256,revision,preserved) VALUES(?,?,?,?,?)").run(source.key, opened.size, "", nextRevision(db), source.preserved ? 1 : 0);
        const stage = isLegacyMedia(source.key) ? await createMediaStage(root, { expectedByteLength: opened.size }) : undefined;
        const digest = createHash("sha256");
        try {
        for (let offset = 0, index = 0; offset < opened.size; index++) {
          const bytes = Buffer.allocUnsafe(Math.min(STORAGE_CHUNK_BYTES, opened.size-offset));
          let filled = 0;
          while (filled < bytes.length) {
            const {bytesRead} = await handle.read(bytes,filled,bytes.length-filled,offset+filled);
            if (!bytesRead) throw new StorageDatabaseError();
            filled += bytesRead;
          }
          offset += filled; digest.update(bytes);
          if (stage) await stage.append(bytes); else insert.run(source.key,index,bytes);
        }
        const after = await handle.stat();
        if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw new StorageDatabaseError();
        const hash = digest.digest("hex");
        db.prepare("UPDATE entries SET sha256=? WHERE path=?").run(hash,source.key);
        if (!source.preserved) db.prepare("INSERT INTO legacy_sources VALUES(?,?)").run(source.key, legacySourceFingerprint(source));
        if (stage) {
          const identity = await stage.finish();
          if (identity.sha256 !== hash) throw new StorageDatabaseError();
          await stage.publish(identity);
          await verifyMediaObject(root, identity);
          db.prepare("UPDATE entries SET media_object=? WHERE path=?").run(hash,source.key);
          info.importedBytes += identity.byteLength;
        } else {
        const verified = createHash("sha256"); let length = 0;
        for (const row of db.prepare("SELECT bytes FROM chunks WHERE path=? ORDER BY chunk_index").iterate(source.key)) {
          const bytes = row.bytes as Uint8Array; verified.update(bytes); length += bytes.byteLength;
        }
        if (length !== opened.size || verified.digest("hex") !== hash) throw new StorageDatabaseError();
        info.importedBytes += length;
        }
        } finally { await stage?.abort(); }
      } finally { await handle.close(); }
    }
    if (sourceSignature(await legacyFiles(root)) !== sourceSignature(files)) throw new StorageDatabaseError();
    if (db.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok") throw new StorageDatabaseError();
    db.prepare("UPDATE storage_state SET migrated=1,imported_files=?,imported_bytes=?,preserved_plugin_files=? WHERE id=1")
      .run(info.importedFiles,info.importedBytes,info.preservedPluginFiles);
    try { db.exec("COMMIT"); } catch (error) { throw new StorageCommitOutcomeUnknownError(error); }
    return info;
  } catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; }
}
export async function initializeSqliteStorage(directory: string): Promise<StorageMigrationInfo> {
  try {
    const root = await privateRoot(directory);
    const existing = initializing.get(root);
    if (existing) return await existing;
    const preparation = (async () => {
      const file = await privateDatabase(root); const db = connect(file);
      try {
        const info = readInfo(db);
        if(!recovered.has(root))await cleanupMediaStages(root);
        if (info && Number(db.prepare("PRAGMA user_version").get()?.user_version) === 1) await upgradeMedia(db, root);
        const result=info ?? await importLegacy(db,root);
        if(!recovered.has(root)) {
          await collectMediaFiles(db,root);
          recovered.add(root);
        }
        return result;
      } finally { db.close(); }
    })();
    initializing.set(root,preparation);
    try { return await preparation; } finally { if(initializing.get(root)===preparation) initializing.delete(root); }
  } catch (error) { if(error instanceof StorageDatabaseError || error instanceof StorageCommitOutcomeUnknownError)throw error; throw new StorageDatabaseError(error); }
}
async function connection(directory: string): Promise<DatabaseSync> {
  await initializeSqliteStorage(directory);
  return connect(await privateDatabase(await privateRoot(directory)));
}
export async function withStorageDatabase<T>(directory: string, operation: (db: DatabaseSync)=>T): Promise<T> {
  const db=await connection(directory);
  try {return operation(db);} finally {db.close();}
}
function entryFrom(row: Record<string, unknown>): StoredEntry {
  return {key:String(row.path),byteLength:Number(row.byte_length),sha256:String(row.sha256),revision:Number(row.revision)};
}
export async function storedEntry(directory:string,key:string):Promise<StoredEntry|undefined> {
  const normalized=keyOf(directory,key);
  return withStorageDatabase(directory,db=>{const row=db.prepare("SELECT * FROM entries WHERE path=? AND preserved=0").get(normalized);return row?entryFrom(row):undefined;});
}
export async function listStoredEntries(directory:string,prefix=""):Promise<StoredEntry[]> {
  const key=keyOf(directory,prefix,true);
  return withStorageDatabase(directory, db => {
    const rows = key
      ? db.prepare("SELECT * FROM entries WHERE preserved=0 AND (path=? OR (path>=? AND path<?)) ORDER BY path")
        .all(key, `${key}/`, `${key}0`)
      : db.prepare("SELECT * FROM entries WHERE preserved=0 ORDER BY path").all();
    return rows.map(entryFrom);
  });
}
export async function listStoredChildren(directory:string,prefix=""):Promise<string[]> {
  const key=keyOf(directory,prefix,true);
  const entries=await listStoredEntries(directory,key);
  return [...new Set(entries.filter(entry=>entry.key!==key).map(entry=>entry.key.slice(key?key.length+1:0).split("/")[0]!))].sort();
}
export async function storedTreeExists(directory:string,prefix:string):Promise<boolean> {
  const key=keyOf(directory,prefix,true);
  return withStorageDatabase(directory, db => Boolean(key
    ? db.prepare("SELECT 1 FROM entries WHERE preserved=0 AND (path=? OR (path>=? AND path<?)) LIMIT 1")
      .get(key, `${key}/`, `${key}0`)
    : db.prepare("SELECT 1 FROM entries WHERE preserved=0 LIMIT 1").get()));
}
export interface StoredRangeReader {
  entry: StoredEntry;
  readRange(offset: number, length: number): Promise<Buffer>;
  close(): Promise<void>;
}
export interface StoredFileWriter {
  readonly byteLength: number;
  append(bytes: Uint8Array): Promise<void>;
  readRange(offset: number, length: number): Promise<Buffer>;
  publish(key: string, options?: { createOnly?: boolean }): Promise<StoredEntry>;
  abort(): Promise<void>;
}
interface ReaderBinding { db: DatabaseSync; entry: StoredEntry; media: fs.FileHandle | undefined; validate(): void }
async function readerBinding(directory: string, key: string): Promise<ReaderBinding> {
  const normalized = keyOf(directory,key);
  const db = await connection(directory);
  let media: fs.FileHandle | undefined;
  try {
    const row = db.prepare("SELECT * FROM entries WHERE path=? AND preserved=0").get(normalized);
    if (!row) throw failure("ENOENT");
    const entry = entryFrom(row);
    if (row.media_object !== null) {
      if (row.media_object !== entry.sha256) throw new StorageDatabaseError();
      media = await openMediaObject(await privateRoot(directory), entry);
    }
    const current = db.prepare("SELECT revision FROM entries WHERE path=? AND preserved=0");
    const validate = () => { if (current.get(normalized)?.revision !== entry.revision) throw new StorageDatabaseError(); };
    validate();
    return { db,entry,media,validate };
  } catch (error) { await media?.close(); db.close(); throw error; }
}
function inlineChunk(binding: ReaderBinding, index: number): Buffer {
  const {db,entry} = binding;
  if (index * STORAGE_CHUNK_BYTES >= entry.byteLength) return Buffer.alloc(0);
  const row = db.prepare("SELECT bytes FROM chunks WHERE path=? AND chunk_index=?").get(entry.key,index);
  if (!row) throw new StorageDatabaseError();
  const bytes = Buffer.from(row.bytes as Uint8Array);
  if (bytes.length !== Math.min(STORAGE_CHUNK_BYTES,entry.byteLength-index*STORAGE_CHUNK_BYTES)) throw new StorageDatabaseError();
  return bytes;
}
export async function openStoredReader(directory:string,key:string):Promise<StoredContentReader> {
  const binding = await readerBinding(directory,key);
  let closed = false;
  return { entry:binding.entry, readChunk(index) {
    if (closed || !Number.isSafeInteger(index) || index < 0) throw new StorageDatabaseError();
    binding.validate();
    if (!binding.media) return inlineChunk(binding,index);
    const offset = index * STORAGE_CHUNK_BYTES;
    const bytes = Buffer.allocUnsafe(Math.max(0,Math.min(STORAGE_CHUNK_BYTES,binding.entry.byteLength-offset)));
    let filled=0;
    while (filled < bytes.length) {
      const count=readSync(binding.media.fd,bytes,filled,bytes.length-filled,offset+filled);
      if (!count) throw new StorageDatabaseError();
      filled+=count;
    }
    binding.validate();
    return bytes;
  }, close() { if (!closed) { closed=true; void binding.media?.close(); binding.db.close(); } } };
}
export async function openStoredRangeReader(directory:string,key:string):Promise<StoredRangeReader> {
  const binding=await readerBinding(directory,key);
  let closed=false;
  return {entry:binding.entry, async readRange(offset,length) {
    if (closed || !Number.isSafeInteger(offset) || offset<0 || !Number.isSafeInteger(length) || length<0 || length>STORAGE_CHUNK_BYTES || offset>binding.entry.byteLength) throw new StorageDatabaseError();
    binding.validate();
    const count=Math.min(length,binding.entry.byteLength-offset);
    let bytes:Buffer;
    if (binding.media) bytes=await readMediaRange(binding.media,offset,count);
    else {
      bytes=Buffer.allocUnsafe(count);
      let filled=0;
      while(filled<count) {
        const position=offset+filled;
        const chunk=inlineChunk(binding,Math.floor(position/STORAGE_CHUNK_BYTES));
        const copied=chunk.copy(bytes,filled,position%STORAGE_CHUNK_BYTES,Math.min(chunk.length,position%STORAGE_CHUNK_BYTES+count-filled));
        filled+=copied;
      }
    }
    binding.validate();
    return bytes;
  }, async close() { if (!closed) { closed=true; await binding.media?.close(); binding.db.close(); } } };
}
export async function readStoredBytes(directory:string,key:string):Promise<Buffer> {
  const reader=await openStoredRangeReader(directory,key);
  try {
    const bytes=Buffer.allocUnsafe(reader.entry.byteLength);const digest=createHash("sha256");
    for(let offset=0;offset<bytes.length;) {
      const chunk=await reader.readRange(offset,Math.min(STORAGE_CHUNK_BYTES,bytes.length-offset));
      digest.update(chunk);chunk.copy(bytes,offset);offset+=chunk.length;
    }
    await reader.readRange(bytes.length,0);
    if(digest.digest("hex")!==reader.entry.sha256)throw new StorageDatabaseError();
    return bytes;
  } finally {await reader.close();}
}
export async function readStoredText(directory:string,key:string):Promise<string> {return (await readStoredBytes(directory,key)).toString("utf8");}
export async function writeStoredBytes(directory:string,key:string,bytes:Uint8Array,options:{createOnly?:boolean;storage?:"file"}={}):Promise<void> {
  if (options.storage === "file") {
    const writer=await createStoredFileWriter(directory,{expectedByteLength:bytes.byteLength});
    try { await writer.append(bytes); await writer.publish(key,options); } finally { await writer.abort(); }
    return;
  }
  const normalized=keyOf(directory,key);
  await mutate(directory,async()=>{
    const old=await withStorageDatabase(directory,db=>db.prepare("SELECT media_object FROM entries WHERE path=?").get(normalized)?.media_object);
    await withStorageDatabase(directory,db=>transaction(db,()=>insertEntry(db,normalized,bytes,options.createOnly===true)));
    await collectMedia(directory,old?[String(old)]:[]);
  });
}
export async function writeStoredJson(directory:string,key:string,value:unknown,options:{createOnly?:boolean}={}):Promise<void> {
  const json=JSON.stringify(value,null,2);if(json===undefined)throw new TypeError("Storage value is not JSON serializable.");
  return writeStoredBytes(directory,key,Buffer.from(json),options);
}
export async function removeStoredEntry(directory:string,key:string):Promise<boolean> {
  const normalized=keyOf(directory,key);
  return mutate(directory,async()=>{
    const old=await withStorageDatabase(directory,db=>db.prepare("SELECT media_object FROM entries WHERE path=? AND preserved=0").get(normalized)?.media_object);
    const removed=await withStorageDatabase(directory,db=>transaction(db,()=>Number(db.prepare("DELETE FROM entries WHERE path=? AND preserved=0").run(normalized).changes)>0));
    await collectMedia(directory,old?[String(old)]:[]);return removed;
  });
}
export async function removeStoredTree(directory:string,prefix:string):Promise<number> {
  const key=keyOf(directory,prefix);
  return mutate(directory,async()=>{
    const old=await withStorageDatabase(directory,db=>db.prepare("SELECT DISTINCT media_object FROM entries WHERE preserved=0 AND media_object IS NOT NULL AND (path=? OR (path>=? AND path<?))")
      .all(key,`${key}/`,`${key}0`).map(row=>String(row.media_object)));
    const removed=await withStorageDatabase(directory,db=>transaction(db,()=>Number(db.prepare("DELETE FROM entries WHERE preserved=0 AND (path=? OR (path>=? AND path<?))")
      .run(key, `${key}/`, `${key}0`).changes)));
    await collectMedia(directory,old);return removed;
  });
}
function registerMedia(db:DatabaseSync,key:string,identity:{byteLength:number;sha256:string},createOnly:boolean):StoredEntry {
  const existing=db.prepare("SELECT preserved FROM entries WHERE path=?").get(key);
  if(existing && (createOnly || existing.preserved===1))throw failure("EEXIST");
  if(existing)db.prepare("DELETE FROM entries WHERE path=?").run(key);
  const revision=nextRevision(db);
  db.prepare("INSERT INTO entries(path,byte_length,sha256,revision,preserved,media_object) VALUES(?,?,?,?,0,?)")
    .run(key,identity.byteLength,identity.sha256,revision,identity.sha256);
  return {key,byteLength:identity.byteLength,sha256:identity.sha256,revision};
}
export async function createStoredFileWriter(directory:string,expected:{expectedByteLength?:number;expectedSha256?:string}={}):Promise<StoredFileWriter> {
  await initializeSqliteStorage(directory);
  const root=await privateRoot(directory);
  const stage=await createMediaStage(root,expected);
  let publishing=false;
  return {
    get byteLength(){return stage.byteLength;},
    append(bytes){if(publishing)return Promise.reject(new StorageDatabaseError());return stage.append(bytes);},
    readRange(offset,length){if(publishing)return Promise.reject(new StorageDatabaseError());return stage.readRange(offset,length);},
    publish(key,options={}) {
      if(publishing)return Promise.reject(new StorageDatabaseError());
      const normalized=keyOf(directory,key);publishing=true;
      return mutate(root,async()=>{
        const cleanup:string[]=[];
        try {
          const identity=await stage.finish();
          const existing=await storedEntry(root,normalized);
          if(options.createOnly && existing)throw failure("EEXIST");
          const old=await withStorageDatabase(root,db=>db.prepare("SELECT media_object FROM entries WHERE path=?").get(normalized)?.media_object);
          if(old)cleanup.push(String(old));
          cleanup.push(identity.sha256);
          await stage.publish(identity);
          return await withStorageDatabase(root,db=>transaction(db,()=>registerMedia(db,normalized,identity,options.createOnly===true)));
        } finally {await stage.abort();await collectMedia(root,cleanup);}
      });
    },
    abort(){return stage.abort();},
  };
}
export async function copyStoredReference(directory:string,sourceKey:string,targetKey:string,options:{createOnly?:boolean}={}):Promise<StoredEntry> {
  const source=keyOf(directory,sourceKey),target=keyOf(directory,targetKey);
  const sourceStorage=await withStorageDatabase(directory,db=>db.prepare("SELECT media_object FROM entries WHERE path=? AND preserved=0").get(source));
  if(!sourceStorage)throw failure("ENOENT");
  if(sourceStorage.media_object===null) {
    const reader=await openStoredRangeReader(directory,source);
    const writer=await createStoredFileWriter(directory,{expectedByteLength:reader.entry.byteLength,expectedSha256:reader.entry.sha256});
    try {
      for(let offset=0;offset<reader.entry.byteLength;offset+=STORAGE_CHUNK_BYTES)await writer.append(await reader.readRange(offset,Math.min(STORAGE_CHUNK_BYTES,reader.entry.byteLength-offset)));
      await reader.readRange(reader.entry.byteLength,0);
      return await writer.publish(target,options);
    }finally{await reader.close();await writer.abort();}
  }
  return mutate(directory,async()=>{
    const sourceEntry=await storedEntry(directory,source);
    if(!sourceEntry)throw failure("ENOENT");
    const media=await withStorageDatabase(directory,db=>db.prepare("SELECT media_object FROM entries WHERE path=? AND preserved=0").get(source)?.media_object);
    if(!media)throw new StorageDatabaseError();
    const handle=await openMediaObject(await privateRoot(directory),sourceEntry);await handle.close();
    const old=await withStorageDatabase(directory,db=>db.prepare("SELECT media_object FROM entries WHERE path=?").get(target)?.media_object);
    const copied=await withStorageDatabase(directory,db=>transaction(db,()=>{
      if(db.prepare("SELECT revision FROM entries WHERE path=? AND preserved=0").get(source)?.revision!==sourceEntry.revision)throw new StorageDatabaseError();
      return registerMedia(db,target,sourceEntry,options.createOnly===true);
    }));
    await collectMedia(directory,old?[String(old)]:[]);return copied;
  });
}
async function collectMediaFiles(db:DatabaseSync,root:string,candidates?:string[]):Promise<void> {
  const directory=await mediaDirectory(root);
  const names=candidates ?? await fs.readdir(directory);
  const referenced=db.prepare("SELECT 1 FROM entries WHERE media_object=? LIMIT 1");
  for(const name of new Set(names))if(/^[a-f0-9]{64}$/u.test(name) && !referenced.get(name)) {
    const file=mediaObjectPath(directory,name);
    let stat;
    try {stat=await fs.lstat(file);}catch(error){if(isMissingFileError(error))continue;throw error;}
    if(!stat.isFile() || stat.isSymbolicLink() || stat.nlink!==1 || !owned(stat))throw new StorageDatabaseError();
    // Metadata already committed; an open reader may keep an orphan locked until the next activation.
    await fs.unlink(file).catch(()=>{});
  }
}
async function collectMedia(directory:string,candidates:string[]):Promise<void> {
  if(!candidates.length)return;
  const root=await privateRoot(directory),db=await connection(root);
  try {await collectMediaFiles(db,root,candidates);}finally{db.close();}
}
function isLegacyMedia(key:string):boolean {
  return /^(?:live-smith-attachments|live-smith-midi|live-smith-audio|live-smith-audio-artifacts)\//u.test(key) &&
    /\.(?:bin|mid|audio)$/u.test(key);
}
async function upgradeMedia(db:DatabaseSync,root:string):Promise<void> {
  const backup=path.join(root,STORAGE_V1_BACKUP_NAME);
  try {
    const stat=await fs.lstat(backup);
    if(!stat.isFile() || stat.isSymbolicLink() || (stat.nlink!==1 && stat.nlink!==2) || !owned(stat))throw new StorageDatabaseError();
    const check=new DatabaseSync(backup,{readOnly:true});
    try {if(Number(check.prepare("PRAGMA user_version").get()?.user_version)!==1 || !readInfo(check))throw new StorageDatabaseError();}finally{check.close();}
    if(stat.nlink===2) {
      let repaired=false;
      for(const name of await fs.readdir(root))if(/^\.sqlite-v1-backup-[a-f0-9-]{36}$/u.test(name)) {
        if(await recoverPublicationPair(path.join(root,name),backup)){repaired=true;break;}
      }
      if(!repaired)throw new StorageDatabaseError();
    }
  } catch(error) {
    if(!isMissingFileError(error))throw error;
    const temporary=path.join(root,`.sqlite-v1-backup-${randomUUID()}`);
    try {
      await backupDatabase(db,temporary);
      await fs.chmod(temporary,0o400);
      await fs.link(temporary,backup);
    }finally{await fs.rm(temporary,{force:true});}
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    if(Number(db.prepare("PRAGMA user_version").get()?.user_version)===SCHEMA_VERSION){db.exec("ROLLBACK");return;}
    db.exec("ALTER TABLE entries ADD COLUMN media_object TEXT; CREATE INDEX entries_media_object ON entries(media_object) WHERE media_object IS NOT NULL;");
    const entries=db.prepare("SELECT path,byte_length,sha256 FROM entries WHERE preserved=0").all();
    for(const row of entries) {
      const key=String(row.path);if(!isLegacyMedia(key))continue;
      const stage=await createMediaStage(root,{expectedByteLength:Number(row.byte_length),expectedSha256:String(row.sha256)});
      try {
        let index=0;
        for(const chunk of db.prepare("SELECT chunk_index,bytes FROM chunks WHERE path=? ORDER BY chunk_index").iterate(key)) {
          if(chunk.chunk_index!==index++)throw new StorageDatabaseError();
          await stage.append(chunk.bytes as Uint8Array);
        }
        const identity=await stage.finish();await stage.publish(identity);await verifyMediaObject(root,identity);
        db.prepare("UPDATE entries SET media_object=? WHERE path=?").run(identity.sha256,key);
        db.prepare("DELETE FROM chunks WHERE path=?").run(key);
      }finally{await stage.abort();}
    }
    db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
    try {db.exec("COMMIT");}catch(error){throw new StorageCommitOutcomeUnknownError(error);}
  }catch(error){try{db.exec("ROLLBACK");}catch{}throw error;}
  const candidates: LegacyFile[] = await legacyBackupCandidates(root).catch(() => []);
  if (!candidates.some(file => file.key === STORAGE_V1_BACKUP_NAME)) candidates.push({ key: STORAGE_V1_BACKUP_NAME, file: backup, stat: await fs.lstat(backup), preserved: false });
  await indexVerifiedLegacySources(db, candidates);
}
