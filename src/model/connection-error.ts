const defaultConnectionErrorMessage = "The model connection was interrupted.";
const defaultRetryableErrorMessage = "The model provider returned a retryable failure.";

export class ModelRetryableError extends Error {
  readonly retryAfterMs: number | undefined;

  constructor(
    message: string = defaultRetryableErrorMessage,
    retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ModelRetryableError";
    this.retryAfterMs = retryAfterMs;
  }
}

export class ModelConnectionError extends ModelRetryableError {
  constructor(message: string = defaultConnectionErrorMessage) {
    super(message);
    this.name = "ModelConnectionError";
  }
}

export class ModelAuthenticationError extends Error {
  constructor(message: string = "The model provider rejected authentication.") {
    super(message);
    this.name = "ModelAuthenticationError";
  }
}
