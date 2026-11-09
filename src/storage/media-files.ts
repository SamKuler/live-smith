import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getuid, platform } from "node:process";

export const MEDIA_DIRECTORY_NAME = "live-smith-media";
export const MEDIA_CHUNK_BYTES = 64 * 1024;
const activeStages = new Set<string>();
export interface MediaIdentity { byteLength: number; sha256: string }
export interface MediaStage {
  readonly byteLength: number;
  readRange(offset: number, length: number): Promise<Buffer>;
  append(bytes: Uint8Array): Promise<void>;
  finish(): Promise<MediaIdentity>;
  publish(identity: MediaIdentity): Promise<void>;
  abort(): Promise<void>;
}
function invalid(): Error { return new Error("Saved media content failed validation."); }
export async function mediaDirectory(root: string): Promise<string> {
  const directory = path.join(root, MEDIA_DIRECTORY_NAME);
  await fs.mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (platform !== "win32" && getuid && stat.uid !== getuid())) throw invalid();
  if (platform !== "win32" && (stat.mode & 0o777) !== 0o700) await fs.chmod(directory, 0o700);
  return directory;
}
export function mediaObjectPath(directory: string, hash: string): string {
  if (!/^[a-f0-9]{64}$/u.test(hash)) throw invalid();
  return path.join(directory, hash);
}
export async function openMediaObject(root: string, identity: MediaIdentity): Promise<fs.FileHandle> {
  const directory = await mediaDirectory(root);
  const file = mediaObjectPath(directory, identity.sha256);
  const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || (platform !== "win32" && getuid && before.uid !== getuid())) throw invalid();
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== identity.byteLength || stat.dev !== before.dev || stat.ino !== before.ino) throw invalid();
    return handle;
  } catch (error) { await handle.close(); throw error; }
}
export async function readMediaRange(handle: fs.FileHandle, offset: number, length: number): Promise<Buffer> {
  const bytes = Buffer.allocUnsafe(length);
  let filled = 0;
  while (filled < length) {
    const result = await handle.read(bytes, filled, length - filled, offset + filled);
    if (!result.bytesRead) throw invalid();
    filled += result.bytesRead;
  }
  return bytes;
}
export async function verifyMediaObject(root: string, identity: MediaIdentity): Promise<void> {
  const handle = await openMediaObject(root, identity);
  try {
    const digest = createHash("sha256");
    for (let offset = 0; offset < identity.byteLength; offset += MEDIA_CHUNK_BYTES) {
      digest.update(await readMediaRange(handle, offset, Math.min(MEDIA_CHUNK_BYTES, identity.byteLength - offset)));
    }
    if (digest.digest("hex") !== identity.sha256) throw invalid();
  } finally { await handle.close(); }
}
export async function createMediaStage(root: string, expected: { expectedByteLength?: number; expectedSha256?: string } = {}): Promise<MediaStage> {
  if ((expected.expectedByteLength !== undefined && (!Number.isSafeInteger(expected.expectedByteLength) || expected.expectedByteLength < 0)) ||
      (expected.expectedSha256 !== undefined && !/^[a-f0-9]{64}$/u.test(expected.expectedSha256))) throw invalid();
  const directory = await mediaDirectory(root);
  const file = path.join(directory, `.staging-${randomUUID()}`);
  const handle = await fs.open(file, "wx+", 0o600);
  activeStages.add(file);
  let state: "open" | "finished" | "closed" = "open";
  let byteLength = 0;
  const digest = createHash("sha256");
  let identity: MediaIdentity | undefined;
  let pending = Promise.resolve();
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = pending.then(operation);
    pending = next.then(() => {}, () => {});
    return next;
  };
  const close = async () => { if (state === "open") await handle.close(); state = "closed"; await fs.rm(file, { force: true }); activeStages.delete(file); };
  return {
    get byteLength() { return byteLength; },
    readRange(offset, length) { return serialize(async () => {
      if (state !== "open" || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || length > MEDIA_CHUNK_BYTES || offset > byteLength) throw invalid();
      return readMediaRange(handle, offset, Math.min(length, byteLength - offset));
    }); },
    append(bytes) { return serialize(async () => {
      if (state !== "open") throw invalid();
      if (!Number.isSafeInteger(byteLength + bytes.byteLength) || (expected.expectedByteLength !== undefined && byteLength + bytes.byteLength > expected.expectedByteLength)) {
        await close(); throw invalid();
      }
      try {
        for (let offset = 0; offset < bytes.byteLength; offset += MEDIA_CHUNK_BYTES) {
          const chunk = bytes.subarray(offset, offset + MEDIA_CHUNK_BYTES);
          let written = 0;
          while (written < chunk.byteLength) {
            const result = await handle.write(chunk, written, chunk.byteLength - written, byteLength + written);
            if (!result.bytesWritten) throw invalid();
            written += result.bytesWritten;
          }
          digest.update(chunk); byteLength += chunk.byteLength;
        }
      } catch (error) { await close(); throw error; }
    }); },
    finish() { return serialize(async () => {
      if (state !== "open") throw invalid();
      identity = { byteLength, sha256: digest.digest("hex") };
      await handle.close(); state = "finished";
      if ((expected.expectedByteLength !== undefined && expected.expectedByteLength !== byteLength) ||
          (expected.expectedSha256 !== undefined && expected.expectedSha256 !== identity.sha256)) { await close(); throw invalid(); }
      return identity;
    }); },
    publish(value) { return serialize(async () => {
      if (state !== "finished" || !identity || value.byteLength !== identity.byteLength || value.sha256 !== identity.sha256) throw invalid();
      const target = mediaObjectPath(directory, identity.sha256);
      try {
        // Hard-link publication is create-only; the staging name is removed before any reader opens the object.
        await fs.link(file, target);
        await fs.unlink(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await verifyMediaObject(root, identity);
        await fs.rm(file, { force: true });
      }
      state = "closed"; activeStages.delete(file);
    }); },
    abort() { return serialize(close); },
  };
}

export async function cleanupMediaStages(root: string): Promise<void> {
  const directory = await mediaDirectory(root);
  const names=await fs.readdir(directory);
  for (const name of names) {
    const file = path.join(directory,name);
    if (/^\.staging-[a-f0-9-]{36}$/u.test(name) && !activeStages.has(file)) {
      let stat;
      try {stat=await fs.lstat(file);}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")continue;throw error;}
      if(!stat.isFile() || stat.isSymbolicLink() || (platform!=="win32" && getuid && stat.uid!==getuid()))throw invalid();
      if(stat.nlink===2) {
        let recovered=false;
        for(const object of names.filter(candidate=>/^[a-f0-9]{64}$/u.test(candidate))) {
          if(await recoverPublicationPair(file,mediaObjectPath(directory,object))){recovered=true;break;}
        }
        if(!recovered)throw invalid();
      }else{
        if(stat.nlink!==1)throw invalid();
        await fs.unlink(file).catch(()=>{});
      }
    }
  }
}

/** Complete a create-only publication interrupted between linking and removing its temporary name. */
export async function recoverPublicationPair(temporary:string,published:string):Promise<boolean> {
  let source,target;
  try {source=await fs.lstat(temporary);target=await fs.lstat(published);}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return false;throw error;}
  if(source.dev!==target.dev || source.ino!==target.ino)return false;
  if(!source.isFile() || source.isSymbolicLink() || !target.isFile() || target.isSymbolicLink() || source.nlink!==2 || target.nlink!==2 ||
      (platform!=="win32" && getuid && (source.uid!==getuid() || target.uid!==getuid())))throw invalid();
  await fs.unlink(temporary);
  const after=await fs.lstat(published);
  if(!after.isFile() || after.isSymbolicLink() || after.nlink!==1 || after.dev!==target.dev || after.ino!==target.ino)throw invalid();
  return true;
}
