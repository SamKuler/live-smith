export const sessionShortcutIds = ["context", "brief", "artifacts", "skills", "tools"] as const;

export const sessionInspectorTabs = sessionShortcutIds.filter((id) => id !== "brief");

export type SessionShortcutId = (typeof sessionShortcutIds)[number];

export const defaultSessionTabs: readonly SessionShortcutId[] = ["context", "brief", "artifacts"];

export function isSessionTabs(value: unknown): value is SessionShortcutId[] {
  return Array.isArray(value) &&
    [...value].every((tab) => sessionShortcutIds.includes(tab)) &&
    new Set(value).size === value.length;
}
