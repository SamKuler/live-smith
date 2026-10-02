import type { AuthProvider } from "@modelcontextprotocol/client";

export interface McpAuthProvider extends AuthProvider {
  readonly generation?: string | undefined;
  recordResponse?(response: Response, headers: HeadersInit | undefined): void;
}

export interface McpOAuthConfiguration {
  clientId?: string;
  callbackPort?: number;
}

export interface McpOAuthState {
  connectionId: string;
  status: "signed-out" | "signing-in" | "signed-in" | "unavailable";
  generation: string;
}

export function isMcpOAuthConfiguration(value: unknown): value is McpOAuthConfiguration {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).every((key) => key === "clientId" || key === "callbackPort") &&
    (record.clientId === undefined || typeof record.clientId === "string" &&
      /^[\x21-\x7e]{1,2048}$/u.test(record.clientId)) &&
    (record.callbackPort === undefined || Number.isInteger(record.callbackPort) &&
      Number(record.callbackPort) >= 1024 && Number(record.callbackPort) <= 65535) &&
    (record.clientId === undefined || record.callbackPort !== undefined);
}

export function hasAuthorizationHeader(headers: Readonly<Record<string, string>>): boolean {
  return Object.keys(headers).some((name) => name.toLowerCase() === "authorization");
}

export class McpAuthorizationRequiredError extends Error {
  constructor() { super("This MCP connection requires sign-in. Open its connection settings to sign in."); this.name = "McpAuthorizationRequiredError"; }
}

export class McpOAuthError extends Error {
  constructor(message: string) { super(message); this.name = "McpOAuthError"; }
}
