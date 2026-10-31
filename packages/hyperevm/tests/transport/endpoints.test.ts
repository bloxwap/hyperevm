import { describe, expect, test } from "bun:test";
import {
  createPublicClient,
  createTransport,
  http,
  type EIP1193Parameters,
  type EIP1193RequestFn,
  type Transport,
} from "viem";
import { hyperEvm } from "viem/chains";

import { ChainMismatchError, TimeoutError } from "../../src/_errors.ts";
import { normalizeRpcUrl } from "../../src/registry/_url.ts";
import { hyperevm, type HyperevmEvent, type HyperevmTransportOptions } from "../../src/transport/mod.ts";

const HYPERPC = "https://hyperpc.example.test/evm?apikey=HYPERPC_SECRET";
const DRPC = "https://lb.drpc.example.test/ogrpc/hyperliquid/DRPC_SECRET";
const PUBLIC = "https://rpc.hyperliquid.xyz/evm";
const SECRETS = ["HYPERPC_SECRET", "DRPC_SECRET", "apikey", "ogrpc", "hunter2"];

interface Seen {
  url: string;
  method: string;
  authorization: string | null;
}

type Reply = { result: unknown } | { error: { code: number; message: string } } | { status: number };

/** viem `fetchFn` that answers JSON-RPC from `reply` and records each call. */
function rpcFetch(
  reply: (url: string, method: string) => Reply,
  seen: Seen[] = [],
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const body = JSON.parse(String(init?.body)) as { id: number; method: string };
    const authorization = new Headers(init?.headers).get("authorization");
    seen.push({ url, method: body.method, authorization });
    const answer = reply(url, body.method);
    if ("status" in answer) return new Response("upstream exploded", { status: answer.status });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...answer }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

/** Chain 999 for `eth_chainId`, `0x10` for everything else. */
function healthy(_url: string, method: string): Reply {
  return { result: method === "eth_chainId" ? "0x3e7" : "0x10" };
}

interface MockEndpoint {
  transport: Transport;
  calls: string[];
}

function mockEndpoint(name: string, handler: (method: string) => unknown | Promise<unknown>): MockEndpoint {
  const calls: string[] = [];
  const transport: Transport = () =>
    createTransport({
      key: name,
      name,
      type: "test",
      retryCount: 0,
      request: (async ({ method }: EIP1193Parameters) => {
        calls.push(method);
        return handler(method);
      }) as EIP1193RequestFn,
    });
  return { transport, calls };
}

function chainOf(id: string): (method: string) => string {
  return (method) => (method === "eth_chainId" ? id : "0x1");
}

function open(options: HyperevmTransportOptions, timeout = 1_000) {
  return hyperevm({ headLag: false, routing: "best", hedge: false, retryCount: 2, ...options })({ timeout });
}

/** Every string an error carries: message, stack, details, meta messages, url, and the same for its causes. */
function errorText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    for (const key of Object.getOwnPropertyNames(current)) {
      const value: unknown = Reflect.get(current, key);
      if (typeof value === "string") parts.push(value);
      if (Array.isArray(value)) parts.push(...value.filter((item): item is string => typeof item === "string"));
    }
    current = current.cause;
  }
  return parts.join("\n");
}

function expectNoSecret(text: string): void {
  for (const secret of SECRETS) expect(text).not.toContain(secret);
}

describe("explicit endpoints that carry keys", () => {
  test("accepts key-bearing URLs and never exposes them", async () => {
    const seen: Seen[] = [];
    const events: HyperevmEvent[] = [];
    const transport = hyperevm({
      endpoints: [HYPERPC, DRPC, PUBLIC],
      fetchFn: rpcFetch(healthy, seen),
      headLag: { probeInterval: false },
      onEvent: (event) => {
        events.push(event);
      },
    });
    const client = createPublicClient({ chain: hyperEvm, transport });
    await client.transport.probe();
    expect(await client.getBlockNumber({ cacheTime: 0 })).toBe(16n);
    await client.request({ method: "eth_call", params: [{ to: "0x0000000000000000000000000000000000000800" }] });

    // The real URLs, keys included, are what goes over the wire.
    const called = new Set(seen.map((item) => item.url));
    expect([...called].sort()).toEqual([DRPC, HYPERPC, PUBLIC].sort());

    const labels = ["https://hyperpc.example.test", "https://lb.drpc.example.test", PUBLIC];
    expect(client.transport.endpoints.map((endpoint) => endpoint.id)).toEqual(labels);
    expect(client.transport.endpoints.map((endpoint) => endpoint.url)).toEqual(labels);
    expect(client.transport.snapshot().map((entry) => entry.url)).toEqual(labels);
    expect(new Set(events.map((event) => ("endpoint" in event ? event.endpoint : "")))).toEqual(new Set(labels));
    expectNoSecret(JSON.stringify(events));
    expectNoSecret(JSON.stringify(client.transport.endpoints));
    expectNoSecret(JSON.stringify(client.transport.snapshot()));
  });

  test("the registry check still rejects the same URLs", () => {
    expect(() => normalizeRpcUrl(HYPERPC)).toThrow(/query/);
    expect(() => normalizeRpcUrl("https://user:hunter2@node.example.test/evm")).toThrow(/credentials/);
  });

  test("an http() transport is labeled by origin, not by its key-bearing URL", async () => {
    const events: HyperevmEvent[] = [];
    const client = open({
      endpoints: [http(DRPC, { fetchFn: rpcFetch(healthy), retryCount: 0 })],
      onEvent: (event) => {
        events.push(event);
      },
    });
    expect(await client.request({ method: "eth_blockNumber" })).toBe("0x10");
    expect(client.value?.endpoints[0]?.id).toBe("https://lb.drpc.example.test");
    expect(client.value?.snapshot()[0]?.url).toBe("https://lb.drpc.example.test");
    expect(events.map((event) => ("endpoint" in event ? event.endpoint : ""))).toContain(
      "https://lb.drpc.example.test",
    );
    expectNoSecret(JSON.stringify(events));
  });

  test("the object form takes a label and a weight", async () => {
    const seen: Seen[] = [];
    const client = open({
      endpoints: [
        { url: HYPERPC, label: "hyperpc", weight: 3 },
        { transport: mockEndpoint("public", chainOf("0x3e7")).transport, label: "public" },
      ],
      fetchFn: rpcFetch(healthy, seen),
    });
    expect(client.value?.endpoints).toEqual([
      { id: "hyperpc", url: "hyperpc", weight: 3 },
      { id: "public", url: "public", weight: 1 },
    ]);
    await client.request({ method: "eth_blockNumber" });
    expect(seen.some((item) => item.url === HYPERPC)).toBe(true);
  });

  test("keyed URLs on one host get distinct labels", () => {
    const client = open({
      endpoints: [
        "https://hyperpc.example.test/evm?apikey=A_SECRET",
        "https://hyperpc.example.test/evm?apikey=B_SECRET",
      ],
      fetchFn: rpcFetch(healthy),
    });
    expect(client.value?.endpoints.map((endpoint) => endpoint.id)).toEqual([
      "https://hyperpc.example.test",
      "https://hyperpc.example.test#2",
    ]);
  });

  test("credentials become a basic-auth header and stay out of labels", async () => {
    const seen: Seen[] = [];
    const client = open({
      endpoints: ["https://user:hunter2@node.example.test:8545/evm"],
      fetchFn: rpcFetch(healthy, seen),
    });
    expect(await client.request({ method: "eth_blockNumber" })).toBe("0x10");
    expect(client.value?.endpoints[0]?.id).toBe("https://node.example.test:8545");
    expect(seen[0]?.authorization).toBe(`Basic ${btoa("user:hunter2")}`);
    expect(seen[0]?.url).not.toContain("hunter2");
  });

  test("errors from a keyed endpoint name it by label", async () => {
    const errors: Error[] = [];
    const client = open({
      endpoints: [HYPERPC, "https://user:hunter2@node.example.test/evm"],
      fetchFn: rpcFetch((url, method) => (method === "eth_chainId" ? healthy(url, method) : { status: 500 })),
      retryCount: 1,
      onEvent: (event) => {
        if (event.type === "error") errors.push(event.error);
      },
    });
    let thrown: unknown;
    try {
      await client.request({ method: "eth_call", params: [] });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(errors).toHaveLength(2);
    const text = [errorText(thrown), ...errors.map(errorText)].join("\n");
    expect(text).toContain("https://hyperpc.example.test");
    expect(text).toContain("Status: 500");
    expectNoSecret(text);
  });
});

describe("endpoint list validation", () => {
  test("rejects the same URL twice, without echoing its key", () => {
    let message = "";
    try {
      open({ endpoints: [HYPERPC, "https://HYPERPC.example.test/evm/?apikey=HYPERPC_SECRET"] });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/more than once/);
    expect(message).toContain("https://hyperpc.example.test");
    expectNoSecret(message);
    expect(() => open({ endpoints: [PUBLIC, { url: PUBLIC, label: "again" }] })).toThrow(/more than once/);
    const shared = http(DRPC, { fetchFn: rpcFetch(healthy) });
    expect(() => open({ endpoints: [shared, DRPC] })).toThrow(/more than once/);
  });

  test("rejects a repeated label", () => {
    const first = mockEndpoint("a", chainOf("0x3e7"));
    const second = mockEndpoint("b", chainOf("0x3e7"));
    expect(() =>
      open({
        endpoints: [
          { transport: first.transport, label: "node" },
          { transport: second.transport, label: "node" },
        ],
      }),
    ).toThrow(/label "node" is used more than once/);
  });

  test("rejects malformed object entries", () => {
    const only = mockEndpoint("a", chainOf("0x3e7"));
    expect(() => open({ endpoints: [{ label: "nothing" }] })).toThrow(/exactly one of url or transport/);
    expect(() => open({ endpoints: [{ url: PUBLIC, transport: only.transport }] })).toThrow(/exactly one/);
    expect(() => open({ endpoints: [{ url: PUBLIC, weight: 0 }] })).toThrow(/weight/);
    expect(() => open({ endpoints: [{ url: PUBLIC, label: " " }] })).toThrow(/label/);
    expect(() => open({ endpoints: ["ftp://node.example.test/?apikey=HYPERPC_SECRET"] })).toThrow(
      /endpoints\[0\]: RPC URL must be http/,
    );
  });
});

describe("option resolution", () => {
  test("options.timeout wins over the client timeout", async () => {
    const hung = mockEndpoint("hung", (method) => (method === "eth_chainId" ? "0x3e7" : new Promise(() => {})));
    const client = hyperevm({ endpoints: [hung.transport], timeout: 30, retryCount: 0, headLag: false })({
      timeout: 60_000,
    });
    expect(client.config.timeout).toBe(30);
    const started = Date.now();
    await expect(client.request({ method: "eth_call", params: [] })).rejects.toBeInstanceOf(TimeoutError);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("snapshot scores the method it is asked about", async () => {
    let nowMs = 0;
    const node = mockEndpoint("node", (method) => {
      nowMs += method === "eth_getLogs" ? 900 : 10;
      return method === "eth_getLogs" ? [] : "0x1";
    });
    const client = open({
      endpoints: [node.transport],
      verifyChainId: false,
      now: () => nowMs,
      score: { confidenceSamples: 1, methodBlendSamples: 1 },
    });
    await client.request({ method: "eth_call", params: [] });
    await client.request({ method: "eth_getLogs", params: [] });
    const call = client.value?.snapshot()[0]?.score ?? 0;
    const logs = client.value?.snapshot("eth_getLogs")[0]?.score ?? 0;
    expect(client.value?.snapshot("eth_call")[0]?.score).toBe(call);
    expect(logs).toBeGreaterThan(call * 10);
  });
});

describe("chain id verification", () => {
  test("quarantines an endpoint on another chain and routes around it", async () => {
    const events: HyperevmEvent[] = [];
    const testnet = mockEndpoint("testnet", chainOf("0x3e6"));
    const mainnet = mockEndpoint("mainnet", chainOf("0x3e7"));
    const client = open({
      endpoints: [testnet.transport, mainnet.transport],
      onEvent: (event) => {
        events.push(event);
      },
    });
    for (let index = 0; index < 5; index += 1) {
      expect(await client.request({ method: "eth_blockNumber" })).toBe("0x1");
    }
    expect(testnet.calls).toEqual(["eth_chainId"]);
    expect(mainnet.calls).toEqual(["eth_chainId", ...Array(5).fill("eth_blockNumber")]);
    expect(events).toContainEqual({ type: "quarantine", endpoint: "transport:0", chainId: 998, expected: 999 });
    expect(client.value?.snapshot().map((entry) => entry.quarantined)).toEqual([true, false]);
    await client.value?.probe();
    expect(testnet.calls).toEqual(["eth_chainId"]);
  });

  test("a lone endpoint on another chain fails with ChainMismatchError", async () => {
    const testnet = mockEndpoint("testnet", chainOf("0x3e6"));
    const client = open({ endpoints: [testnet.transport] });
    await expect(client.request({ method: "eth_call", params: [] })).rejects.toBeInstanceOf(ChainMismatchError);
    await expect(client.request({ method: "eth_call", params: [] })).rejects.toBeInstanceOf(ChainMismatchError);
    expect(testnet.calls).toEqual(["eth_chainId"]);
  });

  test("never sends a raw transaction to an endpoint on another chain", async () => {
    const testnet = mockEndpoint("testnet", (method) => (method === "eth_chainId" ? "0x3e6" : "0xwrong"));
    const mainnet = mockEndpoint("mainnet", (method) => (method === "eth_chainId" ? "0x3e7" : "0xhash"));
    const client = open({ endpoints: [testnet.transport, mainnet.transport] });
    expect(await client.request({ method: "eth_sendRawTransaction", params: ["0xabc"] })).toBe("0xhash");
    expect(testnet.calls).not.toContain("eth_sendRawTransaction");
  });

  test("checks once per endpoint, shared by concurrent calls", async () => {
    const node = mockEndpoint("node", async (method) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return method === "eth_chainId" ? "0x3e7" : "0x1";
    });
    const client = open({ endpoints: [node.transport] });
    await Promise.all(Array.from({ length: 8 }, () => client.request({ method: "eth_blockNumber" })));
    await client.request({ method: "eth_blockNumber" });
    expect(node.calls.filter((method) => method === "eth_chainId")).toHaveLength(1);
    expect(node.calls.filter((method) => method === "eth_blockNumber")).toHaveLength(9);
  });

  test("a failed check does not quarantine and is retried", async () => {
    // The call re-tries the check once after a backoff, so two failures fail the first call.
    let failChecks = 2;
    const node = mockEndpoint("node", (method) => {
      if (method === "eth_chainId" && failChecks > 0) {
        failChecks -= 1;
        throw new Error("socket hang up");
      }
      return method === "eth_chainId" ? "0x3e7" : "0x1";
    });
    const client = open({ endpoints: [node.transport] });
    await expect(client.request({ method: "eth_blockNumber" })).rejects.toThrow(/socket hang up/);
    expect(client.value?.snapshot()[0]?.quarantined).toBe(false);
    expect(await client.request({ method: "eth_blockNumber" })).toBe("0x1");
    expect(node.calls).toEqual(["eth_chainId", "eth_chainId", "eth_chainId", "eth_blockNumber"]);
  });

  test("a single endpoint survives one failed check within the call", async () => {
    let failChecks = 1;
    const node = mockEndpoint("node", (method) => {
      if (method === "eth_chainId" && failChecks > 0) {
        failChecks -= 1;
        throw new Error("socket hang up");
      }
      return method === "eth_chainId" ? "0x3e7" : "0x1";
    });
    const client = open({ endpoints: [node.transport] });
    expect(await client.request({ method: "eth_blockNumber" })).toBe("0x1");
    expect(node.calls).toEqual(["eth_chainId", "eth_chainId", "eth_blockNumber"]);
  });

  test("a failed check moves the call to another endpoint without spending a retry", async () => {
    const flaky = mockEndpoint("flaky", () => {
      throw new Error("socket hang up");
    });
    const good = mockEndpoint("good", chainOf("0x3e7"));
    const client = open({ endpoints: [flaky.transport, good.transport], retryCount: 0 });
    expect(await client.request({ method: "eth_call", params: [] })).toBe("0x1");
    expect(flaky.calls).toEqual(["eth_chainId"]);
  });

  test("the check does not write latency samples", async () => {
    let nowMs = 0;
    const node = mockEndpoint("node", (method) => {
      nowMs += method === "eth_chainId" ? 5_000 : 20;
      return method === "eth_chainId" ? "0x3e7" : "0x1";
    });
    const client = open({ endpoints: [node.transport], now: () => nowMs });
    await client.request({ method: "eth_call", params: [] });
    const methods = client.value?.snapshot()[0]?.methods ?? {};
    expect(methods.eth_chainId).toBeUndefined();
    expect(methods["*"]).toEqual({ ewma: 20, tail: 20, error: 0, n: 1 });
  });

  test("expects the client chain id when one is given", async () => {
    const testnet = mockEndpoint("testnet", chainOf("0x3e6"));
    const client = createPublicClient({
      chain: { ...hyperEvm, id: 998 },
      transport: hyperevm({ endpoints: [testnet.transport], headLag: false }),
    });
    expect(await client.getBlockNumber()).toBe(1n);
  });

  test("verifyChainId false sends no check", async () => {
    const testnet = mockEndpoint("testnet", chainOf("0x3e6"));
    const client = open({ endpoints: [testnet.transport], verifyChainId: false });
    expect(await client.request({ method: "eth_blockNumber" })).toBe("0x1");
    expect(testnet.calls).toEqual(["eth_blockNumber"]);
  });

  test("works through viem http with a key-bearing URL", async () => {
    const seen: Seen[] = [];
    const events: HyperevmEvent[] = [];
    const client = open({
      endpoints: [DRPC, HYPERPC],
      fetchFn: rpcFetch((url, method) => {
        if (method === "eth_chainId") return { result: url === DRPC ? "0x3e6" : "0x3e7" };
        return { result: "0x10" };
      }, seen),
      onEvent: (event) => {
        events.push(event);
      },
    });
    for (let index = 0; index < 3; index += 1) await client.request({ method: "eth_blockNumber" });
    expect(seen.filter((item) => item.url === DRPC).map((item) => item.method)).toEqual(["eth_chainId"]);
    expect(events).toContainEqual({
      type: "quarantine",
      endpoint: "https://lb.drpc.example.test",
      chainId: 998,
      expected: 999,
    });
    expectNoSecret(JSON.stringify(events));
  });
});
