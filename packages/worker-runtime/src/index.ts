export type WorkerTimeoutResult<Value> =
  | { readonly timedOut: false; readonly value: Value }
  | { readonly timedOut: true; readonly settled: Promise<void> };

export interface WorkerTimeoutPort {
  run<Value>(
    timeoutMs: number,
    operation: (signal: AbortSignal) => Promise<Value>,
  ): Promise<WorkerTimeoutResult<Value>>;
}

export function createWorkerTimeoutPort(): WorkerTimeoutPort {
  return {
    run: async (timeoutMs, operation) => {
      const controller = new AbortController();
      const pending = operation(controller.signal);
      const settled = pending.then(
        () => undefined,
        () => undefined,
      );
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          pending.then((value) => ({ timedOut: false as const, value })),
          new Promise<{ readonly timedOut: true }>((resolve) => {
            timeout = setTimeout(() => {
              controller.abort();
              resolve({ timedOut: true });
            }, timeoutMs);
          }),
        ]);
        return result.timedOut ? { timedOut: true, settled } : result;
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
    },
  };
}
