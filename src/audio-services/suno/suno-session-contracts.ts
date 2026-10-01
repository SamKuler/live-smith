/** Website-session evidence never confers an audio-generation capability. */
export interface SunoSessionIdentity {
  accountId: string;
  accountName?: string;
}

export type SunoSessionVerifier = (
  sessionValue: string, signal: AbortSignal,
) => Promise<SunoSessionIdentity & { sessionValue?: string }>;

export interface SunoAccountView {
  serviceId: string;
  status: "signed_out" | "saved" | "signed_in" | "expired" | "unavailable";
  accountId?: string;
  accountName?: string;
}
