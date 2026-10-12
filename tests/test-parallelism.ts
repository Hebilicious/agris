/**
 * How many workers a test runner that may run in parallel uses: the
 * `AGRIS_TEST_WORKERS` environment variable. How much a machine can run at once is
 * the machine's to say, so the value comes from its shell environment, beside
 * `MOON_CONCURRENCY`, rather than from this repository. Where it is unset, one
 * worker runs. Suites that must run serially keep their own `1` and do not read
 * this.
 */
export const TEST_WORKERS: number = testWorkers(process.env.AGRIS_TEST_WORKERS);

/* BOUNDARY: an environment variable is external text; only a positive integer is a worker count. */
function testWorkers(value: string | undefined): number {
  if (value === undefined || value === "") return 1;
  const workers = Number(value);
  if (!Number.isSafeInteger(workers) || workers < 1) {
    throw new Error(`AGRIS_TEST_WORKERS must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return workers;
}
