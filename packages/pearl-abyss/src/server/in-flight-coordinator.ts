import { BoundedConnectionPool } from "@agris/invocation-budget";

/** What the coordinator does with one distinct request. */
export interface PearlAbyssInFlightWork<Request, Result> {
  /**
   * Runs once per distinct request before it waits for an active slot, so a refusal (the rate limit) never queues. A
   * result settles the request there, unsent; `undefined` lets it wait for a slot. `signal` aborts when every caller
   * sharing the request has given up or its deadline has passed.
   */
  readonly admit?: (request: Request, signal: AbortSignal) => Promise<Result | undefined>;
  /** Sends one distinct request. `signal` aborts when every caller sharing it has given up or its deadline passes. */
  readonly send: (request: Request, signal: AbortSignal) => Promise<Result>;
  /**
   * Starts one distinct request's deadline when it arrives: admission, the wait for a slot and the send all end when
   * the signal aborts, and the request fails as `PearlAbyssCoordinatorDeadlineError`. Without it, no deadline applies.
   */
  readonly deadline?: () => AbortSignal;
}

export interface PearlAbyssInFlightLimits {
  /** Distinct requests sent at once. */
  readonly maximumActiveRequests: number;
  /** Distinct requests that may wait, being admitted or for a slot, beyond the active ones. */
  readonly maximumQueuedRequests: number;
}

/**
 * A distinct request arrived while the coordinator already held `maximumActiveRequests + maximumQueuedRequests`
 * distinct requests. It was neither queued nor sent; the caller may retry later.
 */
export class PearlAbyssCoordinatorQueueFullError extends Error {
  public constructor() {
    super("The Pearl Abyss coordinator's queue is full");
    this.name = "PearlAbyssCoordinatorQueueFullError";
  }
}

/** A distinct request's deadline passed before it was answered: it left the queue, or its send was cancelled. */
export class PearlAbyssCoordinatorDeadlineError extends Error {
  public constructor() {
    super("The Pearl Abyss request's deadline passed");
    this.name = "PearlAbyssCoordinatorDeadlineError";
  }
}

interface InFlightRequest<Result> {
  readonly result: Promise<Result>;
  readonly cancel: AbortController;
  sharers: number;
}

/**
 * Shares matching pending requests and queues distinct requests behind one configurable active-work ceiling.
 *
 * State progression: pending -> admitted -> queued -> active -> settled. Settled work is removed immediately, so this
 * coordinator never becomes a response cache. Every caller that passes a signal may give up on its own: it stops
 * waiting, and the request is cancelled only when no caller is left waiting for it. A cancelled request no longer
 * shares its answer, but it counts against the bound until its work has settled, so work that ignores cancellation
 * cannot make room for more.
 */
export class PearlAbyssInFlightCoordinator<Request, Result> {
  private readonly activeRequests: BoundedConnectionPool;
  private readonly maximumDistinctRequests: number;
  private readonly pending = new Map<string, InFlightRequest<Result>>();
  /** Distinct requests started and not yet settled, shared or cancelled. */
  private distinctRequests = 0;

  public constructor(
    limits: PearlAbyssInFlightLimits,
    private readonly work: PearlAbyssInFlightWork<Request, Result>,
  ) {
    if (!Number.isSafeInteger(limits.maximumQueuedRequests) || limits.maximumQueuedRequests < 0) {
      throw new RangeError("Maximum queued requests must be a non-negative safe integer");
    }
    this.activeRequests = new BoundedConnectionPool(limits.maximumActiveRequests);
    this.maximumDistinctRequests = limits.maximumActiveRequests + limits.maximumQueuedRequests;
    if (!Number.isSafeInteger(this.maximumDistinctRequests)) {
      throw new RangeError("Maximum active and queued requests must sum to a safe integer");
    }
  }

  /**
   * Answer `request`, sharing the pending request with the same `key` when there is one; a shared call does not keep
   * its own `request`. `signal` is this caller's own: when it aborts, this call rejects with its reason and the other
   * callers keep waiting.
   */
  public execute(key: string, request: Request, signal?: AbortSignal): Promise<Result> {
    if (signal?.aborted === true) return Promise.reject(signal.reason);
    let inFlight = this.pending.get(key);
    if (inFlight === undefined) {
      if (this.distinctRequests >= this.maximumDistinctRequests) {
        return Promise.reject(new PearlAbyssCoordinatorQueueFullError());
      }
      inFlight = this.start(key, request);
    }
    return this.join(key, inFlight, signal);
  }

  private start(key: string, request: Request): InFlightRequest<Result> {
    const cancel = new AbortController();
    const inFlight: InFlightRequest<Result> = {
      result: this.executeDistinct(request, cancel.signal, this.work.deadline?.()),
      cancel,
      sharers: 0,
    };
    this.pending.set(key, inFlight);
    this.distinctRequests += 1;
    const settle = (): void => {
      this.distinctRequests -= 1;
      this.remove(key, inFlight);
    };
    void inFlight.result.then(settle, settle);
    return inFlight;
  }

  private join(key: string, inFlight: InFlightRequest<Result>, signal: AbortSignal | undefined): Promise<Result> {
    inFlight.sharers += 1;
    if (signal === undefined) return inFlight.result;
    return new Promise<Result>((resolve, reject) => {
      const leave = (): void => {
        inFlight.sharers -= 1;
        if (inFlight.sharers === 0) {
          // A later caller with the same key starts afresh; this work still counts until it settles.
          this.remove(key, inFlight);
          inFlight.cancel.abort(signal.reason);
        }
        reject(signal.reason);
      };
      signal.addEventListener("abort", leave, { once: true });
      inFlight.result.then(
        (value) => {
          signal.removeEventListener("abort", leave);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", leave);
          reject(error);
        },
      );
    });
  }

  private async executeDistinct(
    request: Request,
    cancelled: AbortSignal,
    deadline: AbortSignal | undefined,
  ): Promise<Result> {
    const signal = deadline === undefined ? cancelled : AbortSignal.any([cancelled, deadline]);
    try {
      signal.throwIfAborted();
      const refusal = await this.work.admit?.(request, signal);
      if (refusal !== undefined) return refusal;
      const lease = await this.activeRequests.acquire(signal);
      try {
        return await this.work.send(request, signal);
      } finally {
        lease.release();
      }
    } catch (error: unknown) {
      if (deadline?.aborted === true && !cancelled.aborted) throw new PearlAbyssCoordinatorDeadlineError();
      throw error;
    }
  }

  private remove(key: string, inFlight: InFlightRequest<Result>): void {
    if (this.pending.get(key) === inFlight) this.pending.delete(key);
  }
}

/**
 * The key the coordinator shares pending work by: the hex SHA-256 of the request's URL and body. A pending entry then
 * holds 64 characters of key, not a copy of the body.
 */
export async function pearlAbyssRequestKey(url: string, body: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${url}\n${body}`));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
