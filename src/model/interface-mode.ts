/** Window host preference; a running UI retains its admitted host. */
export type InterfaceMode = "modal" | "browser" | "native";
export function isInterfaceMode(value: unknown): value is InterfaceMode {
  return value === "modal" || value === "browser" || value === "native";
}
