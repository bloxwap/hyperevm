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

import { AllEndpointsFailedError, ChainMismatchError, TimeoutError } from "../_errors.ts";
import { defaultRegistry, registryHttpEndpoints } from "../registry/_registry.ts";
import { type EndpointUrl, normalizeEndpointUrl } from "../registry/_url.ts";
import type { EndpointSnapshot, HyperevmEvent } from "./_events.ts";
import { isAbortError, isIdempotentMethod, shouldFailover, toError } from "./_methods.ts";
import { type ScoreConfig, defaultScoreConfig } from "./_score.ts";
import {
  DEFAULT_MAX_AHEAD,
  type RankedEndpoint,
  Scoreboard,
  blockNumberFromResult,
  parseQuantity,
} from "./_scoreboard.ts";

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

/** Chain id endpoints must report when the client has no chain. */
const DEFAULT_CHAIN_ID = 999;

export interface HeadLagOptions {
  /** Blocks of lag that do not change the score. Default: 2. */
  maxLag?: number | undefined;
  /** Milliseconds between head probes. `false` disables the timer. Default: 4000. */
  probeInterval?: number | false | undefined;
  /** Heads older than this stop affecting the score. Default: 30000. */
  staleMs?: number | undefined;
  /**
   * Blocks a head may lead the median of the other endpoints' fresh heads.
   * A head further ahead is ignored, and its endpoint is scored as if it lagged by as much as it leads. Default: 1000.
   */
  maxAhead?: number | undefined;
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

/** One explicit endpoint with an optional public label and weight. Give `url` or `transport`, not both. */
export interface HyperevmEndpointConfig {
  /** RPC URL. It may carry an API key in its path, query, or credentials. The key never leaves the transport. */
  url?: string | undefined;
  /** viem transport to call instead of a URL. */
  transport?: Transport | undefined;
  /** Name used in events, snapshots, and errors. Default: the registry URL, or `scheme://host[:port]`. */
  label?: string | undefined;
  /** Routing weight above 0. Default: the registry weight, or 1. */
  weight?: number | undefined;
}

/** A URL, a viem transport, or an {@link HyperevmEndpointConfig}. */
export type HyperevmEndpoint = string | Transport | HyperevmEndpointConfig;

/** Options for {@link hyperevm}. Every field is optional. */
export interface HyperevmTransportOptions {
  /**
   * URLs, viem transports, or endpoint configs. URLs become `http()` or `webSocket()`.
   * Explicit URLs may carry an API key. Only a public label is ever exposed.
   * Duplicate URLs or labels throw. Default: eligible HTTP endpoints from the shipped registry.
   */
  endpoints?: readonly HyperevmEndpoint[] | undefined;
  /**
   * Check `eth_chainId` once per endpoint before its first call. An endpoint on another
   * chain is quarantined. Expected id: the client chain, or 999. Default: true.
   */
  verifyChainId?: boolean | undefined;
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
  /** Per-attempt deadline in milliseconds. Wins over the client timeout. Default: the client timeout, or 10000. */
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
  /** Current scores, heads, and in-flight counts. `score` is for `method`. Default: `"eth_call"`. */
  snapshot: (method?: string) => readonly EndpointSnapshot[];
  /** Endpoints this transport was built with. `id` and `url` are the public label. */
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
  maxAhead: number;
}

interface ResolvedHedge {
  enabled: boolean;
  minDelay: number;
  multiplier: number;
}

interface BuiltEndpoint {
  /** Public label. The real URL lives only inside `request`. */
  id: string;
  /** Same as `id`. */
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

/** Cached `eth_chainId` verdict for one endpoint. */
interface ChainGate {
  verified: boolean;
  /** Set once the endpoint reported another chain. Permanent. */
  mismatch: ChainMismatchError | undefined;
  /** Check in flight. Concurrent callers share it. */
  pending: Promise<Error | undefined> | undefined;
}

function resolveHeadLag(value: boolean | HeadLagOptions | undefined): ResolvedHeadLag {
  if (value === false) {
    return {
      enabled: false,
      maxLag: DEFAULT_MAX_LAG,
      probeInterval: false,
      staleMs: DEFAULT_STALE_MS,
      maxAhead: DEFAULT_MAX_AHEAD,
    };
  }
  const options = value === true || value === undefined ? {} : value;
  return {
    enabled: true,
    maxLag: options.maxLag ?? DEFAULT_MAX_LAG,
    probeInterval: options.probeInterval === undefined ? DEFAULT_PROBE_MS : options.probeInterval,
    staleMs: options.staleMs ?? DEFAULT_STALE_MS,
    maxAhead: options.maxAhead ?? DEFAULT_MAX_AHEAD,
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

/** Registry weight for a normalized URL. A URL outside the registry weighs 1. */
function weightFor(url: string, explicit: boolean): number {
  const found = registryHttpEndpoints().find((endpoint) => endpoint.url === url);
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
    const timeout = options.timeout ?? parameters.timeout ?? DEFAULT_TIMEOUT_MS;
    const retryCount = options.retryCount ?? parameters.retryCount ?? DEFAULT_RETRY_COUNT;
    const retryDelay = options.retryDelay ?? 0;
    const built = buildEndpoints(options, parameters.chain, timeout);
    if (built.length === 0) {
      throw new Error("hyperevm() requires at least one endpoint. The registry has none eligible.");
    }
    const verifyChainId = options.verifyChainId ?? true;
    const expectedChainId = parameters.chain?.id ?? DEFAULT_CHAIN_ID;
    const gates = new Map<string, ChainGate>(
      built.map((endpoint) => [endpoint.id, { verified: !verifyChainId, mismatch: undefined, pending: undefined }]),
    );
    const quarantined = (id: string): boolean => gates.get(id)?.mismatch !== undefined;
    const board = new Scoreboard(
      built.map((endpoint, index) => ({
        id: endpoint.id,
        url: endpoint.url,
        weight: endpoint.weight,
        index,
        supports: (method: string): boolean => !quarantined(endpoint.id) && endpoint.supports(method),
      })),
      {
        perMethod,
        headLag: headLag.enabled,
        maxLag: headLag.maxLag,
        staleMs: headLag.staleMs,
        maxAhead: headLag.maxAhead,
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

    /**
     * Resolve to undefined once `endpoint` has reported the expected chain id, or to the reason it cannot serve yet.
     * The check bypasses `start()`, so it never writes a latency sample. A failed check counts as a failed probe
     * (liveness only) and is retried on the next call. A wrong chain quarantines the endpoint for good.
     */
    const checkChain = (endpoint: BuiltEndpoint): Promise<Error | undefined> => {
      const gate = gates.get(endpoint.id);
      if (!gate || gate.verified) return Promise.resolve(undefined);
      if (gate.mismatch) return Promise.resolve(gate.mismatch);
      if (gate.pending) return gate.pending;
      const started = now();
      const pending = withDeadline(endpoint.request({ method: "eth_chainId" }), timeout).then(
        (result): Error | undefined => {
          const chainId = parseQuantity(result);
          if (chainId === expectedChainId) {
            gate.verified = true;
            return undefined;
          }
          if (chainId === null) return new Error(`${endpoint.url} returned no chain id.`);
          gate.mismatch = new ChainMismatchError(endpoint.url, expectedChainId, chainId);
          emit({ type: "quarantine", endpoint: endpoint.url, chainId, expected: expectedChainId });
          return gate.mismatch;
        },
        (error: unknown): Error => {
          const wrapped = toError(error);
          const latencyMs = Math.max(0, now() - started);
          board.failure(endpoint.id, "eth_chainId", latencyMs, false, timeout);
          emit({ type: "error", endpoint: endpoint.url, method: "eth_chainId", latencyMs, error: wrapped });
          return wrapped;
        },
      );
      gate.pending = pending;
      void pending.finally(() => {
        if (gate.pending === pending) gate.pending = undefined;
      });
      return pending;
    };

    /**
     * `board.pick`, skipping endpoints whose chain check fails.
     * A skipped endpoint is excluded for this call and its reason joins `errors`, so it never costs an attempt.
     * A verified pick returns synchronously, so concurrent calls still see each other's in-flight counts.
     */
    const pickVerified = (
      method: string,
      exclude: Set<string>,
      mode: "best" | "p2c",
      parent: AbortSignal | undefined,
      errors: Error[],
    ): RankedEndpoint | undefined | Promise<RankedEndpoint | undefined> => {
      const endpoint = board.pick(method, exclude, mode, random);
      if (!endpoint) {
        if (errors.length === 0) {
          for (const gate of gates.values()) if (gate.mismatch) errors.push(gate.mismatch);
        }
        return undefined;
      }
      const target = byId.get(endpoint.id);
      if (!target || gates.get(endpoint.id)?.verified !== false) return endpoint;
      return untilAborted(checkChain(target), parent).then((reason) => {
        if (!reason) return endpoint;
        exclude.add(endpoint.id);
        errors.push(reason);
        return pickVerified(method, exclude, mode, parent, errors);
      });
    };

    /** `exclude` plus every endpoint that has not passed its chain check. Hedges never wait on a check. */
    const verifiedOnly = (exclude: ReadonlySet<string>): ReadonlySet<string> => {
      if (!verifyChainId) return exclude;
      const blocked = new Set(exclude);
      for (const [id, gate] of gates) if (!gate.verified) blocked.add(id);
      return blocked;
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
              const block = blockNumberFromResult(method, outcome.result, params);
              if (block !== null && headLag.enabled) {
                const head = board.noteHead(endpoint.id, block);
                emit({
                  type: "head",
                  endpoint: endpoint.url,
                  head: block,
                  best: head.best,
                  lag: head.lag,
                  trusted: head.trusted,
                });
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
        const picked = pickVerified(method, exclude, attempt === 0 ? routing : "best", parent, errors);
        const endpoint = picked instanceof Promise ? await picked : picked;
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
        const next = board.pick(method, verifiedOnly(exclude), "best", random);
        if (!next) return undefined;
        emit({ type: "hedge", endpoint: next.url, method });
        exclude.add(next.id);
        return start(next, method, params, parent, true, true);
      });
    };

    const probe = (): Promise<void> => {
      const pending = built.map((endpoint) =>
        checkChain(endpoint).then((reason) =>
          reason
            ? undefined
            : start(endpoint, "eth_blockNumber", [], undefined, false, false).promise.then(
                () => undefined,
                () => undefined,
              ),
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
      snapshot: (method = "eth_call"): readonly EndpointSnapshot[] =>
        board.snapshot(method).map((entry) => ({ ...entry, quarantined: quarantined(entry.id) })),
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

/** Settle with `promise`, or reject with {@link TimeoutError} after `ms`. */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(ms)), ms);
    unrefTimer(timer as ReturnType<typeof setInterval>);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/** Settle with `promise`, or reject when `signal` aborts first. The listener is removed either way. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** One endpoint after validation, before it has a public label. */
interface PendingEndpoint {
  index: number;
  /** Normalized URL when one is known. Private. */
  url: EndpointUrl | undefined;
  label: string | undefined;
  weight: number;
  instance: ReturnType<Transport>;
  /** Spellings of the URL to scrub from errors. */
  secrets: string[];
}

function buildEndpoints(options: HyperevmTransportOptions, chain: Chain | undefined, timeout: number): BuiltEndpoint[] {
  const explicit = options.endpoints !== undefined;
  const inputs: readonly HyperevmEndpoint[] =
    options.endpoints ?? registryHttpEndpoints().map((endpoint) => endpoint.url);
  const pending: PendingEndpoint[] = [];
  const urls = new Set<string>();
  const labels = new Set<string>();
  inputs.forEach((input, index) => {
    const config = endpointConfig(input, index);
    const given = config.url === undefined ? undefined : endpointUrlAt(config.url, index);
    const transport = given ? toChildTransport(given, options, timeout) : config.transport;
    if (!transport) throw new Error(`hyperevm() endpoints[${index}] needs a url or a transport.`);
    const instance = transport({ chain, retryCount: 0, timeout });
    const childUrl = given ? undefined : endpointUrl(instance.value);
    const url = given ?? (childUrl === undefined ? undefined : tryEndpointUrl(childUrl));
    const weight = config.weight ?? (given ? weightFor(given.url, explicit) : 1);
    if (!explicit && weight <= 0) return;
    if (url) {
      if (urls.has(url.url)) {
        throw new Error(`hyperevm() endpoints list ${config.label ?? publicUrl(url)} more than once.`);
      }
      urls.add(url.url);
    }
    if (config.label !== undefined) {
      if (labels.has(config.label)) {
        throw new Error(`hyperevm() endpoint label "${config.label}" is used more than once.`);
      }
      labels.add(config.label);
    }
    const secrets = url && !isRegistryUrl(url.url) ? [config.url, url.url, childUrl] : [];
    pending.push({
      index,
      url,
      label: config.label,
      weight,
      instance,
      secrets: secrets.filter((secret): secret is string => secret !== undefined),
    });
  });
  return pending.map((entry) => {
    const label = entry.label ?? uniqueLabel(entry.url ? publicUrl(entry.url) : `transport:${entry.index}`, labels);
    const { instance } = entry;
    const methods = instance.config.methods as { include?: readonly string[]; exclude?: readonly string[] } | undefined;
    return {
      id: label,
      url: label,
      weight: entry.weight,
      supports: (method: string): boolean => supportsMethod(methods, method),
      request: redactErrors(instance.request as BuiltEndpoint["request"], entry.secrets, label),
    };
  });
}

/** Validate one `endpoints` entry and lift it to the object form. */
function endpointConfig(input: HyperevmEndpoint, index: number): HyperevmEndpointConfig {
  if (typeof input === "string") return { url: input };
  if (typeof input === "function") return { transport: input };
  const where = `hyperevm() endpoints[${index}]`;
  if ((input.url === undefined) === (input.transport === undefined)) {
    throw new Error(`${where} needs exactly one of url or transport.`);
  }
  if (input.label !== undefined && input.label.trim() === "") throw new Error(`${where}.label must not be empty.`);
  if (input.weight !== undefined && !(Number.isFinite(input.weight) && input.weight > 0)) {
    throw new Error(`${where}.weight must be a finite number above 0.`);
  }
  return input;
}

function endpointUrlAt(url: string, index: number): EndpointUrl {
  try {
    return normalizeEndpointUrl(url);
  } catch (error) {
    throw new Error(`hyperevm() endpoints[${index}]: ${toError(error).message}`);
  }
}

function tryEndpointUrl(url: string): EndpointUrl | undefined {
  try {
    return normalizeEndpointUrl(url);
  } catch {
    return undefined;
  }
}

function isRegistryUrl(url: string): boolean {
  return defaultRegistry.endpoints.some((endpoint) => endpoint.url === url);
}

/** Registry URLs are public and keyless, so they stay whole. Anything else shows only its origin. */
function publicUrl(url: EndpointUrl): string {
  return isRegistryUrl(url.url) ? url.url : url.origin;
}

/** `base`, or `base#2`, `base#3`, ... when taken. Records the result in `used`. */
function uniqueLabel(base: string, used: Set<string>): string {
  let label = base;
  for (let suffix = 2; used.has(label); suffix += 1) label = `${base}#${suffix}`;
  used.add(label);
  return label;
}

/** Replace every spelling of a private URL with `label` in errors thrown by `request`, including causes. */
function redactErrors(
  request: BuiltEndpoint["request"],
  secrets: readonly string[],
  label: string,
): BuiltEndpoint["request"] {
  const spellings = new Set<string>();
  for (const secret of secrets) {
    for (const spelling of [secret, secret.trim(), withoutCredentials(secret)]) {
      if (spelling !== "" && spelling !== label) spellings.add(spelling);
    }
  }
  if (spellings.size === 0) return request;
  const ordered = [...spellings].sort((left, right) => right.length - left.length);
  const scrub = (text: string): string => ordered.reduce((out, spelling) => out.replaceAll(spelling, label), text);
  return async (args: { method: string; params?: unknown }, options?: { signal?: AbortSignal }): Promise<unknown> => {
    try {
      return await request(args, options);
    } catch (error: unknown) {
      scrubError(error, scrub);
      throw error;
    }
  };
}

function scrubError(error: unknown, scrub: (text: string) => string): void {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    for (const key of Object.getOwnPropertyNames(current)) {
      const value: unknown = Reflect.get(current, key);
      if (typeof value === "string") {
        Reflect.set(current, key, scrub(value));
      } else if (Array.isArray(value)) {
        Reflect.set(
          current,
          key,
          value.map((item: unknown) => (typeof item === "string" ? scrub(item) : item)),
        );
      }
    }
    current = current.cause;
  }
}

/** The URL as viem prints it in errors, with basic-auth credentials removed. */
function withoutCredentials(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username === "" && parsed.password === "") return url;
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

function toChildTransport(url: EndpointUrl, options: HyperevmTransportOptions, timeout: number): Transport {
  if (url.kind === "websocket") return webSocket(url.url);
  return http(url.url, {
    batch: options.batch,
    fetchFn: options.fetchFn,
    retryCount: 0,
    timeout,
  });
}

/** The URL a viem transport reports on its value, if any. */
function endpointUrl(value: unknown): string | undefined {
  if (typeof value === "object" && value !== null && "url" in value && typeof value.url === "string") {
    return value.url;
  }
  return undefined;
}
