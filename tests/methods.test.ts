import { describe, expect, test } from "bun:test";

import { isIdempotentMethod, shouldFailover } from "../src/methods.ts";

describe("method safety", () => {
  test("transaction sends and subscriptions are not idempotent", () => {
    expect(isIdempotentMethod("eth_call")).toBe(true);
    expect(isIdempotentMethod("eth_getLogs")).toBe(true);
    expect(isIdempotentMethod("eth_blockNumber")).toBe(true);
    expect(isIdempotentMethod("eth_sendRawTransaction")).toBe(false);
    expect(isIdempotentMethod("eth_sendTransaction")).toBe(false);
    expect(isIdempotentMethod("eth_subscribe")).toBe(false);
    expect(isIdempotentMethod("eth_call", ["eth_call"])).toBe(false);
  });

  test("reverts and invalid params do not fail over, transport failures do", () => {
    expect(shouldFailover(Object.assign(new Error("execution reverted: boom"), { code: 3 }))).toBe(false);
    expect(shouldFailover(Object.assign(new Error("invalid"), { code: -32602 }))).toBe(false);
    expect(shouldFailover(Object.assign(new Error("rejected"), { code: 4001 }))).toBe(false);
    const aborted = new Error("aborted");
    aborted.name = "AbortError";
    expect(shouldFailover(aborted)).toBe(false);
    expect(shouldFailover(Object.assign(new Error("limit"), { code: -32005 }))).toBe(true);
    expect(shouldFailover(Object.assign(new Error("missing method"), { code: -32601 }))).toBe(true);
    expect(shouldFailover(new Error("socket hang up"))).toBe(true);
    const timeout = new Error("timed out");
    timeout.name = "TimeoutError";
    expect(shouldFailover(timeout)).toBe(true);
  });
});
