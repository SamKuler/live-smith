import { uiMessage, UiMessageError } from "../i18n/ui-message.js";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import * as path from "node:path";
import { allocateArtifactVersion, isArtifactLabel } from "../agent/artifact-contracts.js";
import { isDeviceParameterApplication, isDeviceParameterArtifact, isDeviceParameterSnapshot, MAX_DEVICE_PARAMETERS,
  sameParameterLayout, type DeviceParameterApplication, type DeviceParameterArtifact, type DeviceParameterSnapshot } from "../agent/device-parameter-contracts.js";
import { cloneJsonValue } from "../model/json-clone.js";
import { throwIfAborted } from "../runtime/host.js";
import { isMissingFileError } from "./errors.js";
import { createStorageId, isSafeStorageId, requireSafeStorageId } from "./id.js";
import { withStorageTransaction } from "./persistence.js";
import { listStoredChildren, openStoredReader, removeStoredTree, writeStoredJson } from "./sqlite.js";
import { listSessions, persistTransientSessionInTransaction } from "./sessions.js";

const rootName = "live-smith-device-parameters";
export const MAX_PARAMETER_ARTIFACT_BYTES = 4 * 1024 * 1024;
export const MAX_PARAMETER_SESSION_BYTES = 64 * 1024 * 1024;
export const MAX_PARAMETER_ARTIFACTS = 64;
const maxApplications = 256;

async function sessionDirectory(storageDirectory: string, sessionId: string): Promise<string> {
  if (!path.isAbsolute(storageDirectory)) throw new UiMessageError(uiMessage("Parameter artifact storage is unavailable."));
  requireSafeStorageId(sessionId, "Session ID");
  return path.join(storageDirectory, rootName, sessionId);
}

async function readJson(storageDirectory: string, file: string, maximum: number): Promise<unknown> {
  const reader = await openStoredReader(storageDirectory, file);
  try {
    if (reader.entry.byteLength > maximum) throw new UiMessageError(uiMessage("Parameter artifact file is invalid or too large."));
    const bytes = Buffer.alloc(reader.entry.byteLength);
    const hash = createHash("sha256");
    for (let offset = 0, index = 0; offset < bytes.length; index++) {
      const chunk = reader.readChunk(index); bytes.set(chunk, offset); hash.update(chunk); offset += chunk.length;
    }
    if (hash.digest("hex") !== reader.entry.sha256) throw new UiMessageError(uiMessage("Saved device parameter data is invalid."));
    try { return JSON.parse(bytes.toString("utf8")); }
    catch { throw new UiMessageError(uiMessage("Saved device parameter data is invalid.")); }
  } finally { reader.close(); }
}

async function requireSession(storageDirectory: string, sessionId: string): Promise<void> {
  if (!(await listSessions(storageDirectory)).some((entry) => entry.id === sessionId && !entry.archivedAt)) {
    throw new UiMessageError(uiMessage("That Session is not available for device parameters."));
  }
}

async function readArtifacts(storageDirectory: string, directory: string, sessionId: string): Promise<DeviceParameterArtifact[]> {
  const entries = await listStoredChildren(storageDirectory, directory);
  const result: DeviceParameterArtifact[] = [];
  for (const name of entries.filter((name) => name.startsWith("parameters_") && name.endsWith(".json")).sort()) {
    const value = await readJson(storageDirectory, path.join(directory, name), MAX_PARAMETER_ARTIFACT_BYTES);
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
    return readArtifacts(storageDirectory, await sessionDirectory(storageDirectory, sessionId), sessionId);
  });
}

export async function readDeviceParameterArtifact(storageDirectory: string | undefined, sessionId: string, artifactId: string): Promise<DeviceParameterArtifact> {
  if (!storageDirectory) throw new UiMessageError(uiMessage("Device parameter storage is unavailable."));
  requireSafeStorageId(artifactId, "Artifact ID");
  await requireSession(storageDirectory, sessionId);
  try {
    const directory = await sessionDirectory(storageDirectory, sessionId);
    const artifact = await readJson(storageDirectory, path.join(directory, `${artifactId}.json`), MAX_PARAMETER_ARTIFACT_BYTES);
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
    const directory = await sessionDirectory(storageDirectory, sessionId);
    const records = await readArtifacts(storageDirectory, directory, sessionId);
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
    await writeStoredJson(storageDirectory, path.join(directory, `${id}.json`), artifact, { createOnly: true });
    return cloneJsonValue(artifact);
  });
}

export async function listDeviceParameterApplications(storageDirectory: string | undefined, sessionId: string): Promise<DeviceParameterApplication[]> {
  if (!storageDirectory) return [];
  const directory = await sessionDirectory(storageDirectory, sessionId);
  const root = path.join(directory, "applications");
  const ids = await applicationIds(storageDirectory, root);
  const result: DeviceParameterApplication[] = [];
  for (const id of ids) result.push(await readApplication(storageDirectory, path.join(root, id), sessionId, id));
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

async function applicationIds(storageDirectory: string, root: string): Promise<string[]> {
  const ids = (await listStoredChildren(storageDirectory, root))
    .filter(name => name.endsWith(".json") && isSafeStorageId(name.slice(0, -5))).map(name => name.slice(0, -5));
  if (ids.length > maxApplications) throw new UiMessageError(uiMessage("Parameter application history exceeds its limit."));
  return ids.sort();
}

async function readBaseline(storageDirectory: string, directory: string, sessionId: string, id: string): Promise<{ application: DeviceParameterApplication; reservedBytes: number }> {
  const value = await readJson(storageDirectory, path.join(path.dirname(directory), `${id}.json`), MAX_PARAMETER_SESSION_BYTES) as { application?: unknown; reservedBytes?: unknown };
  if (!value || !isDeviceParameterApplication(value.application) || value.application.sessionId !== sessionId || value.application.id !== id ||
      typeof value.reservedBytes !== "number" || value.reservedBytes !== applicationReservation(value.application)) throw new UiMessageError(uiMessage("Parameter application baseline is invalid."));
  return { application: value.application, reservedBytes: value.reservedBytes };
}

async function readApplication(storageDirectory: string, directory: string, sessionId: string, id: string): Promise<DeviceParameterApplication> {
  try {
    const completed = await readJson(storageDirectory, path.join(directory, "result.json"), MAX_PARAMETER_SESSION_BYTES);
    if (!isDeviceParameterApplication(completed) || completed.sessionId !== sessionId || completed.id !== id || !["kept", "restored"].includes(completed.status)) throw new UiMessageError(uiMessage("Parameter application result is invalid."));
    return completed;
  } catch (error) { if (!isMissingFileError(error)) throw error; }
  const { application } = await readBaseline(storageDirectory, directory, sessionId, id);
  try {
    const state = await readJson(storageDirectory, path.join(directory, "state.json"), MAX_PARAMETER_SESSION_BYTES) as Pick<DeviceParameterApplication, "status" | "restorationBaseline">;
    if (!state || Object.keys(state).some((key) => !["status", "restorationBaseline"].includes(key))) throw new UiMessageError(uiMessage("Parameter application state is invalid."));
    application.status = state.status;
    if (state.restorationBaseline !== undefined) application.restorationBaseline = state.restorationBaseline;
  } catch (error) { if (!isMissingFileError(error)) throw error; }
  const entries = new Map(application.entries.map((entry) => [entry.parameter.index, entry]));
  const files = (await listStoredChildren(storageDirectory, directory)).filter((name) => /^parameter-\d+\.json$/u.test(name));
  for (let offset = 0; offset < files.length; offset += 16) {
    const progress = await Promise.all(files.slice(offset, offset + 16).map(async (name) => {
      const value = await readJson(storageDirectory, path.join(directory, name), 512);
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
    baselineArtifactId: application.baselineArtifactId, previousApplicationId: application.previousApplicationId,
    createdAt: application.createdAt, target: application.target, entries: application.entries.map(({ parameter, requested }) => ({ parameter, requested })) });
}

/** Save immutable before values once. Updates replace only changed progress and operation state. */
export async function saveDeviceParameterApplication(storageDirectory: string, application: DeviceParameterApplication): Promise<void> {
  if (!isDeviceParameterApplication(application)) throw new UiMessageError(uiMessage("Device parameter application receipt is invalid."));
  const saved = cloneJsonValue(application);
  await withStorageTransaction(storageDirectory, async (transaction) => {
    await requireSession(storageDirectory, saved.sessionId);
    await persistTransientSessionInTransaction(transaction, storageDirectory, saved.sessionId);
    const root = path.join(await sessionDirectory(storageDirectory, saved.sessionId), "applications");
    const directory = path.join(root, saved.id);
    const ids = await applicationIds(storageDirectory, root);
    if (!ids.includes(saved.id)) {
      const reservedBytes = applicationReservation(saved);
      let reserved = reservedBytes;
      for (const id of ids) reserved += (await readBaseline(storageDirectory, path.join(root, id), saved.sessionId, id)).reservedBytes;
      if (ids.length >= maxApplications || reserved > MAX_PARAMETER_SESSION_BYTES) throw new UiMessageError(uiMessage("This Session has reached its parameter application history limit."));
      await writeStoredJson(storageDirectory, path.join(root, `${saved.id}.json`), { application: saved, reservedBytes }, { createOnly: true });
      return;
    }
    const baseline = await readBaseline(storageDirectory, directory, saved.sessionId, saved.id);
    if (applicationIdentity(baseline.application) !== applicationIdentity(saved)) throw new UiMessageError(uiMessage("A parameter application baseline cannot be changed."));
    const previous = await readApplication(storageDirectory, directory, saved.sessionId, saved.id);
    if (previous.status === "kept" || previous.status === "restored") {
      if (JSON.stringify(previous) !== JSON.stringify(saved)) throw new UiMessageError(uiMessage("A completed parameter application cannot be changed."));
      return;
    }
    const previousEntries = new Map(previous.entries.map((entry) => [entry.parameter.index, entry]));
    for (const entry of saved.entries) {
      const before = previousEntries.get(entry.parameter.index)!;
      if (JSON.stringify(entryProgress(entry)) !== JSON.stringify(entryProgress(before))) await writeStoredJson(storageDirectory, path.join(directory, `parameter-${entry.parameter.index}.json`), entryProgress(entry));
    }
    if (saved.status === "kept" || saved.status === "restored") {
      await writeStoredJson(storageDirectory, path.join(directory, "result.json"), saved, { createOnly: true });
    } else {
      await writeStoredJson(storageDirectory, path.join(directory, "state.json"), { status: saved.status, ...(saved.restorationBaseline ? { restorationBaseline: saved.restorationBaseline } : {}) });
    }
  });
}

/** A write-ahead progress record is small even for devices with thousands of parameters. */
export async function saveDeviceParameterProgress(storageDirectory: string, sessionId: string, applicationId: string, progress: EntryProgress): Promise<void> {
  requireSafeStorageId(applicationId, "Parameter application ID");
  if (!isEntryProgress(progress)) throw new UiMessageError(uiMessage("Parameter application progress is invalid."));
  await withStorageTransaction(storageDirectory, async () => {
    const directory = path.join(await sessionDirectory(storageDirectory, sessionId), "applications", applicationId);
    const baseline = await readBaseline(storageDirectory, directory, sessionId, applicationId);
    if (!baseline.application.entries.some(entry => entry.parameter.index === progress.index)) throw new UiMessageError(uiMessage("Parameter application progress has no baseline."));
    await writeStoredJson(storageDirectory, path.join(directory, `parameter-${progress.index}.json`), progress);
  });
}

export async function deleteSessionDeviceParameters(storageDirectory: string | undefined, sessionId: string): Promise<void> {
  if (!storageDirectory) return;
  await withStorageTransaction(storageDirectory, async () => { await removeStoredTree(storageDirectory, await sessionDirectory(storageDirectory, sessionId)); });
}

export async function listSessionDeviceParameterDirectoryIds(storageDirectory: string | undefined): Promise<string[]> {
  if (!storageDirectory) return [];
  return (await listStoredChildren(storageDirectory, rootName)).filter(isSafeStorageId);
}
