import { deleteSessionPluginAudioArtifacts, listSessionPluginAudioDirectoryIds } from "../../storage/audio-artifacts.js";
import { deleteSessionDeviceParameters, listSessionDeviceParameterDirectoryIds } from "../../storage/device-parameter-artifacts.js";
import { throwIfAborted } from "../../runtime/host.js";
import {
  deleteSessionAttachments,
  listSessionAttachmentDirectoryIds,
} from "../../storage/attachments.js";
import { deleteSessionAudio, listSessionAudioDirectoryIds } from "../../storage/audio-assets.js";
import { deleteSessionEvents, listSessionEventLogIds } from "../../storage/events.js";
import {
  deleteSessionMidiArtifacts,
  listSessionMidiArtifactDirectoryIds,
} from "../../storage/midi-artifacts.js";
import { isStorageCommitOutcomeUnknownError } from "../../storage/persistence.js";
import { deleteSession, listSessions } from "../../storage/sessions.js";
import { ChatBridgeCommandOutcomeUnknownError } from "../chat/chat-bridge.js";

interface SessionLifecycleOptions {
  storageDirectory: string | undefined;
  withSessionMutation<T>(
    sessionId: string,
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
  ): Promise<T>;
  notifySessionStateChanged(sessionId: string): void;
  deleteSession?: typeof deleteSession;
}

/** Owns deletion recovery and orphan data cleanup under the Session mutation fence. */
export function createSessionLifecycle(dependencies: SessionLifecycleOptions) {
  const { storageDirectory, withSessionMutation, notifySessionStateChanged } = dependencies;
  const pendingSessionCleanup = new Set<string>();
  const sessionExists = async (sessionId: string): Promise<boolean> =>
    (await listSessions(storageDirectory)).some((session) => session.id === sessionId);

  const deleteAssociatedData = async (sessionId: string): Promise<void> => {
    await deleteSessionEvents(storageDirectory, sessionId);
    await deleteSessionAttachments(storageDirectory, sessionId);
    await deleteSessionAudio(storageDirectory, sessionId);
    await deleteSessionPluginAudioArtifacts(storageDirectory, sessionId);
    await deleteSessionMidiArtifacts(storageDirectory, sessionId);
    await deleteSessionDeviceParameters(storageDirectory, sessionId);
  };

  const remove = async (
    sessionId: string,
    signal: AbortSignal,
    onMetadataDeleted: () => void,
  ): Promise<boolean> => {
    let existed = false;
    await withSessionMutation(sessionId, signal, async () => {
      existed = await sessionExists(sessionId);
      throwIfAborted(signal);
      if (existed) {
        try {
          await (dependencies.deleteSession ?? deleteSession)(
            storageDirectory,
            sessionId,
          );
        } catch (cause) {
          if (isStorageCommitOutcomeUnknownError(cause)) {
            pendingSessionCleanup.add(sessionId);
            notifySessionStateChanged(sessionId);
            throw new ChatBridgeCommandOutcomeUnknownError(
              "Session deletion storage could not be confirmed.",
              { cause },
            );
          }
          throw cause;
        }
        onMetadataDeleted();
      }
      try {
        await deleteAssociatedData(sessionId);
        pendingSessionCleanup.delete(sessionId);
      } catch (cause) {
        pendingSessionCleanup.add(sessionId);
        notifySessionStateChanged(sessionId);
        throw new ChatBridgeCommandOutcomeUnknownError(
          "The Session was deleted, but associated data cleanup could not be confirmed.",
          { cause },
        );
      }
      notifySessionStateChanged(sessionId);
    });
    return existed;
  };

  async function retryPendingCleanup(): Promise<void> {
    for (const sessionId of [...pendingSessionCleanup]) {
      await withSessionMutation(sessionId, undefined, async () => {
        if (await sessionExists(sessionId)) {
          pendingSessionCleanup.delete(sessionId);
          return;
        }
        await deleteAssociatedData(sessionId);
        pendingSessionCleanup.delete(sessionId);
      });
    }
  }

  async function reconcileStartupOrphans(): Promise<void> {
    const existingSessionIds = new Set(
      (await listSessions(storageDirectory)).map(
        (session) => session.id,
      ),
    );
    const orphanCandidates = new Set([
      ...await listSessionAudioDirectoryIds(storageDirectory),
      ...await listSessionPluginAudioDirectoryIds(storageDirectory),
      ...await listSessionMidiArtifactDirectoryIds(storageDirectory),
      ...await listSessionDeviceParameterDirectoryIds(storageDirectory),
      ...await listSessionAttachmentDirectoryIds(
        storageDirectory,
      ),
      ...await listSessionEventLogIds(
        storageDirectory,
      ),
    ]);
    for (const sessionId of [...orphanCandidates].sort()) {
      if (existingSessionIds.has(sessionId)) continue;
      await withSessionMutation(sessionId, undefined, async () => {
        if (await sessionExists(sessionId)) return;
        await deleteAssociatedData(sessionId);
      });
    }
  }

  return { remove, retryPendingCleanup, reconcileStartupOrphans };
}
