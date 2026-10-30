/**
 * JSON-RPC methods that must not be retried or hedged.
 *
 * A lost response is not proof the server never saw the call. Sending
 * `eth_sendRawTransaction` to a second endpoint can broadcast the same
 * transaction twice. `eth_subscribe` is pinned to the socket that accepted it.
 * @module
 */

/** Methods the transport sends to at most one endpoint. */
export const NON_IDEMPOTENT_METHODS: readonly string[] = [
  "eth_sendRawTransaction",
  "eth_sendRawTransactionSync",
  "eth_sendTransaction",
  "eth_sign",
  "eth_signTransaction",
  "eth_signTypedData",
  "eth_signTypedData_v3",
  "eth_signTypedData_v4",
  "personal_sign",
  "personal_sendTransaction",
  "eth_submitWork",
  "eth_submitHashrate",
  "wallet_sendTransaction",
  "wallet_sendCalls",
  "eth_subscribe",
];

const DEFAULT_NON_IDEMPOTENT: ReadonlySet<string> = new Set(NON_IDEMPOTENT_METHODS);

/** Codes and messages that describe the call, not a sick endpoint. */
const TERMINAL_CODES: ReadonlySet<number> = new Set([
  3, // execution reverted
  -32700, // parse error
  -32600, // invalid request
  -32602, // invalid params
  -32003, // transaction rejected
  4001, // user rejected
  5000, // CAIP-25 user rejected
]);

const TERMINAL_MESSAGE = /execution reverted|gas required exceeds allowance/i;

/** True when the method is safe to send again to a different endpoint. */
export function isIdempotentMethod(method: string, extra: readonly string[] = []): boolean {
  if (DEFAULT_NON_IDEMPOTENT.has(method)) return false;
  return !extra.includes(method);
}

function errorText(error: Error): string {
  const details = "details" in error && typeof error.details === "string" ? error.details : "";
  return `${error.message}\n${details}`;
}

function errorCode(error: Error): number | undefined {
  if ("code" in error && typeof error.code === "number") return error.code;
  return undefined;
}

/** True when the failure is an abort initiated by the caller or by hedge cancellation. */
export function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

/**
 * True when another endpoint might answer this call.
 * Execution reverts, invalid params, and user rejections stay on the caller.
 */
export function shouldFailover(error: Error): boolean {
  if (isAbortError(error)) return false;
  if (TERMINAL_MESSAGE.test(errorText(error))) return false;
  const code = errorCode(error);
  if (code !== undefined && TERMINAL_CODES.has(code)) return false;
  return true;
}

/** Normalize unknown throw values into Error instances. */
export function toError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (typeof error === "string") return new Error(error);
  return new Error("Unknown endpoint error");
}
