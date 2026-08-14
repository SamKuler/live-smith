import {
  createHostAbortController,
  throwIfAborted,
} from "../runtime/host.js";

const DEFAULT_MAX_PENDING = 8;
const DEFAULT_MAX_SUBMISSIONS = 32;

export interface SteeringChannelOptions {
  readonly maxPending?: number;
  readonly maxSubmissions?: number;
}

export interface SteeringPendingEntry {
  readonly id: string;
  readonly prompt: string;
  accept(): void;
  reject(error: Error): void;
}

export interface SteeringSubmission {
  readonly created: boolean;
  readonly completion: Promise<void>;
}

export interface SteeringModelTurn {
  readonly signal: AbortSignal;
  wasInterrupted(): boolean;
  dispose(): void;
}

export class SteeringConflictError extends Error {
  constructor(readonly id: string) {
    super(`Steering submission ${JSON.stringify(id)} conflicts with an existing prompt.`);
    this.name = "SteeringConflictError";
  }
}

export class SteeringClosedError extends Error {
  constructor(message = "Steering channel is closed.") {
    super(message);
    this.name = "SteeringClosedError";
  }
}

export class SteeringCapacityError extends Error {
  constructor(
    readonly limit: number,
    readonly scope: "pending" | "total" = "pending",
  ) {
    super(scope === "pending"
      ? `Steering channel already has ${limit} unsettled submissions.`
      : `Steering channel accepts at most ${limit} submissions per agent request.`);
    this.name = "SteeringCapacityError";
  }
}

export class SteeringPersistenceOutcomeUnknownError extends Error {
  constructor(
    readonly sendId: string,
    readonly steerId: string,
    options?: ErrorOptions,
  ) {
    super(
      "The steering message may have been persisted, but its storage outcome could not be confirmed.",
      options,
    );
    this.name = "SteeringPersistenceOutcomeUnknownError";
  }
}

interface SubmissionRecord {
  readonly id: string;
  readonly prompt: string;
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  state: "queued" | "taken" | "settled";
}

interface ActiveModelTurn {
  interrupt(): void;
  dispose(): void;
}

export class SteeringChannel {
  private readonly maxPending: number;
  private readonly maxSubmissions: number;
  private readonly submissionsById = new Map<string, SubmissionRecord>();
  private readonly unsettled = new Set<SubmissionRecord>();
  private queued: SubmissionRecord[] = [];
  private activeTurn: ActiveModelTurn | undefined;
  private closeReason: Error | undefined;

  constructor(options: SteeringChannelOptions = {}) {
    const maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
    const maxSubmissions = options.maxSubmissions ?? DEFAULT_MAX_SUBMISSIONS;
    if (!Number.isSafeInteger(maxPending) || maxPending < 1) {
      throw new RangeError("maxPending must be a positive safe integer.");
    }
    if (!Number.isSafeInteger(maxSubmissions) || maxSubmissions < 1) {
      throw new RangeError("maxSubmissions must be a positive safe integer.");
    }
    if (maxSubmissions < maxPending) {
      throw new RangeError("maxSubmissions must be greater than or equal to maxPending.");
    }
    this.maxPending = maxPending;
    this.maxSubmissions = maxSubmissions;
  }

  submit(id: string, prompt: string): Promise<void> {
    return this.enqueue(id, prompt).completion;
  }

  enqueue(id: string, prompt: string): SteeringSubmission {
    if (this.closeReason) throw this.closeReason;

    const existing = this.submissionsById.get(id);
    if (existing) {
      if (existing.prompt !== prompt) {
        throw new SteeringConflictError(id);
      }
      return Object.freeze({ created: false, completion: existing.promise });
    }
    if (this.submissionsById.size >= this.maxSubmissions) {
      throw new SteeringCapacityError(this.maxSubmissions, "total");
    }
    if (this.unsettled.size >= this.maxPending) {
      throw new SteeringCapacityError(this.maxPending);
    }

    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((targetResolve, targetReject) => {
      resolve = targetResolve;
      reject = targetReject;
    });
    const record: SubmissionRecord = {
      id,
      prompt,
      promise,
      resolve,
      reject,
      state: "queued",
    };
    this.submissionsById.set(id, record);
    this.unsettled.add(record);
    this.queued.push(record);
    this.activeTurn?.interrupt();
    return Object.freeze({ created: true, completion: promise });
  }

  hasPending(): boolean {
    return this.queued.length > 0;
  }

  takePending(maxCount = Number.MAX_SAFE_INTEGER): SteeringPendingEntry[] {
    if (!Number.isSafeInteger(maxCount) || maxCount < 1) {
      throw new RangeError("maxCount must be a positive safe integer.");
    }
    const records = this.queued.splice(0, maxCount);
    return records.map((record) => {
      record.state = "taken";
      return Object.freeze({
        id: record.id,
        prompt: record.prompt,
        accept: () => this.accept(record),
        reject: (error: Error) => this.reject(record, error),
      });
    });
  }

  beginModelTurn(parentSignal: AbortSignal): SteeringModelTurn {
    throwIfAborted(parentSignal);
    const controller = createHostAbortController();
    this.activeTurn?.dispose();

    let interrupted = false;
    let disposed = false;
    let activeTurn!: ActiveModelTurn;
    const onParentAbort = (): void => {
      try {
        throwIfAborted(parentSignal);
      } catch (error) {
        controller.abort(error);
      }
    };
    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      parentSignal.removeEventListener("abort", onParentAbort);
      if (this.activeTurn === activeTurn) this.activeTurn = undefined;
    };
    activeTurn = {
      interrupt: () => {
        if (disposed || controller.signal.aborted) return;
        interrupted = true;
        controller.abort(new Error("Model turn interrupted by steering."));
      },
      dispose,
    };
    parentSignal.addEventListener("abort", onParentAbort, { once: true });
    this.activeTurn = activeTurn;
    if (this.hasPending()) activeTurn.interrupt();

    return Object.freeze({
      signal: controller.signal,
      wasInterrupted: () => interrupted,
      dispose,
    });
  }

  close(error: Error = new SteeringClosedError()): void {
    if (this.closeReason) return;
    this.closeReason = error;
    const queued = this.queued;
    this.queued = [];
    for (const record of queued) this.reject(record, error);
  }

  private accept(record: SubmissionRecord): void {
    this.markSettled(record);
    record.resolve();
  }

  private reject(record: SubmissionRecord, error: Error): void {
    this.markSettled(record);
    record.reject(error);
  }

  private markSettled(record: SubmissionRecord): void {
    if (record.state === "settled") {
      throw new Error(`Steering submission ${JSON.stringify(record.id)} is already settled.`);
    }
    record.state = "settled";
    this.unsettled.delete(record);
  }
}
