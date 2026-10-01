import { createHash } from "node:crypto";
import { throwIfAborted } from "../../runtime/host.js";
import { isBuiltInSkillId } from "../../skills/builtins.js";
import { isSafeSkillId, parseSkillMarkdown, SkillFormatError } from "../../skills/format.js";
import {
  isStorageCommitOutcomeUnknownError,
  withStorageTransaction,
} from "../../storage/persistence.js";
import { listSessionsInTransaction } from "../../storage/sessions.js";
import {
  deleteInstalledSkillInTransaction,
  installSkillInTransaction,
  listInstalledSkills,
  listInstalledSkillsInTransaction,
  SkillStorageCorruptionError,
  type InstalledSkill,
} from "../../storage/skills.js";
import {
  ChatBridgeCommandOutcomeUnknownError,
  ChatBridgeConflictError,
  ChatBridgeSkillValidationError,
  type ChatBridgeSkillDeleteInput,
  type ChatBridgeSkillInstallInput,
} from "../chat/chat-bridge.js";

interface UserSkillLifecycleOptions {
  storageDirectory: string | undefined;
  withRequestConfiguration<T>(
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
  ): Promise<T>;
  notifyGlobalStateChanged(): void;
}

/** Owns user Skill installation and deletion with durable-outcome reconciliation. */
export function createUserSkillLifecycle(dependencies: UserSkillLifecycleOptions) {
  const { storageDirectory, withRequestConfiguration, notifyGlobalStateChanged } = dependencies;
  const install = async (
    input: ChatBridgeSkillInstallInput,
    signal: AbortSignal,
  ): Promise<{ id: string; sha256: string }> => {
    throwIfAborted(signal);
    const bytes = Uint8Array.from(input.bytes);
    let definition;
    try {
      definition = parseSkillMarkdown(bytes);
    } catch (error) {
      if (error instanceof SkillFormatError) {
        throw new ChatBridgeSkillValidationError(error.message);
      }
      throw new ChatBridgeSkillValidationError(
        "The uploaded SKILL.md is invalid.",
      );
    }
    const expectedSha256 = createHash("sha256").update(bytes).digest("hex");
    let installed: InstalledSkill | undefined;
    let catalogChanged = false;
    await withRequestConfiguration(signal,
      async () => {
        let invalidationPublished = false;
        const publishInvalidation = () => {
          if (invalidationPublished) return;
          invalidationPublished = true;
          notifyGlobalStateChanged();
        };
        try {
          installed = await withStorageTransaction(
            storageDirectory,
            async (transaction) => {
              throwIfAborted(signal);
              const existing = (await listInstalledSkillsInTransaction(
                transaction,
                storageDirectory,
              )).find((skill) => skill.id === definition.id);
              if (existing === undefined && isBuiltInSkillId(definition.id)) {
                throw new ChatBridgeSkillValidationError(
                  `Built-in Skill ${definition.id} is read-only and cannot be installed or replaced.`,
                );
              }
              if (existing?.sha256 === expectedSha256) return existing;
              if (existing !== undefined && !input.replace) {
                throw new ChatBridgeConflictError(
                  `Skill ${definition.id} is already installed. Confirm replacement to change it.`,
                );
              }
              throwIfAborted(signal);
              const next = await installSkillInTransaction(
                transaction,
                storageDirectory,
                bytes,
                { replace: input.replace },
              );
              catalogChanged = true;
              return next;
            },
          );
        } catch (error) {
          if (isStorageCommitOutcomeUnknownError(error)) {
            publishInvalidation();
            try {
              installed = (await listInstalledSkills(
                storageDirectory,
              )).find((skill) =>
                skill.id === definition.id && skill.sha256 === expectedSha256
              );
            } catch {
              installed = undefined;
            }
            if (installed === undefined) {
              throw new ChatBridgeCommandOutcomeUnknownError(
                "The Skill may have been installed, but its final state could not be confirmed.",
                { cause: error },
              );
            }
          } else if (
            error instanceof ChatBridgeConflictError ||
            error instanceof ChatBridgeSkillValidationError
          ) {
            throw error;
          } else if (error instanceof SkillStorageCorruptionError) {
            throw new ChatBridgeSkillValidationError(
              "Installed Skill storage is invalid and was not changed.",
            );
          } else {
            throwIfAborted(signal);
            throw new ChatBridgeSkillValidationError(
              "The Skill could not be installed or replaced.",
            );
          }
        }
        if (catalogChanged) publishInvalidation();
      },
    );
    if (installed === undefined) {
      throw new ChatBridgeSkillValidationError(
        "The Skill installation could not be confirmed.",
      );
    }
    return { id: installed.id, sha256: installed.sha256 };
  };
  const remove = async (
    input: ChatBridgeSkillDeleteInput,
    signal: AbortSignal,
  ) => {
    if (!isSafeSkillId(input.skillId)) {
      throw new ChatBridgeSkillValidationError("Skill ID is invalid.");
    }
    let deleted = false;
    await withRequestConfiguration(signal,
      async () => {
        let invalidationPublished = false;
        const publishInvalidation = () => {
          if (invalidationPublished) return;
          invalidationPublished = true;
          notifyGlobalStateChanged();
        };
        try {
          await withStorageTransaction(
            storageDirectory,
            async (transaction) => {
              throwIfAborted(signal);
              const existing = (await listInstalledSkillsInTransaction(
                transaction,
                storageDirectory,
              )).some((skill) => skill.id === input.skillId);
              if (!existing) return;
              const sessions = await listSessionsInTransaction(
                transaction,
                storageDirectory,
              );
              if (sessions.some((session) =>
                session.activeSkillIds?.includes(input.skillId)
              )) {
                throw new ChatBridgeConflictError(
                  "Remove this Skill from every Session before deleting it.",
                );
              }
              throwIfAborted(signal);
              await deleteInstalledSkillInTransaction(
                transaction,
                storageDirectory,
                input.skillId,
              );
              deleted = true;
            },
          );
        } catch (error) {
          if (isStorageCommitOutcomeUnknownError(error)) {
            publishInvalidation();
            try {
              const stillInstalled = (await listInstalledSkills(
                storageDirectory,
              )).some((skill) => skill.id === input.skillId);
              if (!stillInstalled) deleted = true;
              else throw error;
            } catch (reconciliationError) {
              throw new ChatBridgeCommandOutcomeUnknownError(
                "The Skill may have been deleted, but its final state could not be confirmed.",
                { cause: reconciliationError },
              );
            }
          } else if (error instanceof ChatBridgeConflictError) {
            throw error;
          } else if (error instanceof SkillStorageCorruptionError) {
            throw new ChatBridgeSkillValidationError(
              "Installed Skill storage is invalid and was not changed.",
            );
          } else {
            throwIfAborted(signal);
            throw new ChatBridgeSkillValidationError(
              "The Skill could not be deleted.",
            );
          }
        }
        if (deleted) publishInvalidation();
      },
    );
    return deleted;
  };
  return { install, remove };
}
