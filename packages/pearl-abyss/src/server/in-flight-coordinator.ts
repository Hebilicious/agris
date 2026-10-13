import { BoundedConnectionPool } from "@agris/invocation-budget";

export type PearlAbyssRequestExecutor<Request, Result> = (request: Request) => Promise<Result>;

/**
 * Shares matching pending requests and queues distinct requests behind one
 * configurable active-work ceiling.
 *
 * State progression: pending -> queued -> active -> settled. Settled work is
 * removed immediately, so this coordinator never becomes a response cache.
 */
export class PearlAbyssInFlightCoordinator<Request, Result> {
  private readonly activeRequests: BoundedConnectionPool;
  private readonly pending = new Map<string, Promise<Result>>();

  public constructor(
    maximumActiveRequests: number,
    private readonly executeRequest: PearlAbyssRequestExecutor<Request, Result>,
  ) {
    this.activeRequests = new BoundedConnectionPool(maximumActiveRequests);
  }

  public execute(key: string, request: Request): Promise<Result> {
    const existing = this.pending.get(key);
    if (existing !== undefined) return existing;

    const operation = this.executeDistinct(request);
    this.pending.set(key, operation);
    void operation.then(
      () => this.removeSettled(key, operation),
      () => this.removeSettled(key, operation),
    );
    return operation;
  }

  private async executeDistinct(request: Request): Promise<Result> {
    const lease = await this.activeRequests.acquire();
    try {
      return await this.executeRequest(request);
    } finally {
      lease.release();
    }
  }

  private removeSettled(key: string, operation: Promise<Result>): void {
    if (this.pending.get(key) === operation) this.pending.delete(key);
  }
}
