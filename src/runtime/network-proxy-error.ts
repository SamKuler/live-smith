/** A fixed, credential-free diagnosis that is safe to show outside the host. */
export class NetworkProxyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkProxyError";
  }
}
