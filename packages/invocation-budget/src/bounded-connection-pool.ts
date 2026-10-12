export interface ConnectionLease {
  release(): void;
  releaseAfter(settled: Promise<void>): void;
}

export class BoundedConnectionPool {
  private active = 0;
  private readonly waiters: (() => void)[] = [];

  public constructor(private readonly maximum: number) {
    if (!Number.isSafeInteger(maximum) || maximum <= 0) {
      throw new RangeError("Maximum active connections must be a positive safe integer");
    }
  }

  public async acquire(): Promise<ConnectionLease> {
    if (this.active < this.maximum) {
      this.active += 1;
    } else {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    return new BoundedConnectionLease(() => this.release());
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next === undefined) {
      this.active -= 1;
      return;
    }
    next();
  }
}

type ConnectionLeaseState = "owned" | "deferred" | "released";

class BoundedConnectionLease implements ConnectionLease {
  private state: ConnectionLeaseState = "owned";

  public constructor(private readonly releasePermit: () => void) {}

  public release(): void {
    if (this.state !== "owned") throw new TypeError("Connection lease is not directly releasable");
    this.state = "released";
    this.releasePermit();
  }

  public releaseAfter(settled: Promise<void>): void {
    if (this.state !== "owned") throw new TypeError("Connection lease release is already scheduled");
    this.state = "deferred";
    void settled.then(
      () => this.settleDeferredRelease(),
      () => this.settleDeferredRelease(),
    );
  }

  private settleDeferredRelease(): void {
    if (this.state !== "deferred") return;
    this.state = "released";
    this.releasePermit();
  }
}
