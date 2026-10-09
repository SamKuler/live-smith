import { uiMessage, UiMessageError } from "../i18n/ui-message.js";
import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { allocateArtifactVersion, isArtifactLabel } from "../agent/artifact-contracts.js";
import { isDeviceParameterApplication, isDeviceParameterArtifact, isDeviceParameterSnapshot, MAX_DEVICE_PARAMETERS,
  sameParameterLayout, type DeviceParameterApplication, type DeviceParameterArtifact, type DeviceParameterSnapshot } from "../agent/device-parameter-contracts.js";
import { cloneJsonValue } from "../model/json-clone.js";
import { throwIfAborted } from "../runtime/host.js";
import { isMissingFileError } from "./errors.js";
import { createStorageId, isSafeStorageId, requireSafeStorageId } from "./id.js";
import { ensurePrivateDirectoryDurably, removeDirectoryDurably, withStorageTransaction, writeJsonAtomically, writeJsonAtomicallyCreateOnly } from "./persistence.js";
import { listSessions, persistTransientSessionInTransaction } from "./sessions.js";

const rootName = "live-smith-device-parameters";
export const MAX_PARAMETER_ARTIFACT_BYTES = 4 * 1024 * 1024;
export const MAX_PARAMETER_SESSION_BYTES = 64 * 1024 * 1024;
export const MAX_PARAMETER_ARTIFACTS = 64;
const maxApplications = 256;

async function sessionDirectory(storageDirectory: string, sessionId: string, create = false): Promise<string> {
  if (!path.isAbsolute(storageDirectory)) throw new UiMessageError(uiMessage("Parameter artifact storage is unavailable."));
  requireSafeStorageId(sessionId, "Session ID");
  const root = path.join(storageDirectory, rootName);
  const directory = path.join(root, sessionId);
  for (const target of [storageDirectory, root, directory]) {
    try {
      const stat = await fs.lstat(target);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new UiMessageError(uiMessage("Parameter artifact directory is invalid."));
    } catch (error) { if (!isMissingFileError(error)) throw error; if (!create) return directory; await ensurePrivateDirectoryDurably(target); }
  }
  return directory;
}

async function readJson(file: string, maximum: number): Promise<unknown> {
  const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximum) throw new UiMessageError(uiMessage("Parameter artifact file is invalid or too large."));
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.nlink > 1 || stat.size > maximum) throw new UiMessageError(uiMessage("Parameter artifact file is invalid or changed while opening."));
    const bytes = Buffer.alloc(stat.size + 1);
    let bytesRead = 0;
    while (bytesRead < bytes.length) {
      const chunk = await handle.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
      if (!chunk.bytesRead) break;
      bytesRead += chunk.bytesRead;
    }
    if (bytesRead !== stat.size) throw new UiMessageError(uiMessage("Parameter artifact file changed while reading."));
    try { return JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")); }
    catch { throw new UiMessageError(uiMessage("Saved device parameter data is invalid.")); }
  } finally { await handle.close(); }
}

async function requireSession(storageDirectory: string, sessionId: string): Promise<void> {
  if (!(await listSessions(storageDirectory)).some((entry) => entry.id === sessionId && !entry.archivedAt)) {
    throw new UiMessageError(uiMessage("That Session is not available for device parameters."));
  }
}

async function readArtifacts(directory: string, sessionId: string): Promise<DeviceParameterArtifact[]> {
  let entries: string[];
  try { entries = await fs.readdir(directory); } catch (error) { if (isMissingFileError(error)) return []; throw error; }
  const result: DeviceParameterArtifact[] = [];
  for (const name of entries.filter((name) => name.startsWith("parameters_") && name.endsWith(".json")).sort()) {
    const value = await readJson(path.join(directory, name), MAX_PARAMETER_ARTIFACT_BYTES);
    if (!isDeviceParameterArtifact(value) || value.sessionId !== sessionId || `${value.id}.json` !== name) {
      throw new UiMessageError(uiMessage("Saved device parameter data is invalid. No versions were changed."));
    }
    result.push(value);
  }
  return result;
}

export async function listDeviceParameterArtifacts(storageDirectory: string | undefined, sessionId: string): Promise<DeviceParameterArtifact[]> {
  if (!storageDirectory) return [];
  return withStorageTransaction(storageDirectory, async () => {
    await requireSession(storageDirectory, sessionId);
    return readArtifacts(await sessionDirectory(storageDirectory, sessionId), sessionId);
  });
}

export async function readDeviceParameterArtifact(storageDirectory: string | undefined, sessionId: string, artifactId: string): Promise<DeviceParameterArtifact> {
  if (!storageDirectory) throw new UiMessageError(uiMessage("Device parameter storage is unavailable."));
  requireSafeStorageId(artifactId, "Artifact ID");
  await requireSession(storageDirectory, sessionId);
  try {
    const directory = await sessionDirectory(storageDirectory, sessionId);
    const artifact = await readJson(path.join(directory, `${artifactId}.json`), MAX_PARAMETER_ARTIFACT_BYTES);
    if (!isDeviceParameterArtifact(artifact) || artifact.id !== artifactId || artifact.sessionId !== sessionId) throw new UiMessageError(uiMessage("Invalid parameter artifact."));
    return artifact;
  } catch { throw new UiMessageError(uiMessage("That saved device parameter artifact is unavailable or invalid. Choose an existing version from this Session.")); }
}

export async function saveDeviceParameterArtifact(storageDirectory: string, sessionId: string, input: DeviceParameterSnapshot & {
  label: string; source: DeviceParameterArtifact["source"]; revisionOf?: string; signal: AbortSignal;
}): Promise<DeviceParameterArtifact> {
  if (!isArtifactLabel(input.label) || !isDeviceParameterSnapshot({ target: input.target, parameters: input.parameters }) ||
      input.revisionOf !== undefined && !isSafeStorageId(input.revisionOf)) throw new UiMessageError(uiMessage("Device parameter snapshot is invalid."));
  const snapshot = cloneJsonValue({ target: input.target, parameters: input.parameters, source: input.source });
  return withStorageTransaction(storageDirectory, async (transaction) => {
    throwIfAborted(input.signal);
    await requireSession(storageDirectory, sessionId);
    await persistTransientSessionInTransaction(transaction, storageDirectory, sessionId);
    const directory = await sessionDirectory(storageDirectory, sessionId, true);
    const records = await readArtifacts(directory, sessionId);
    const base = input.revisionOf ? records.find((entry) => entry.id === input.revisionOf) : undefined;
    if (input.revisionOf && (!base || !sameParameterLayout(base.parameters, snapshot.parameters) ||
        JSON.stringify(base.target) !== JSON.stringify(snapshot.target))) throw new UiMessageError(uiMessage("Choose a source snapshot of the same device and parameter layout."));
    const id = createStorageId("parameters");
    const artifact: DeviceParameterArtifact = { ...snapshot, id, sessionId, label: input.label, createdAt: new Date().toISOString(),
      version: allocateArtifactVersion(id, records, input.revisionOf ? { revisionOf: input.revisionOf } : {}) };
    const bytes = Buffer.byteLength(JSON.stringify(artifact, null, 2));
    if (!isDeviceParameterArtifact(artifact) || bytes > MAX_PARAMETER_ARTIFACT_BYTES) throw new UiMessageError(uiMessage("Device parameter snapshot exceeds its storage limit."));
    if (records.length >= MAX_PARAMETER_ARTIFACTS || records.reduce((sum, value) => sum + Buffer.byteLength(JSON.stringify(value, null, 2)), bytes) > MAX_PARAMETER_SESSION_BYTES) {
      throw new UiMessageError(uiMessage("This Session has reached its device parameter storage limit."));
    }
    throwIfAborted(input.signal);
    await writeJsonAtomicallyCreateOnly(path.join(directory, `${id}.json`), artifact);
    return cloneJsonValue(artifact);
  });
}

export async function listDeviceParameterApplications(storageDirectory: string | undefined, sessionId: string): Promise<DeviceParameterApplication[]> {
  if (!storageDirectory) return [];
  const directory = await sessionDirectory(storageDirectory, sessionId);
  const root = path.join(directory, "applications");
  const ids = await applicationIds(root);
  const result: DeviceParameterApplication[] = [];
  for (const id of ids) result.push(await readApplication(path.join(root, id), sessionId, id));
  return result.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

type ApplicationEntry = DeviceParameterApplication["entries"][number];
type EntryProgress = Pick<ApplicationEntry, "state" | "after"> & { index: number };
const progressKeys = ["index", "state", "after"];
function isEntryProgress(value: unknown): value is EntryProgress {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return Object.keys(entry).every((key) => progressKeys.includes(key)) && Number.isSafeInteger(entry.index) && Number(entry.index) >= 0 && Number(entry.index) < MAX_DEVICE_PARAMETERS &&
    ["pending", "applying", "applied", "restoring", "restored", "conflict"].includes(String(entry.state)) &&
    (entry.after === undefined || typeof entry.after === "number" && Number.isFinite(entry.after));
}
const entryProgress = (entry: ApplicationEntry): EntryProgress => ({ index: entry.parameter.index, state: entry.state, ...(entry.after === undefined ? {} : { after: entry.after }) });

async function assertDirectory(directory: string): Promise<void> {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new UiMessageError(uiMessage("Parameter application directory is invalid."));
}
async function applicationIds(root: string): Promise<string[]> {
  try {
    await assertDirectory(root);
    const ids = (await fs.readdir(root, { withFileTypes: true })).filter((entry) => entry.name.endsWith(".json") && isSafeStorageId(entry.name.slice(0, -5))).map((entry) => entry.name.slice(0, -5));
    if (ids.length > maxApplications) throw new UiMessageError(uiMessage("Parameter application history exceeds its limit."));
    return ids.sort();
  } catch (error) { if (isMissingFileError(error)) return []; throw error; }
}

async function readBaseline(directory: string, sessionId: string, id: string): Promise<{ application: DeviceParameterApplication; reservedBytes: number }> {
  await assertDirectory(directory);
  const value = await readJson(path.join(path.dirname(directory), `${id}.json`), MAX_PARAMETER_SESSION_BYTES) as { application?: unknown; reservedBytes?: unknown };
  if (!value || !isDeviceParameterApplication(value.application) || value.application.sessionId !== sessionId || value.application.id !== id ||
      typeof value.reservedBytes !== "number" || value.reservedBytes !== applicationReservation(value.application)) throw new UiMessageError(uiMessage("Parameter application baseline is invalid."));
  return { application: value.application, reservedBytes: value.reservedBytes };
}

async function readApplication(directory: string, sessionId: string, id: string): Promise<DeviceParameterApplication> {
  await assertDirectory(directory);
  try {
    const completed = await readJson(path.join(directory, "result.json"), MAX_PARAMETER_SESSION_BYTES);
    if (!isDeviceParameterApplication(completed) || completed.sessionId !== sessionId || completed.id !== id || !["kept", "restored"].includes(completed.status)) throw new UiMessageError(uiMessage("Parameter application result is invalid."));
    return completed;
  } catch (error) { if (!isMissingFileError(error)) throw error; }
  const { application } = await readBaseline(directory, sessionId, id);
  try {
    const state = await readJson(path.join(directory, "state.json"), MAX_PARAMETER_SESSION_BYTES) as Pick<DeviceParameterApplication, "status" | "restorationBaseline">;
    if (!state || Object.keys(state).some((key) => !["status", "restorationBaseline"].includes(key))) throw new UiMessageError(uiMessage("Parameter application state is invalid."));
    application.status = state.status;
    if (state.restorationBaseline !== undefined) application.restorationBaseline = state.restorationBaseline;
  } catch (error) { if (!isMissingFileError(error)) throw error; }
  const entries = new Map(application.entries.map((entry) => [entry.parameter.index, entry]));
  const files = (await fs.readdir(directory)).filter((name) => /^parameter-\d+\.json$/u.test(name));
  for (let offset = 0; offset < files.length; offset += 16) {
    const progress = await Promise.all(files.slice(offset, offset + 16).map(async (name) => {
      const value = await readJson(path.join(directory, name), 512);
      if (!isEntryProgress(value) || name !== `parameter-${value.index}.json`) throw new UiMessageError(uiMessage("Parameter application progress is invalid."));
      return value;
    }));
    for (const item of progress) {
      const entry = entries.get(item.index); if (!entry) throw new UiMessageError(uiMessage("Parameter application progress has no baseline."));
      entry.state = item.state;
      if (item.after === undefined) delete entry.after; else entry.after = item.after;
    }
  }
  if (!isDeviceParameterApplication(application)) throw new UiMessageError(uiMessage("Parameter application history is invalid."));
  return application;
}

function applicationReservation(application: DeviceParameterApplication): number {
  // Baseline, optional restore baseline, terminal result, and one small progress file per parameter.
  return Buffer.byteLength(JSON.stringify(application, null, 2)) * 4 + application.entries.length * 512;
}

function applicationIdentity(application: DeviceParameterApplication): string {
  return JSON.stringify({ id: application.id, sessionId: application.sessionId, artifactId: application.artifactId,
    artifactLabel: application.artifactLabel, artifactVersion: application.artifactVersion,
    createdAt: application.createdAt, target: application.target, entries: application.entries.map(({ parameter, requested }) => ({ parameter, requested })) });
}

/** Save immutable before values once. Updates replace only changed progress and operation state. */
export async function saveDeviceParameterApplication(storageDirectory: string, application: DeviceParameterApplication): Promise<void> {
  if (!isDeviceParameterApplication(application)) throw new UiMessageError(uiMessage("Device parameter application receipt is invalid."));
  const saved = cloneJsonValue(application);
  await withStorageTransaction(storageDirectory, async (transaction) => {
    await requireSession(storageDirectory, saved.sessionId);
    await persistTransientSessionInTransaction(transaction, storageDirectory, saved.sessionId);
    const root = path.join(await sessionDirectory(storageDirectory, saved.sessionId, true), "applications");
    try { await assertDirectory(root); } catch (error) { if (!isMissingFileError(error)) throw error; await ensurePrivateDirectoryDurably(root); }
    const directory = path.join(root, saved.id);
    const ids = await applicationIds(root);
    if (!ids.includes(saved.id)) {
      const reservedBytes = applicationReservation(saved);
      let reserved = reservedBytes;
      for (const id of ids) reserved += (await readBaseline(path.join(root, id), saved.sessionId, id)).reservedBytes;
      if (ids.length >= maxApplications || reserved > MAX_PARAMETER_SESSION_BYTES) throw new UiMessageError(uiMessage("This Session has reached its parameter application history limit."));
      try { await assertDirectory(directory); } catch (error) { if (!isMissingFileError(error)) throw error; await ensurePrivateDirectoryDurably(directory); }
      await writeJsonAtomicallyCreateOnly(path.join(root, `${saved.id}.json`), { application: saved, reservedBytes });
      return;
    }
    const baseline = await readBaseline(directory, saved.sessionId, saved.id);
    if (applicationIdentity(baseline.application) !== applicationIdentity(saved)) throw new UiMessageError(uiMessage("A parameter application baseline cannot be changed."));
    const previous = await readApplication(directory, saved.sessionId, saved.id);
    if (previous.status === "kept" || previous.status === "restored") {
      if (JSON.stringify(previous) !== JSON.stringify(saved)) throw new UiMessageError(uiMessage("A completed parameter application cannot be changed."));
      return;
    }
    const previousEntries = new Map(previous.entries.map((entry) => [entry.parameter.index, entry]));
    for (const entry of saved.entries) {
      const before = previousEntries.get(entry.parameter.index)!;
      if (JSON.stringify(entryProgress(entry)) !== JSON.stringify(entryProgress(before))) await writeJsonAtomically(path.join(directory, `parameter-${entry.parameter.index}.json`), entryProgress(entry));
    }
    if (saved.status === "kept" || saved.status === "restored") {
      await writeJsonAtomicallyCreateOnly(path.join(directory, "result.json"), saved);
    } else {
      await writeJsonAtomically(path.join(directory, "state.json"), { status: saved.status, ...(saved.restorationBaseline ? { restorationBaseline: saved.restorationBaseline } : {}) });
    }
  });
}

/** A write-ahead progress record is small even for devices with thousands of parameters. */
export async function saveDeviceParameterProgress(storageDirectory: string, sessionId: string, applicationId: string, progress: EntryProgress): Promise<void> {
  requireSafeStorageId(applicationId, "Parameter application ID");
  if (!isEntryProgress(progress)) throw new UiMessageError(uiMessage("Parameter application progress is invalid."));
  await withStorageTransaction(storageDirectory, async () => {
    const directory = path.join(await sessionDirectory(storageDirectory, sessionId), "applications", applicationId);
    await assertDirectory(path.dirname(directory)); await assertDirectory(directory);
    await writeJsonAtomically(path.join(directory, `parameter-${progress.index}.json`), progress);
  });
}

export async function deleteSessionDeviceParameters(storageDirectory: string | undefined, sessionId: string): Promise<void> {
  if (!storageDirectory) return;
  await withStorageTransaction(storageDirectory, async () => removeDirectoryDurably(await sessionDirectory(storageDirectory, sessionId)));
}

export async function listSessionDeviceParameterDirectoryIds(storageDirectory: string | undefined): Promise<string[]> {
  if (!storageDirectory) return [];
  try { return (await fs.readdir(path.join(storageDirectory, rootName), { withFileTypes: true })).filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && isSafeStorageId(entry.name)).map((entry) => entry.name); }
  catch (error) { if (isMissingFileError(error)) return []; throw error; }
}
