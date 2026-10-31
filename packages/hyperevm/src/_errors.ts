/**
 * Errors raised by the HyperEVM transport.
 *
 * Both extend viem's `BaseError`, so `buildRequest` rethrows them instead of
 * wrapping them in `UnknownRpcError`.
 * @module
 */

import { BaseError } from "viem";

/** Thrown when every attempted endpoint failed. The last error is `cause`. */
export class AllEndpointsFailedError extends BaseError {
  readonly errors: readonly Error[];

  constructor(errors: readonly Error[]) {
    const last = errors.at(-1);
    super("All HyperEVM endpoints failed.", {
      cause: last,
      details: last?.message ?? "no endpoints were attempted",
      name: "AllEndpointsFailedError",
    });
    this.name = "AllEndpointsFailedError";
    this.errors = errors;
  }
}

/** Thrown when one endpoint exceeds its deadline. Failover may try another endpoint. */
export class TimeoutError extends BaseError {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super("HyperEVM request timed out.", {
      details: `${timeoutMs}ms`,
      name: "TimeoutError",
    });
    this.name = "TimeoutError";
    this.timeoutMs = timeoutMs;
  }
}
