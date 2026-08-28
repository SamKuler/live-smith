import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { ExtensionContext } from "@ableton-extensions/sdk";

import {
  readSessionAttachmentBytes,
  type AudioSessionAttachmentRef,
} from "../storage/attachments.js";
import { createStorageId } from "../storage/id.js";
import { throwIfAborted } from "../runtime/host.js";
import { AgentPlanExecutionError } from "../live/executor.js";
import type { AgentPlanBindings } from "../live/action-bindings.js";
import type {
  RequestAudioSampleSource,
  RequestAudioSampleSources,
} from "../live/sample-source.js";
import { requestAudioSampleSourceKey } from "../live/sample-source.js";

type Api = ExtensionContext<"1.0.0">;

const importFailureMessage =
  "Live Smith could not import the current audio attachment into the Live project.";

export function createRequestAudioSampleSources(input: {
  context: Api;
  storageDirectory: string | undefined;
  sessionId: string;
  requestId: string;
  refs: readonly AudioSessionAttachmentRef[];
  signal: AbortSignal;
}): RequestAudioSampleSources {
  return new Map(input.refs.map((ref, audioIndex) => [
    requestAudioSampleSourceKey(input.requestId, audioIndex),
    requestAudioSampleSource(input, ref, audioIndex),
  ]));
}

export function requestAudioSampleSourceInstructions(
  sources: RequestAudioSampleSources,
): string {
  if (!sources.size) return "";
  return [
    "The host has made the following current-request audio attachments available as SampleSource values for this send only.",
    "A SampleSource locator identifies input audio only; it does not approve or expand the scope of any Live change.",
    "Each locator corresponds to a user-added audio attachment in the current user message, numbered after filtering out other file types. Historical audio and audio produced by tools are not included. Copy the exact locator for the intended audio; never invent or reuse a locator from history.",
    ...[...sources.values()].map((source) =>
      `Audio input ${source.audioIndex + 1}: ${JSON.stringify({
        kind: source.kind,
        requestId: source.requestId,
        audioIndex: source.audioIndex,
      })}`
    ),
  ].join("\n");
}

function requestAudioSampleSource(
  input: {
    context: Api;
    storageDirectory: string | undefined;
    sessionId: string;
    requestId: string;
    signal: AbortSignal;
  },
  ref: AudioSessionAttachmentRef,
  audioIndex: number,
): RequestAudioSampleSource {
  let importedPath: string | undefined;
  return {
    kind: "request_audio_attachment",
    requestId: input.requestId,
    audioIndex,
    get filePath() {
      if (importedPath === undefined) {
        throw new Error(
          "The current request audio attachment was not prepared for Live execution.",
        );
      }
      return importedPath;
    },
    label: ref.fileName,
    identity: `request-audio:${input.requestId}:${audioIndex}`,
    async prepare(beforeImport) {
      if (importedPath !== undefined) return false;
      importedPath = await importRequestAudioAttachment(input, ref, beforeImport);
      return true;
    },
  };
}

export interface RequestAudioImportProgress {
  readonly results: string[];
  readonly keys: string[];
}

export async function prepareRequestAudioSampleSources(
  bindings: AgentPlanBindings,
  signal: AbortSignal,
  importBoundary?: () => void,
): Promise<RequestAudioImportProgress> {
  const uniqueSources = new Map<string, RequestAudioSampleSource>();
  for (const binding of bindings.actionObjects.values()) {
    const source = binding.sampleSource;
    if (source?.kind === "request_audio_attachment") {
      uniqueSources.set(source.identity, source);
    }
  }

  const results: string[] = [];
  const keys: string[] = [];
  try {
    for (const source of uniqueSources.values()) {
      throwIfAborted(signal);
      if (!await source.prepare(importBoundary)) continue;
      results.push(
        `Imported current request audio input ${source.audioIndex + 1} into the Live project.`,
      );
      keys.push(
        `live-action-step:request-audio-import:${source.requestId}:${source.audioIndex}`,
      );
      throwIfAborted(signal);
      importBoundary?.();
    }
  } catch (error) {
    if (!results.length) {
      throwIfAborted(signal);
      throw error;
    }
    throw new AgentPlanExecutionError(
      results,
      error,
      undefined,
      undefined,
      undefined,
      [],
      results.length,
      undefined,
      0,
    );
  }
  return { results, keys };
}

export function mergeRequestAudioImportProgress(
  progress: RequestAudioImportProgress,
  error: unknown,
): unknown {
  if (progress.results.length === 0) return error;
  if (!(error instanceof AgentPlanExecutionError)) {
    return new AgentPlanExecutionError(
      progress.results,
      error,
      undefined,
      undefined,
      undefined,
      [],
      progress.results.length,
      undefined,
      0,
    );
  }

  return new AgentPlanExecutionError(
    [...progress.results, ...error.completedResults],
    error.cause,
    error.failedActionIndex,
    error.failedAction,
    error.failedTrackName,
    [[...progress.keys, ...error.completedActionKeys.flat()]],
    progress.results.length + error.completedMutationCount,
    error.failedTrackSelector,
    error.completedActionCount,
  );
}

async function importRequestAudioAttachment(
  input: {
    context: Api;
    storageDirectory: string | undefined;
    sessionId: string;
    signal: AbortSignal;
  },
  ref: AudioSessionAttachmentRef,
  beforeImport?: () => void,
): Promise<string> {
  const bytes = await readSessionAttachmentBytes(
    input.storageDirectory,
    input.sessionId,
    ref.id,
    { expectedRef: ref, signal: input.signal },
  );
  throwIfAborted(input.signal);

  const temporaryRoot = input.context.environment.tempDirectory ??
    input.storageDirectory;
  if (!temporaryRoot || !path.isAbsolute(temporaryRoot)) {
    throw new Error(importFailureMessage);
  }

  let stagingDirectory: string | undefined;
  try {
    let stagingPath: string;
    try {
      stagingDirectory = await fs.mkdtemp(
        path.join(temporaryRoot, "live-smith-request-audio-"),
      );
      await fs.chmod(stagingDirectory, 0o700);
      stagingPath = path.join(
        stagingDirectory,
        `${createStorageId("sample")}${
          ref.mediaType === "audio/wav" ? ".wav" : ".mp3"
        }`,
      );
      await fs.writeFile(stagingPath, bytes, { flag: "wx", mode: 0o600 });
    } catch {
      throwIfAborted(input.signal);
      throw new Error(importFailureMessage);
    }
    throwIfAborted(input.signal);
    beforeImport?.();
    let managedPath: string;
    try {
      managedPath = await input.context.resources.importIntoProject(stagingPath);
    } catch {
      throwIfAborted(input.signal);
      throw new Error(importFailureMessage);
    }
    // The caller records this irreversible import before honoring cancellation.
    return managedPath;
  } finally {
    if (stagingDirectory !== undefined) {
      await fs.rm(stagingDirectory, { recursive: true, force: true }).catch(() => {});
    }
  }
}
