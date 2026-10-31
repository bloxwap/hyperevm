/**
 * Per-endpoint memory: latency, errors, in-flight calls, and the newest head.
 * @module
 */

import type { EndpointSnapshot } from "./_events.ts";
import {
  type MethodStat,
  type ScoreConfig,
  defaultScoreConfig,
  emptyStat,
  endpointScore,
  observe,
  observeLiveness,
} from "./_score.ts";

/** Identity of an endpoint the transport can call. */
export interface RankedEndpoint {
  readonly id: string;
  readonly url: string;
}

/** A concrete endpoint the scoreboard can rank. */
export interface ScoreboardEndpoint extends RankedEndpoint {
  weight: number;
  index: number;
  supports: (method: string) => boolean;
}

interface EndpointState extends ScoreboardEndpoint {
  inflight: number;
  head: number | null;
  headAt: number;
  global: MethodStat;
  methods: Map<string, MethodStat>;
}

export interface ScoreboardOptions {
  perMethod: boolean;
  headLag: boolean;
  maxLag: number;
  staleMs: number;
  config?: ScoreConfig | undefined;
  now: () => number;
}

/** Picks an endpoint and records what happened after the call. */
export class Scoreboard {
  readonly #endpoints: EndpointState[];
  readonly #options: ScoreboardOptions;

  constructor(endpoints: readonly ScoreboardEndpoint[], options: ScoreboardOptions) {
    this.#endpoints = endpoints.map((endpoint) => ({
      ...endpoint,
      inflight: 0,
      head: null,
      headAt: 0,
      global: emptyStat(),
      methods: new Map(),
    }));
    this.#options = options;
  }

  /** Lowest score, or the better of two randomly drawn endpoints. */
  pick(
    method: string,
    exclude: ReadonlySet<string>,
    mode: "best" | "p2c",
    random: () => number,
  ): RankedEndpoint | undefined {
    const candidates = this.#endpoints.filter((endpoint) => !exclude.has(endpoint.id) && endpoint.supports(method));
    const chosen =
      candidates.length === 0
        ? undefined
        : candidates.length === 1 || mode === "best"
          ? this.#best(candidates, method)
          : this.#p2c(candidates, method, random);
    if (!chosen) return undefined;
    return { id: chosen.id, url: chosen.url };
  }

  begin(id: string): void {
    const endpoint = this.#require(id);
    endpoint.inflight += 1;
  }

  end(id: string): void {
    const endpoint = this.#require(id);
    endpoint.inflight = Math.max(0, endpoint.inflight - 1);
  }

  success(id: string, method: string, latencyMs: number, sampleLatency: boolean): void {
    const endpoint = this.#require(id);
    if (!sampleLatency) {
      observeLiveness(endpoint.global, true, 0);
      return;
    }
    observe(endpoint.global, latencyMs, true);
    observe(this.#method(endpoint, method), latencyMs, true);
  }

  failure(id: string, method: string, latencyMs: number, sampleLatency: boolean, penaltyMs: number): void {
    const endpoint = this.#require(id);
    if (!sampleLatency) {
      observeLiveness(endpoint.global, false, penaltyMs);
      observeLiveness(this.#method(endpoint, method), false, penaltyMs);
      return;
    }
    observe(endpoint.global, latencyMs, false);
    observe(this.#method(endpoint, method), latencyMs, false);
  }

  /** Record a block number. Returns lag behind the best fresh head. */
  noteHead(id: string, head: number): { best: number; lag: number } {
    const endpoint = this.#require(id);
    const now = this.#options.now();
    endpoint.head = head;
    endpoint.headAt = now;
    const best = this.#bestHead(now) ?? head;
    return { best, lag: Math.max(0, best - head) };
  }

  /**
   * How long to wait before cloning an idempotent read.
   * Cold endpoints use `minDelay`. After a few samples, wait until the call is slower than `multiplier` times the tail.
   */
  hedgeDelay(id: string, method: string, minDelay: number, multiplier: number): number {
    const endpoint = this.#require(id);
    const stat = endpoint.methods.get(method) ?? endpoint.global;
    if (stat.n < 3) return minDelay;
    const tail = stat.tail > 0 ? stat.tail : stat.ewma;
    const scaled = tail * multiplier;
    return scaled > minDelay ? scaled : minDelay;
  }

  snapshot(method: string): EndpointSnapshot[] {
    return this.#endpoints.map((endpoint) => ({
      id: endpoint.id,
      url: endpoint.url,
      weight: endpoint.weight,
      inflight: endpoint.inflight,
      head: endpoint.head,
      lag: this.#lag(endpoint),
      score: this.#score(endpoint, method),
      methods: Object.fromEntries([
        ["*", copyStat(endpoint.global)],
        ...[...endpoint.methods.entries()].map(([name, stat]) => [name, copyStat(stat)]),
      ]),
    }));
  }

  #require(id: string): EndpointState {
    const endpoint = this.#endpoints.find((item) => item.id === id);
    if (!endpoint) throw new Error(`Unknown HyperEVM endpoint: ${id}`);
    return endpoint;
  }

  #method(endpoint: EndpointState, method: string): MethodStat {
    const existing = endpoint.methods.get(method);
    if (existing) return existing;
    const created = emptyStat();
    endpoint.methods.set(method, created);
    return created;
  }

  #score(endpoint: EndpointState, method: string): number {
    return endpointScore({
      global: endpoint.global,
      method: endpoint.methods.get(method),
      perMethod: this.#options.perMethod,
      inflight: endpoint.inflight,
      lagPenalty: this.#lagPenalty(endpoint),
      weight: endpoint.weight,
      config: this.#options.config ?? defaultScoreConfig,
    });
  }

  #lag(endpoint: EndpointState): number | null {
    if (endpoint.head === null) return null;
    const best = this.#bestHead(this.#options.now());
    if (best === null) return null;
    return Math.max(0, best - endpoint.head);
  }

  #lagPenalty(endpoint: EndpointState): number {
    if (!this.#options.headLag) return 1;
    const lag = this.#lag(endpoint);
    if (lag === null || lag <= this.#options.maxLag) return 1;
    return 1 + (lag - this.#options.maxLag);
  }

  #bestHead(now: number): number | null {
    let best: number | null = null;
    for (const endpoint of this.#endpoints) {
      if (endpoint.head === null) continue;
      if (now - endpoint.headAt > this.#options.staleMs) continue;
      if (best === null || endpoint.head > best) best = endpoint.head;
    }
    return best;
  }

  #better(left: EndpointState, right: EndpointState, method: string): EndpointState {
    const leftScore = this.#score(left, method);
    const rightScore = this.#score(right, method);
    if (leftScore < rightScore) return left;
    if (rightScore < leftScore) return right;
    return left.index <= right.index ? left : right;
  }

  #best(candidates: readonly EndpointState[], method: string): EndpointState | undefined {
    let best: EndpointState | undefined;
    for (const candidate of candidates) {
      if (!best || this.#better(candidate, best, method) === candidate) best = candidate;
    }
    return best;
  }

  #p2c(candidates: readonly EndpointState[], method: string, random: () => number): EndpointState | undefined {
    const first = candidates[draw(random, candidates.length)];
    if (!first) return undefined;
    let secondIndex = draw(random, candidates.length);
    if (candidates[secondIndex] === first) secondIndex = (candidates.indexOf(first) + 1) % candidates.length;
    const second = candidates[secondIndex] ?? first;
    return this.#better(first, second, method);
  }
}

function copyStat(stat: MethodStat): { ewma: number; tail: number; error: number; n: number } {
  return { ewma: stat.ewma, tail: stat.tail, error: stat.error, n: stat.n };
}

function draw(random: () => number, length: number): number {
  const scaled = Math.floor(random() * length);
  if (scaled < 0) return 0;
  if (scaled >= length) return length - 1;
  return scaled;
}

/** Parse a hex quantity such as an `eth_blockNumber` result. */
export function parseQuantity(value: unknown): number | null {
  if (typeof value !== "string" || !value.startsWith("0x")) return null;
  const parsed = Number.parseInt(value, 16);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

/** Pull a block number out of a JSON-RPC result when the method carries one. */
export function blockNumberFromResult(method: string, result: unknown): number | null {
  if (method === "eth_blockNumber") return parseQuantity(result);
  if (method !== "eth_getBlockByNumber" && method !== "eth_getBlockByHash") return null;
  if (typeof result !== "object" || result === null || !("number" in result)) return null;
  return parseQuantity(result.number);
}
