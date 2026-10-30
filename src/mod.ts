/**
 * Load-balanced JSON-RPC transport for HyperEVM.
 *
 * @example
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
 *
 * @module
 */

export { AllEndpointsFailedError, TimeoutError } from "./errors.ts";
export type { EndpointSnapshot, HyperevmEvent } from "./events.ts";
export { NON_IDEMPOTENT_METHODS, isIdempotentMethod, shouldFailover } from "./methods.ts";
export {
  defaultRankPolicy,
  mergeEndpointInputs,
  rankRegistry,
  type EndpointKind,
  type ProbeObservation,
  type RankPolicy,
  type RegistryEndpoint,
  type RegistryEndpointInput,
  type RegistryEndpointStats,
  type RegistrySource,
  type Submission,
  type Tracking,
} from "./policy.ts";
export {
  assertRegistryFile,
  defaultRegistry,
  registryHttpEndpoints,
  registryPolicy,
  type RegistryFile,
} from "./registry.ts";
export { blockNumberFromResult, parseQuantity } from "./scoreboard.ts";
export { defaultScoreConfig, endpointScore, inflation, type MethodStat, type ScoreConfig } from "./score.ts";
export {
  hyperevm,
  type BatchOptions,
  type HeadLagOptions,
  type HedgeOptions,
  type HyperevmTransportOptions,
  type HyperevmTransportValue,
} from "./transport.ts";
export { normalizeRpcUrl, type NormalizedRpcUrl } from "./url.ts";

/** HyperEVM mainnet chain id. The registry is this chain and no other. */
export const HYPEREVM_CHAIN_ID = 999;
