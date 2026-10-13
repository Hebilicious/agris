import {
  BoundedConnectionPool,
  InvocationBudget,
  invocationBudgetReservation,
  MarketSummaryOperationBudget,
  marketSummaryReservation,
  type ConnectionLease,
  type InvocationBudgetReservation,
  type MarketSummaryReservation,
} from "@agris/invocation-budget";
import { createActor, createAsyncLogic, setup, types } from "xstate";

export const MAXIMUM_SERVICE_BINDING_CONNECTIONS = 6;
export const MAXIMUM_GATEWAY_REQUEST_BYTES = 64 * 1_024;
export const MAXIMUM_GATEWAY_RESPONSE_BYTES = 1_024 * 1_024;

export interface GatewayRequestBodySource {
  readonly body: ReadableStream<Uint8Array> | null;
  readonly headers: Headers;
  readonly method: string;
}

export interface GatewayResponseBodySource {
  readonly body: ReadableStream<Uint8Array> | null;
  readonly headers: Headers;
}

export type BoundedGatewayResponseBody =
  | { readonly ok: true; readonly body: string }
  | { readonly ok: false; readonly code: "response-too-large"; readonly status: 502 };

export async function readBoundedGatewayResponseBody(
  response: GatewayResponseBodySource,
): Promise<BoundedGatewayResponseBody> {
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAXIMUM_GATEWAY_RESPONSE_BYTES) {
    await cancelBody(response.body);
    return { ok: false, code: "response-too-large", status: 502 };
  }
  const body = await readBoundedUtf8Body(response.body, MAXIMUM_GATEWAY_RESPONSE_BYTES);
  return body === undefined ? { ok: false, code: "response-too-large", status: 502 } : { ok: true, body };
}

export async function readBoundedGatewayRequestBody(
  request: GatewayRequestBodySource,
): Promise<string | null | undefined> {
  if (request.method === "GET") return null;
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAXIMUM_GATEWAY_REQUEST_BYTES) {
    await cancelBody(request.body);
    return undefined;
  }
  return readBoundedUtf8Body(request.body, MAXIMUM_GATEWAY_REQUEST_BYTES);
}

async function readBoundedUtf8Body(
  body: ReadableStream<Uint8Array> | null,
  maximumBytes: number,
): Promise<string | undefined> {
  if (body === null) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > maximumBytes) {
        await cancelReader(reader);
        return undefined;
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function cancelBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  try {
    await body?.cancel();
  } catch {
    // Cancellation is cleanup; rejection must not replace the explicit too-large result.
  }
}

async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // Cancellation is cleanup; rejection must not replace the explicit too-large result.
  }
}

export type ServiceBindingFailureCode =
  | "service-binding/budget-exceeded"
  | "service-binding/timeout"
  | "service-binding/unavailable";

export class ServiceBindingFailure extends Error {
  public constructor(public readonly code: ServiceBindingFailureCode) {
    super("Central Market subgraph unavailable");
    this.name = "ServiceBindingFailure";
  }
}

export interface ServiceBindingPort {
  fetch(
    request: Request,
    reserveBudget: InvocationBudgetReservation,
    reserveMarketSummary: MarketSummaryReservation,
  ): Promise<Response>;
}

export interface ServiceBindingTimeoutPort {
  run<Value>(
    timeoutMs: number,
    operation: (signal: AbortSignal) => Promise<Value>,
  ): Promise<
    { readonly timedOut: false; readonly value: Value } | { readonly timedOut: true; readonly settled: Promise<void> }
  >;
}

export interface ServiceBindingCoordinatorInput {
  readonly bindings: ReadonlyMap<string, ServiceBindingPort>;
  readonly budget?: InvocationBudget;
  readonly marketSummaryBudget?: MarketSummaryOperationBudget;
  readonly timeout: ServiceBindingTimeoutPort;
  readonly timeoutMs: number;
}

export class ServiceBindingCoordinator {
  private readonly reserveBudget: InvocationBudgetReservation;
  private readonly reserveMarketSummary: MarketSummaryReservation;
  private readonly connections = new BoundedConnectionPool(MAXIMUM_SERVICE_BINDING_CONNECTIONS);
  private readonly pending = new Map<string, Promise<Response>>();

  public constructor(private readonly input: ServiceBindingCoordinatorInput) {
    this.reserveBudget = invocationBudgetReservation(input.budget ?? new InvocationBudget());
    this.reserveMarketSummary = marketSummaryReservation(
      input.marketSummaryBudget ?? new MarketSummaryOperationBudget(),
    );
  }

  public fetch(url: string, init?: RequestInit): Promise<Response> {
    const binding = this.input.bindings.get(url);
    if (binding === undefined) return Promise.reject(new ServiceBindingFailure("service-binding/unavailable"));
    const request = new Request(url, normalizedRequestInit(init));
    const key = requestIdentity(request, init?.body);
    const existing = this.pending.get(key);
    if (existing !== undefined) return existing.then(cloneResponse);
    const pending = this.reserveAndExecute(binding, request);
    this.pending.set(key, pending);
    return pending.then(cloneResponse);
  }

  private async execute(binding: ServiceBindingPort, request: Request): Promise<Response> {
    return runServiceBindingLifecycle({
      binding,
      connections: this.connections,
      request,
      timeout: this.input.timeout,
      timeoutMs: this.input.timeoutMs,
      reserveBudget: this.reserveBudget,
      reserveMarketSummary: this.reserveMarketSummary,
    });
  }

  private async reserveAndExecute(binding: ServiceBindingPort, request: Request): Promise<Response> {
    if (!(await this.reserveBudget(1)).ok) {
      throw new ServiceBindingFailure("service-binding/budget-exceeded");
    }
    return this.execute(binding, request);
  }
}

type ServiceBindingExecutionOutcome =
  | { readonly timedOut: true; readonly settled: Promise<void> }
  | { readonly timedOut: false; readonly value: Response };

type ServiceBindingLifecycleOutcome =
  | { readonly ok: true; readonly value: Response }
  | { readonly ok: false; readonly error: ServiceBindingFailure };

interface ServiceBindingLifecycleContext {
  readonly lease: ConnectionLease | null;
  readonly outcome: ServiceBindingLifecycleOutcome | null;
  readonly settled: Promise<void> | null;
}

interface ServiceBindingLifecycleInput {
  readonly binding: ServiceBindingPort;
  readonly connections: BoundedConnectionPool;
  readonly request: Request;
  readonly reserveBudget: InvocationBudgetReservation;
  readonly reserveMarketSummary: MarketSummaryReservation;
  readonly timeout: ServiceBindingTimeoutPort;
  readonly timeoutMs: number;
}

function runServiceBindingLifecycle(input: ServiceBindingLifecycleInput): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const lifecycle = createActor(
      createServiceBindingLifecycleMachine(input, (outcome) => {
        if (outcome.ok) resolve(outcome.value);
        else reject(outcome.error);
      }),
    );
    lifecycle.start();
  });
}

function createServiceBindingLifecycleMachine(
  input: ServiceBindingLifecycleInput,
  publish: (outcome: ServiceBindingLifecycleOutcome) => void,
) {
  return setup({
    schemas: { context: types<ServiceBindingLifecycleContext>() },
    actors: {
      acquireConnection: createAsyncLogic({ run: async () => input.connections.acquire() }),
      executeBinding: createAsyncLogic({ run: async () => executeServiceBinding(input) }),
      awaitLateSettlement: createAsyncLogic<void, Promise<void>>({
        run: async ({ input: settled }) => {
          try {
            await settled;
          } catch {
            // A rejected upstream operation has still settled and can release its connection.
          }
        },
      }),
    },
    actions: {
      publishOutcome: ({ context }: { context: ServiceBindingLifecycleContext }) =>
        publish(requireServiceBindingLifecycleOutcome(context.outcome)),
      releaseConnection: (args: { context: ServiceBindingLifecycleContext }) => ({
        context: {
          lease: (({ context }) => {
            context.lease?.release();
            return null;
          })(args),
        } satisfies Partial<ServiceBindingLifecycleContext>,
      }),
    },
  }).createMachine({
    id: "service-binding-request",
    context: { lease: null, outcome: null, settled: null },
    initial: "waiting",
    states: {
      waiting: {
        invoke: {
          src: "acquireConnection",
          onDone: (args) => {
            const context = {
              ...args.context,
              ...({ lease: (({ event }) => event.output)(args) } satisfies Partial<ServiceBindingLifecycleContext>),
            };
            return { target: "executing", context };
          },
          onError: (args) => {
            const context = {
              ...args.context,
              ...({
                outcome: (() => serviceBindingLifecycleFailure("service-binding/unavailable"))(),
              } satisfies Partial<ServiceBindingLifecycleContext>),
            };
            return { target: "failed", context };
          },
        },
      },
      executing: {
        invoke: {
          src: "executeBinding",
          onDone: (args) => {
            if ((({ event }) => event.output.timedOut)(args)) {
              const context = {
                ...args.context,
                ...({
                  outcome: (() => serviceBindingLifecycleFailure("service-binding/timeout"))(),
                  settled: (({ event }) => requireLateSettlement(event.output))(args),
                } satisfies Partial<ServiceBindingLifecycleContext>),
              };
              return { target: "timedOutAwaitingSettlement", context };
            }
            const context = {
              ...args.context,
              ...({
                outcome: (({ event }) => ({ ok: true as const, value: requireBindingResponse(event.output) }))(args),
              } satisfies Partial<ServiceBindingLifecycleContext>),
            };
            return { target: "succeeded", context };
          },
          onError: (args) => {
            const context = {
              ...args.context,
              ...({
                outcome: (({ event }) => ({
                  ok: false,
                  error:
                    event.error instanceof ServiceBindingFailure
                      ? event.error
                      : new ServiceBindingFailure("service-binding/unavailable"),
                }))(args),
              } satisfies Partial<ServiceBindingLifecycleContext>),
            };
            return { target: "failed", context };
          },
        },
      },
      timedOutAwaitingSettlement: {
        entry: (args, enq) => {
          enq(args.actions.publishOutcome, args);
          return {};
        },
        invoke: {
          src: "awaitLateSettlement",
          input: ({ context }) => requireLateSettlementPromise(context.settled),
          onDone: { target: "released" },
          onError: { target: "released" },
        },
      },
      succeeded: {
        entry: (args, enq) => {
          enq(args.actions.publishOutcome, args);
          return {};
        },
        always: { target: "released" },
      },
      failed: {
        entry: (args, enq) => {
          enq(args.actions.publishOutcome, args);
          return {};
        },
        always: { target: "released" },
      },
      released: {
        type: "final",
        entry: (args) => {
          const context = { ...args.context, ...args.actions.releaseConnection(args).context };
          return { context };
        },
      },
    },
  });
}

async function executeServiceBinding(input: ServiceBindingLifecycleInput): Promise<ServiceBindingExecutionOutcome> {
  const timed = await input.timeout.run(input.timeoutMs, () =>
    input.binding.fetch(input.request, input.reserveBudget, input.reserveMarketSummary),
  );
  if (timed.timedOut) return timed;
  if (timed.value.status >= 500) throw new ServiceBindingFailure("service-binding/unavailable");
  return timed;
}

function serviceBindingLifecycleFailure(code: ServiceBindingFailureCode): ServiceBindingLifecycleOutcome {
  return { ok: false, error: new ServiceBindingFailure(code) };
}

function requireServiceBindingLifecycleOutcome(
  outcome: ServiceBindingLifecycleOutcome | null,
): ServiceBindingLifecycleOutcome {
  return outcome ?? serviceBindingLifecycleFailure("service-binding/unavailable");
}

function requireLateSettlement(outcome: ServiceBindingExecutionOutcome): Promise<void> {
  if (!outcome.timedOut) throw new TypeError("Service Binding operation did not time out");
  return outcome.settled;
}

function requireLateSettlementPromise(settled: Promise<void> | null): Promise<void> {
  if (settled === null) throw new TypeError("Timed-out Service Binding operation has no settlement promise");
  return settled;
}

function requireBindingResponse(outcome: ServiceBindingExecutionOutcome): Response {
  if (outcome.timedOut) throw new TypeError("Timed-out Service Binding operation has no response");
  return outcome.value;
}

function normalizedRequestInit(init: RequestInit | undefined): RequestInit {
  const headers = new Headers(init?.headers);
  return {
    method: "POST",
    headers: {
      Accept: "application/graphql-response+json",
      "Content-Type": headers.get("content-type") ?? "application/json; charset=utf-8",
    },
    ...(init?.body === undefined || init.body === null ? undefined : { body: init.body }),
  };
}

/* BOUNDARY: Validates or normalizes external data before owned code consumes it. */ function requestIdentity(
  request: Request,
  body: BodyInit | null | undefined,
): string {
  if (body !== undefined && body !== null && typeof body !== "string") {
    throw new TypeError("Service Binding request bodies must be canonical strings");
  }
  return `${request.url}\n${body ?? ""}`;
}

function cloneResponse(response: Response): Response {
  return response.clone();
}
