import { MAX_AGENT_PLAN_ACTIONS } from "./actions.js";

/** The largest recovery ledger accepted by releases before final-repair reserves. */
export const LEGACY_MAX_RECOVERY_ACTION_DIGESTS = 4_096;

/**
 * A bounded plan reserves up to eight known identities per action and the same
 * amount separately for identities discovered during partial execution.
 */
export const MAX_RECOVERY_PLAN_IDENTITY_DIGESTS =
  MAX_AGENT_PLAN_ACTIONS * 8;

/**
 * Keep every legacy digest plus room for one final repair plan's known
 * identities and identities discovered if that plan only partially executes.
 */
export const MAX_RECOVERY_ACTION_DIGESTS =
  LEGACY_MAX_RECOVERY_ACTION_DIGESTS +
  MAX_RECOVERY_PLAN_IDENTITY_DIGESTS * 2;

/** Preserve the prior staged-work threshold and its final-repair headroom. */
export const MAX_STAGED_RECOVERY_ACTION_DIGESTS =
  LEGACY_MAX_RECOVERY_ACTION_DIGESTS -
  MAX_RECOVERY_PLAN_IDENTITY_DIGESTS * 2;

/** A final plan must still leave room for partial-execution-only identities. */
export const MAX_FINAL_RECOVERY_ADMISSION_DIGESTS =
  MAX_RECOVERY_ACTION_DIGESTS - MAX_RECOVERY_PLAN_IDENTITY_DIGESTS;
