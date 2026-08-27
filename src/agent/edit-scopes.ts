export const EDIT_SCOPES = ["midi", "audio", "devices", "mixer", "structure"] as const;

export type EditScope = (typeof EDIT_SCOPES)[number];

export const EDIT_SCOPE_LABELS: Record<EditScope, string> = {
  midi: "MIDI content",
  audio: "Audio content",
  devices: "Devices",
  mixer: "Mixer",
  structure: "Track and Set structure",
};

export function isEditScopes(value: unknown): value is EditScope[] {
  return Array.isArray(value) &&
    value.length <= EDIT_SCOPES.length &&
    new Set(value).size === value.length &&
    [...value].every((scope) => EDIT_SCOPES.includes(scope));
}

export function requireEditScopes(value: unknown): EditScope[] {
  if (!isEditScopes(value)) {
    throw new Error("Edit scopes must be a list of distinct supported scopes.");
  }
  return resolveEditScopes(value);
}

/** Missing historical metadata preserves unrestricted writes; [] is read-only. */
export function resolveEditScopes(value?: readonly EditScope[]): EditScope[] {
  return EDIT_SCOPES.filter((scope) => (value ?? EDIT_SCOPES).includes(scope));
}

export class EditScopeDeniedError extends Error {
  constructor(readonly missingScopes: readonly EditScope[]) {
    super(
      missingScopes.length
        ? `This plan exceeds the Session's edit scope. Required permission: ${missingScopes.map((scope) => EDIT_SCOPE_LABELS[scope]).join(", ")}. No approval mode can grant this permission. Ask the user to change Edit Scope or propose work within the allowed scopes.`
        : "The Session's edit scope could not be verified. No further Live writes are authorized until the saved permissions can be read successfully.",
    );
    this.name = "EditScopeDeniedError";
  }
}

export function assertEditScopesAllow(
  required: readonly EditScope[],
  allowed: readonly EditScope[],
): void {
  const missing = EDIT_SCOPES.filter((scope) =>
    required.includes(scope) && !allowed.includes(scope)
  );
  if (missing.length) throw new EditScopeDeniedError(missing);
}
