/**
 * Latency-aware JSON-RPC transport for HyperEVM.
 *
 * viem's `fallback` walks the list after a failure, and its `rank` option
 * pings on a timer. This transport orders endpoints from the calls it has
 * already made, then fails over. Once every endpoint has failed a call, it
 * backs off and tries them again while `retryCount` allows. Endpoints that
 * keep failing are ejected for a cooldown. Non-idempotent methods are never
 * retried and never hedged. Signed raw transactions are the exception: the
 * same bytes fail over on endpoint errors, since a rebroadcast cannot run twice.
 * @module
 */

import {
  createTransport,
  http,
  isHex,
  keccak256,
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
import {
  Breaker,
  type BreakerConfig,
  DEFAULT_BREAKER_COOLDOWN_MS,
  DEFAULT_BREAKER_MAX_COOLDOWN_MS,
  DEFAULT_BREAKER_THRESHOLD,
  retryAfterMs,
} from "./_breaker.ts";
import type { EndpointSnapshot, HyperevmEvent } from "./_events.ts";
import {
  isAbortError,
  isAlreadyKnownError,
  isIdempotentMethod,
  isRebroadcastMethod,
  shouldFailover,
  toError,
} from "./_methods.ts";
import { type ScoreConfig, defaultScoreConfig } from "./_score.ts";
import { type RankedEndpoint, Scoreboard, blockNumberFromResult } from "./_scoreboard.ts";

export type { EndpointSnapshot, HyperevmEvent } from "./_events.ts";
export {
  NON_IDEMPOTENT_METHODS,
  REBROADCAST_METHODS,
  isIdempotentMethod,
  isRebroadcastMethod,
  shouldFailover,
} from "./_methods.ts";
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

/** Extra attempts after the first, on idempotent methods and raw transaction rebroadcasts. */
const DEFAULT_RETRY_COUNT = 2;

/** First backoff before re-trying endpoints that already failed this call, when `retryDelay` is 0. */
const DEFAULT_RETRY_BACKOFF_MS = 100;

/** Longest wait before a re-try. A call stops instead of waiting out a longer ejection. */
const MAX_RETRY_BACKOFF_MS = 2_000;

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

export interface BreakerOptions {
  /** Consecutive endpoint failures that eject an endpoint. Default: 3. */
  threshold?: number | undefined;
  /** First ejection in milliseconds. Each later ejection doubles it. Default: 5000. */
  cooldown?: number | undefined;
  /** Longest ejection in milliseconds, including a `Retry-After`. Default: 60000. */
  maxCooldown?: number | undefined;
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
   * Extra attempts after the first, for idempotent methods and raw transaction rebroadcasts.
   * Each endpoint is tried once before any is tried again. Default: 2.
   */
  retryCount?: number | undefined;
  /**
   * Wait between failovers, in milliseconds. Default: 0.
   * Re-trying endpoints that already failed this call waits a jittered exponential backoff
   * from this base (100 when 0), capped at 2000, and at least any ejection left.
   */
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
   * Fail over `eth_sendRawTransaction` and `eth_sendRawTransactionSync` on endpoint errors.
   * The same signed bytes have the same hash, and the nonce stops a second execution.
   * They are never hedged. On a re-send, an "already known" answer returns the hash. Default: true.
   */
  rebroadcastRawTransactions?: boolean | undefined;
  /**
   * Eject an endpoint after consecutive failures, or for a `Retry-After`. Routing skips ejected
   * endpoints unless all are ejected, and a failed call does not fail over into one. Default: enabled.
   */
  breaker?: boolean | BreakerOptions | undefined;
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

function resolveBreaker(value: boolean | BreakerOptions | undefined): BreakerConfig {
  const options = typeof value === "object" ? value : {};
  return {
    enabled: value !== false,
    threshold: options.threshold ?? DEFAULT_BREAKER_THRESHOLD,
    cooldownMs: options.cooldown ?? DEFAULT_BREAKER_COOLDOWN_MS,
    maxCooldownMs: options.maxCooldown ?? DEFAULT_BREAKER_MAX_COOLDOWN_MS,
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
  const rebroadcastRaw = options.rebroadcastRawTransactions ?? true;
  const breakerConfig = resolveBreaker(options.breaker);

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
    const retryBackoff = retryDelay > 0 ? retryDelay : DEFAULT_RETRY_BACKOFF_MS;
    const breaker = new Breaker(breakerConfig, now);
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
        ejected: (id: string): boolean => breaker.isOpen(id),
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

    /** A healthy answer, including a terminal error, closes the circuit. */
    const closeCircuit = (endpoint: RankedEndpoint): void => {
      if (breaker.success(endpoint.id)) emit({ type: "restore", endpoint: endpoint.url });
    };

    const openCircuit = (endpoint: RankedEndpoint, error: Error): void => {
      const ejection = breaker.failure(endpoint.id, retryAfterMs(error, Date.now()));
      if (!ejection) return;
      emit({
        type: "eject",
        endpoint: endpoint.url,
        failures: ejection.failures,
        cooldownMs: ejection.cooldownMs,
        error,
      });
    };

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
              closeCircuit(endpoint);
            }
            return outcome.result;
          }
          const wrapped = state.timedOut && !state.ignore ? new TimeoutError(timeout) : toError(outcome.error);
          const callerAbort = parent?.aborted === true || isAbortError(wrapped);
          if (!state.ignore && !callerAbort) {
            // A terminal error is the endpoint answering about the call. It is not sick.
            const terminal = !shouldFailover(wrapped);
            if (terminal) {
              board.success(endpoint.id, method, latencyMs, sampleLatency);
            } else {
              board.failure(endpoint.id, method, latencyMs, sampleLatency, timeout);
            }
            emit({ type: "error", endpoint: endpoint.url, method, latencyMs, error: wrapped, terminal });
            if (terminal) closeCircuit(endpoint);
            else openCircuit(endpoint, wrapped);
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
      rebroadcast = false,
    ): Promise<unknown> => {
      const exclude = new Set<string>();
      const errors: Error[] = [];
      const retries = idempotent || rebroadcast;
      const attempts = retries ? retryCount + 1 : 1;
      let previous: RankedEndpoint | undefined;
      let round = 0;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        let endpoint = board.pick(method, exclude, attempt === 0 ? routing : "best", random);
        let wait = attempt > 0 ? retryDelay : 0;
        if (!endpoint && attempt > 0 && exclude.size > 0) {
          // Every eligible endpoint failed this call. Start another round after a backoff.
          exclude.clear();
          endpoint = board.pick(method, exclude, "best", random);
          if (!endpoint) break;
          const ejectedMs = breaker.remaining(endpoint.id);
          if (ejectedMs > MAX_RETRY_BACKOFF_MS) break;
          wait = Math.max(backoffMs(round, retryBackoff, random), ejectedMs);
          round += 1;
        } else if (endpoint && attempt > 0 && breaker.isOpen(endpoint.id)) {
          // Only ejected endpoints are left. Failing over into them amplifies an outage.
          break;
        }
        if (!endpoint) break;
        exclude.add(endpoint.id);
        if (previous) emit({ type: "failover", from: previous.url, to: endpoint.url, method });
        if (wait > 0) await delay(wait, parent);
        try {
          return await dispatch(endpoint, method, params, parent, idempotent, exclude);
        } catch (error: unknown) {
          const wrapped = toError(error);
          errors.push(wrapped);
          if (rebroadcast && attempt > 0 && isAlreadyKnownError(wrapped)) {
            // An earlier attempt delivered these bytes. Report the hash it would have returned.
            const hash = rebroadcastHash(method, params);
            if (hash) return hash;
          }
          const stop = !retries || !shouldFailover(wrapped) || options.shouldThrow?.(wrapped) === true;
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
        if (!next || breaker.isOpen(next.id)) return undefined;
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
          const rebroadcast = rebroadcastRaw && isRebroadcastMethod(method);
          const params = "params" in args ? args.params : undefined;
          return send(method, params, requestOptions?.signal, idempotent, rebroadcast);
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

/** Jittered exponential backoff: half to all of `base * 2^round`, capped. */
function backoffMs(round: number, base: number, random: () => number): number {
  const ceiling = Math.min(MAX_RETRY_BACKOFF_MS, base * 2 ** round);
  return Math.round(ceiling * (0.5 + random() * 0.5));
}

/** `keccak256` of the signed bytes, which is the hash `eth_sendRawTransaction` returns. */
function rebroadcastHash(method: string, params: unknown): string | undefined {
  if (method !== "eth_sendRawTransaction" || !Array.isArray(params)) return undefined;
  const raw: unknown = params[0];
  if (typeof raw !== "string" || !isHex(raw, { strict: true })) return undefined;
  return keccak256(raw);
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
