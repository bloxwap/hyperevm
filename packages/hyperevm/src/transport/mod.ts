/**
 * Latency-aware JSON-RPC transport for HyperEVM.
 *
 * viem's `fallback` walks the list after a failure, and its `rank` option
 * pings on a timer. This transport orders endpoints from the calls it has
 * already made, then fails over. Non-idempotent methods are never retried
 * and never hedged.
 * @module
 */

import {
  createTransport,
  http,
  webSocket,
  type Chain,
  type EIP1193Parameters,
  type EIP1193RequestFn,
  type EIP1193RequestOptions,
  type Transport,
} from "viem";

import { AllEndpointsFailedError, TimeoutError } from "../_errors.ts";
import { registryHttpEndpoints } from "../registry/_registry.ts";
import { normalizeRpcUrl } from "../registry/_url.ts";
import type { EndpointSnapshot, HyperevmEvent } from "./_events.ts";
import { isAbortError, isIdempotentMethod, shouldFailover, toError } from "./_methods.ts";
import { type ScoreConfig, defaultScoreConfig } from "./_score.ts";
import { type RankedEndpoint, Scoreboard, blockNumberFromResult } from "./_scoreboard.ts";

export type { EndpointSnapshot, HyperevmEvent } from "./_events.ts";
export { NON_IDEMPOTENT_METHODS, isIdempotentMethod, shouldFailover } from "./_methods.ts";
export { blockNumberFromResult, parseQuantity } from "./_scoreboard.ts";
export { defaultScoreConfig, endpointScore, inflation, type MethodStat, type ScoreConfig } from "./_score.ts";

/** How long a head sample stays usable for lag penalties. */
const DEFAULT_STALE_MS = 30_000;

/** Blocks behind the best fresh head that are still treated as caught up. */
const DEFAULT_MAX_LAG = 2;

/** Background `eth_blockNumber` cadence. This refreshes heads. It is not the latency ranker. */
const DEFAULT_PROBE_MS = 4_000;

/** viem's HTTP default. Our own deadline races the child transport. */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Extra attempts after the first, on idempotent methods only. */
const DEFAULT_RETRY_COUNT = 2;

export interface HeadLagOptions {
  /** Blocks of lag that do not change the score. Default: 2. */
  maxLag?: number | undefined;
  /** Milliseconds between head probes. `false` disables the timer. Default: 4000. */
  probeInterval?: number | false | undefined;
  /** Heads older than this stop affecting the score. Default: 30000. */
  staleMs?: number | undefined;
}

export interface HedgeOptions {
  /** Minimum wait before a second endpoint is tried. Default: 250. */
  minDelay?: number | undefined;
  /** After three samples, hedge once the call exceeds this multiple of the tail. Default: 2. */
  multiplier?: number | undefined;
}

export interface BatchOptions {
  /** Maximum JSON-RPC calls per HTTP request. Default: 1000, matching viem. */
  batchSize?: number | undefined;
  /** Milliseconds to wait for more calls before sending the batch. Default: 0. */
  wait?: number | undefined;
}

/** Options for {@link hyperevm}. Every field is optional. */
export interface HyperevmTransportOptions {
  /**
   * URLs or viem transports. URLs become `http()` or `webSocket()`.
   * Default: eligible HTTP endpoints from the shipped registry.
   */
  endpoints?: readonly (string | Transport)[] | undefined;
  /** Passed to viem `http()` for URL endpoints. Default: off, same as viem's `http()`. */
  batch?: boolean | BatchOptions | undefined;
  /** Replaces `fetch` for URL endpoints. Tests use this. */
  fetchFn?: ((input: string | URL | Request, init?: RequestInit) => Promise<Response>) | undefined;
  /** Transport key. Default: `"hyperevm"`. */
  key?: string | undefined;
  /** Transport name. Default: `"HyperEVM"`. */
  name?: string | undefined;
  /**
   * Extra failovers after the first attempt, for idempotent methods.
   * The same endpoint is not tried twice in one call. Default: 2.
   */
  retryCount?: number | undefined;
  /** Wait between failovers, in milliseconds. Default: 0. */
  retryDelay?: number | undefined;
  /** Per-attempt deadline in milliseconds. Default: the client timeout, or 10000. */
  timeout?: number | undefined;
  /** Score `eth_call` and `eth_getLogs` separately. Default: true. */
  perMethod?: boolean | undefined;
  /** Deprioritize endpoints behind the best known head. Default: enabled. */
  headLag?: boolean | HeadLagOptions | undefined;
  /** Send a second idempotent read when the first is slower than usual. Default: off. */
  hedge?: boolean | HedgeOptions | undefined;
  /** `"best"` always uses the lowest score. `"p2c"` draws two endpoints and keeps the better one. Default: `"p2c"`. */
  routing?: "best" | "p2c" | undefined;
  /** Extra methods that must not be retried or hedged. */
  nonIdempotentMethods?: readonly string[] | undefined;
  /**
   * Return true to stop failover, matching viem `fallback`'s `shouldThrow`.
   * Terminal errors (reverts, invalid params, aborts) already stop failover.
   */
  shouldThrow?: ((error: Error) => boolean) | undefined;
  /** Called for routing events. Exceptions are swallowed. */
  onEvent?: ((event: HyperevmEvent) => void) | undefined;
  /** Overrides for the latency score. Defaults live in {@link defaultScoreConfig}. */
  score?: Partial<ScoreConfig> | undefined;
  /** Clock used for latency samples. Tests inject this. */
  now?: (() => number) | undefined;
  /** Source of randomness for power-of-two-choices. Default: `Math.random`. */
  random?: (() => number) | undefined;
}

/** Extra fields on the transport value, beside viem's config. */
export interface HyperevmTransportValue {
  /** Subscribe to routing events. Returns an unsubscribe function. */
  onEvent: (listener: (event: HyperevmEvent) => void) => () => void;
  /** Current scores, heads, and in-flight counts. */
  snapshot: () => readonly EndpointSnapshot[];
  /** Endpoints this transport was built with. */
  endpoints: readonly { id: string; url: string; weight: number }[];
  /**
   * Probe every endpoint's head once.
   * The background timer calls this on `probeInterval`. A failed probe updates liveness and does not write the latency EWMA.
   */
  probe: () => Promise<void>;
}

interface ResolvedHeadLag {
  enabled: boolean;
  maxLag: number;
  probeInterval: number | false;
  staleMs: number;
}

interface ResolvedHedge {
  enabled: boolean;
  minDelay: number;
  multiplier: number;
}

interface BuiltEndpoint {
  id: string;
  url: string;
  weight: number;
  request: (args: { method: string; params?: unknown }, options?: { signal?: AbortSignal }) => Promise<unknown>;
  supports: (method: string) => boolean;
}

interface Inflight {
  promise: Promise<unknown>;
  cancel: () => void;
  cancelled: () => boolean;
}

function resolveHeadLag(value: boolean | HeadLagOptions | undefined): ResolvedHeadLag {
  if (value === false) {
    return { enabled: false, maxLag: DEFAULT_MAX_LAG, probeInterval: false, staleMs: DEFAULT_STALE_MS };
  }
  const options = value === true || value === undefined ? {} : value;
  return {
    enabled: true,
    maxLag: options.maxLag ?? DEFAULT_MAX_LAG,
    probeInterval: options.probeInterval === undefined ? DEFAULT_PROBE_MS : options.probeInterval,
    staleMs: options.staleMs ?? DEFAULT_STALE_MS,
  };
}

function resolveHedge(value: boolean | HedgeOptions | undefined): ResolvedHedge {
  if (!value) return { enabled: false, minDelay: 250, multiplier: 2 };
  const options = value === true ? {} : value;
  return {
    enabled: true,
    minDelay: options.minDelay ?? 250,
    multiplier: options.multiplier ?? 2,
  };
}

function unrefTimer(timer: ReturnType<typeof setInterval>): void {
  if (typeof timer === "object" && timer !== null && "unref" in timer && typeof timer.unref === "function") {
    timer.unref();
  }
}

function supportsMethod(
  methods: { include?: readonly string[] | undefined; exclude?: readonly string[] | undefined } | undefined,
  method: string,
): boolean {
  if (!methods) return true;
  if (methods.include) return methods.include.includes(method);
  if (methods.exclude) return !methods.exclude.includes(method);
  return true;
}

function weightFor(url: string, explicit: boolean): number {
  const normalized = normalizeRpcUrl(url).url;
  const found = registryHttpEndpoints().find((endpoint) => endpoint.url === normalized);
  if (!found) return 1;
  if (explicit) return found.weight > 0 ? found.weight : 1;
  return found.weight;
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  const error = new Error("This operation was aborted");
  error.name = "AbortError";
  return error;
}

function linkAbort(controller: AbortController, signal: AbortSignal | undefined): void {
  if (!signal) return;
  if (signal.aborted) {
    controller.abort(signal.reason);
    return;
  }
  signal.addEventListener(
    "abort",
    () => {
      controller.abort(signal.reason);
    },
    { once: true },
  );
}

/**
 * viem `Transport` for HyperEVM (chain id 999).
 *
 * ```ts
 * import { createPublicClient } from "viem";
 * import { hyperEvm } from "viem/chains";
 * import { hyperevm } from "@bloxwap/hyperevm";
 *
 * const client = createPublicClient({
 *   chain: hyperEvm,
 *   transport: hyperevm(),
 * });
 * ```
 */
export function hyperevm(options: HyperevmTransportOptions = {}): Transport<"hyperevm", HyperevmTransportValue> {
  const headLag = resolveHeadLag(options.headLag);
  const hedge = resolveHedge(options.hedge);
  const routing = options.routing ?? "p2c";
  const perMethod = options.perMethod ?? true;
  const now = options.now ?? ((): number => Date.now());
  const random = options.random ?? Math.random;
  const extraNonIdempotent = options.nonIdempotentMethods ?? [];

  return (parameters: {
    account?: unknown;
    chain?: Chain | undefined;
    pollingInterval?: number | undefined;
    retryCount?: number | undefined;
    timeout?: number | undefined;
  }) => {
    const timeout = parameters.timeout ?? options.timeout ?? DEFAULT_TIMEOUT_MS;
    const retryCount = options.retryCount ?? parameters.retryCount ?? DEFAULT_RETRY_COUNT;
    const retryDelay = options.retryDelay ?? 0;
    const built = buildEndpoints(options, parameters.chain, timeout);
    if (built.length === 0) {
      throw new Error("hyperevm() requires at least one endpoint. The registry has none eligible.");
    }
    const board = new Scoreboard(
      built.map((endpoint, index) => ({
        id: endpoint.id,
        url: endpoint.url,
        weight: endpoint.weight,
        index,
        supports: endpoint.supports,
      })),
      {
        perMethod,
        headLag: headLag.enabled,
        maxLag: headLag.maxLag,
        staleMs: headLag.staleMs,
        config: { ...defaultScoreConfig, ...options.score },
        now,
      },
    );
    const listeners = new Set<(event: HyperevmEvent) => void>();

    const emit = (event: HyperevmEvent): void => {
      try {
        options.onEvent?.(event);
      } catch (error) {
        void error;
      }
      for (const listener of listeners) {
        try {
          listener(event);
        } catch (error) {
          void error;
        }
      }
    };

    const byId = new Map(built.map((endpoint) => [endpoint.id, endpoint]));

    const start = (
      endpoint: RankedEndpoint,
      method: string,
      params: unknown,
      parent: AbortSignal | undefined,
      hedged: boolean,
      sampleLatency: boolean,
    ): Inflight => {
      const state = { ignore: false, timedOut: false };
      const controller = new AbortController();
      linkAbort(controller, parent);
      const timer = setTimeout(() => {
        state.timedOut = true;
        controller.abort();
      }, timeout);
      unrefTimer(timer as ReturnType<typeof setInterval>);
      const target = byId.get(endpoint.id);
      if (!target) throw new Error(`Unknown HyperEVM endpoint: ${endpoint.id}`);
      board.begin(endpoint.id);
      emit({ type: "request", endpoint: endpoint.url, method });
      const started = now();
      // The child sees the caller's signal only. A private AbortController would
      // change viem's HTTP batch key on every call, so batches would never form.
      // The deadline below still fails the attempt over when the child ignores the signal.
      const requestPromise = Promise.resolve().then(() =>
        target.request({ method, params }, parent ? { signal: parent } : undefined),
      );
      const abortPromise = new Promise<never>((_resolve, reject) => {
        const fail = (): void => reject(abortError(controller.signal));
        if (controller.signal.aborted) {
          fail();
          return;
        }
        controller.signal.addEventListener("abort", fail, { once: true });
      });
      const abortSettled = abortPromise.catch((error: unknown) => error);
      const promise = Promise.race([
        requestPromise.then(
          (result) => ({ kind: "result" as const, result, error: undefined }),
          (error: unknown) => ({ kind: "error" as const, result: undefined, error }),
        ),
        abortSettled.then((error) => ({ kind: "abort" as const, result: undefined, error })),
      ])
        .then((outcome) => {
          const latencyMs = Math.max(0, now() - started);
          if (outcome.kind === "result") {
            if (!state.ignore) {
              board.success(endpoint.id, method, latencyMs, sampleLatency);
              const block = blockNumberFromResult(method, outcome.result);
              if (block !== null && headLag.enabled) {
                const head = board.noteHead(endpoint.id, block);
                emit({ type: "head", endpoint: endpoint.url, head: block, best: head.best, lag: head.lag });
              }
              emit({ type: "success", endpoint: endpoint.url, method, latencyMs, hedged });
            }
            return outcome.result;
          }
          const wrapped = state.timedOut && !state.ignore ? new TimeoutError(timeout) : toError(outcome.error);
          const callerAbort = parent?.aborted === true || isAbortError(wrapped);
          if (!state.ignore && !callerAbort) {
            board.failure(endpoint.id, method, latencyMs, sampleLatency, timeout);
            emit({ type: "error", endpoint: endpoint.url, method, latencyMs, error: wrapped });
          }
          throw wrapped;
        })
        .finally(() => {
          clearTimeout(timer);
          if (!controller.signal.aborted) controller.abort();
          board.end(endpoint.id);
        });
      return {
        promise,
        cancelled: (): boolean => state.ignore,
        cancel(): void {
          state.ignore = true;
          clearTimeout(timer);
          controller.abort();
        },
      };
    };

    const send = async (
      method: string,
      params: unknown,
      parent: AbortSignal | undefined,
      idempotent: boolean,
    ): Promise<unknown> => {
      const exclude = new Set<string>();
      const errors: Error[] = [];
      const attempts = idempotent ? retryCount + 1 : 1;
      let previous: RankedEndpoint | undefined;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const endpoint = board.pick(method, exclude, attempt === 0 ? routing : "best", random);
        if (!endpoint) break;
        exclude.add(endpoint.id);
        if (previous) emit({ type: "failover", from: previous.url, to: endpoint.url, method });
        if (attempt > 0 && retryDelay > 0) await delay(retryDelay, parent);
        try {
          return await dispatch(endpoint, method, params, parent, idempotent, exclude);
        } catch (error: unknown) {
          const wrapped = toError(error);
          errors.push(wrapped);
          const stop = !idempotent || !shouldFailover(wrapped) || options.shouldThrow?.(wrapped) === true;
          if (stop) throw wrapped;
          previous = endpoint;
        }
      }
      if (errors.length === 1) {
        const only = errors[0];
        if (only) throw only;
      }
      throw new AllEndpointsFailedError(errors);
    };

    const dispatch = (
      endpoint: RankedEndpoint,
      method: string,
      params: unknown,
      parent: AbortSignal | undefined,
      idempotent: boolean,
      exclude: Set<string>,
    ): Promise<unknown> => {
      const primary = start(endpoint, method, params, parent, false, true);
      if (!hedge.enabled || !idempotent) return primary.promise;
      const wait = board.hedgeDelay(endpoint.id, method, hedge.minDelay, hedge.multiplier);
      return raceHedge(primary, wait, () => {
        const next = board.pick(method, exclude, "best", random);
        if (!next) return undefined;
        emit({ type: "hedge", endpoint: next.url, method });
        exclude.add(next.id);
        return start(next, method, params, parent, true, true);
      });
    };

    const probe = (): Promise<void> => {
      const pending = built.map((endpoint) =>
        start(endpoint, "eth_blockNumber", [], undefined, false, false).promise.then(
          () => undefined,
          () => undefined,
        ),
      );
      return Promise.all(pending).then(() => undefined);
    };

    if (headLag.enabled && headLag.probeInterval !== false && headLag.probeInterval > 0) {
      const timer = setInterval(() => {
        void probe();
      }, headLag.probeInterval);
      unrefTimer(timer);
    }

    const value: HyperevmTransportValue = {
      onEvent(listener: (event: HyperevmEvent) => void): () => void {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      snapshot: () => board.snapshot("eth_call"),
      endpoints: built.map((endpoint) => ({ id: endpoint.id, url: endpoint.url, weight: endpoint.weight })),
      probe,
    };

    return createTransport(
      {
        key: options.key ?? "hyperevm",
        name: options.name ?? "HyperEVM",
        retryCount: 0,
        retryDelay,
        timeout,
        type: "hyperevm",
        request: (async (args: EIP1193Parameters, requestOptions?: EIP1193RequestOptions): Promise<unknown> => {
          const method = args.method;
          const idempotent = isIdempotentMethod(method, extraNonIdempotent);
          return send(method, "params" in args ? args.params : undefined, requestOptions?.signal, idempotent);
        }) as EIP1193RequestFn,
      },
      value,
    );
  };
}

function raceHedge(primary: Inflight, waitMs: number, startHedge: () => Inflight | undefined): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let pending = 1;
    let settled = false;
    let hedge: Inflight | undefined;
    let primaryError: Error | undefined;
    const timer = setTimeout(() => {
      if (settled) return;
      hedge = startHedge();
      if (!hedge) return;
      pending += 1;
      hedge.promise.then(
        (result) => finish(result, primary),
        (error: unknown) => fail(hedge, toError(error), false),
      );
    }, waitMs);

    const finish = (result: unknown, loser: Inflight | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      loser?.cancel();
      resolve(result);
    };

    const fail = (call: Inflight | undefined, error: Error, isPrimary: boolean): void => {
      if (call?.cancelled()) return;
      if (settled) return;
      if (isPrimary) primaryError = error;
      pending -= 1;
      if (pending > 0) return;
      settled = true;
      clearTimeout(timer);
      hedge?.cancel();
      reject(primaryError ?? error);
    };

    primary.promise.then(
      (result) => finish(result, hedge),
      (error: unknown) => {
        clearTimeout(timer);
        fail(primary, toError(error), true);
      },
    );
  });
}

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (!signal) return;
    if (signal.aborted) {
      clearTimeout(timer);
      reject(toError(signal.reason ?? new Error("This operation was aborted")));
      return;
    }
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        const reason = signal.reason;
        if (reason instanceof Error) {
          reject(reason);
          return;
        }
        const error = new Error("This operation was aborted");
        error.name = "AbortError";
        reject(error);
      },
      { once: true },
    );
  });
}

function buildEndpoints(options: HyperevmTransportOptions, chain: Chain | undefined, timeout: number): BuiltEndpoint[] {
  const explicit = options.endpoints !== undefined;
  const inputs: readonly (string | Transport)[] =
    options.endpoints ?? registryHttpEndpoints().map((endpoint) => endpoint.url);
  const built: BuiltEndpoint[] = [];
  inputs.forEach((input, index) => {
    const transport = toChildTransport(input, options, timeout);
    const instance = transport({ chain, retryCount: 0, timeout });
    const url = endpointUrl(instance.value, input, index);
    const weight = typeof input === "string" ? weightFor(input, explicit) : 1;
    if (!explicit && weight <= 0) return;
    const methods = instance.config.methods as { include?: readonly string[]; exclude?: readonly string[] } | undefined;
    built.push({
      id: url,
      url,
      weight,
      supports: (method: string): boolean => supportsMethod(methods, method),
      request: instance.request as BuiltEndpoint["request"],
    });
  });
  return built;
}

function toChildTransport(input: string | Transport, options: HyperevmTransportOptions, timeout: number): Transport {
  if (typeof input !== "string") return input;
  const normalized = normalizeRpcUrl(input);
  if (normalized.kind === "websocket") return webSocket(normalized.url);
  return http(normalized.url, {
    batch: options.batch,
    fetchFn: options.fetchFn,
    retryCount: 0,
    timeout,
  });
}

function endpointUrl(value: unknown, input: string | Transport, index: number): string {
  if (typeof input === "string") return normalizeRpcUrl(input).url;
  if (typeof value === "object" && value !== null && "url" in value && typeof value.url === "string") {
    return value.url;
  }
  return `transport:${index}`;
}
