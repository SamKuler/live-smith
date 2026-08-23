const defaultConnectionErrorMessage = "The model connection was interrupted.";

export class ModelConnectionError extends Error {
  constructor(message: string = defaultConnectionErrorMessage) {
    super(message);
    this.name = "ModelConnectionError";
  }
}
