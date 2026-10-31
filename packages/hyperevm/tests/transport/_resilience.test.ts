import { describe, expect, test } from "bun:test";
import { createTransport, keccak256, type EIP1193Parameters, type EIP1193RequestFn, type Transport } from "viem";

import { hyperevm, type HyperevmEvent, type HyperevmTransportOptions } from "../../src/transport/mod.ts";

interface RpcBody {
  id: number;
  method: string;
  params?: unknown;
}

interface Reply {
  status?: number;
  result?: unknown;
  error?: { code: number; message: string };
  headers?: Record<string, string>;
}

interface MockFetch {
  fetchFn: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  calls: { url: string; method: string }[];
}

/** A fetch that answers single JSON-RPC calls through real viem `http()`. */
function mockFetch(handler: (url: string, body: RpcBody, seen: number) => Reply): MockFetch {
  const calls: { url: string; method: string }[] = [];
  const fetchFn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = JSON.parse(String(init?.body)) as RpcBody;
    const seen = calls.filter((call) => call.url === url).length;
    calls.push({ url, method: body.method });
    const reply = handler(url, body, seen);
    const status = reply.status ?? 200;
    if (status !== 200) return new Response("rate limited", { status, headers: reply.headers });
    const payload =
      reply.error === undefined
        ? { jsonrpc: "2.0", id: body.id, result: reply.result }
        : { jsonrpc: "2.0", id: body.id, error: reply.error };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json", ...reply.headers },
    });
  };
  return { fetchFn, calls };
}

interface MockEndpoint {
  transport: Transport;
  calls: { method: string }[];
}

function mockEndpoint(
  name: string,
  handler: (method: string, seen: number) => unknown | Promise<unknown>,
): MockEndpoint {
  const calls: { method: string }[] = [];
  const transport: Transport = () =>
    createTransport({
      key: name,
      name,
      type: "test",
      retryCount: 0,
      request: (async ({ method }: EIP1193Parameters) => {
        const seen = calls.length;
        calls.push({ method });
        return handler(method, seen);
      }) as EIP1193RequestFn,
    });
  return { transport, calls };
}

function open(options: HyperevmTransportOptions) {
  return hyperevm({
    headLag: false,
    routing: "best",
    retryCount: 2,
    hedge: false,
    ...options,
  })({ timeout: options.timeout ?? 1_000 });
}

function hang(): Promise<never> {
  return new Promise(() => {});
}

function rpcError(message: string, code: number): Error {
  return Object.assign(new Error(message), { code });
}

const A = "https://a.example.test/evm";
const B = "https://b.example.test/evm";
const C = "https://c.example.test/evm";

/** A signed type-2 transaction shape. The bytes only need to be hex. */
const RAW_TX = "0x02f86b8203e780843b9aca00847735940082520894000000000000000000000000000000000000dead8080c0";

describe("terminal errors are healthy answers", () => {
  test("reverting eth_calls do not raise the endpoint's error EWMA", async () => {
    const events: HyperevmEvent[] = [];
    const rpc = mockFetch(() => ({ error: { code: 3, message: "execution reverted: nope" } }));
    const client = open({ endpoints: [A, B], fetchFn: rpc.fetchFn, onEvent: (event) => events.push(event) });
    for (let index = 0; index < 5; index += 1) {
      await expect(client.request({ method: "eth_call", params: [{}, "latest"] })).rejects.toThrow(
        /execution reverted/,
      );
    }
    expect(rpc.calls).toHaveLength(5);
    expect(rpc.calls.every((call) => call.url === A)).toBe(true);
    for (const endpoint of client.value?.snapshot() ?? []) {
      expect(endpoint.methods["*"]?.error).toBe(0);
      expect(endpoint.methods.eth_call?.error ?? 0).toBe(0);
    }
    const snapshotA = client.value?.snapshot().find((endpoint) => endpoint.url === A);
    expect(snapshotA?.methods["*"]?.n).toBe(5);
    const errors = events.filter((event) => event.type === "error");
    expect(errors).toHaveLength(5);
    expect(errors.every((event) => event.type === "error" && event.terminal === true)).toBe(true);
    expect(events.some((event) => event.type === "eject")).toBe(false);
  });

  test("an endpoint error is not terminal and still counts against the endpoint", async () => {
    const events: HyperevmEvent[] = [];
    const dead = mockEndpoint("dead", () => {
      throw new Error("socket hang up");
    });
    const live = mockEndpoint("live", () => "0x1");
    const client = open({ endpoints: [dead.transport, live.transport], onEvent: (event) => events.push(event) });
    expect(await client.request({ method: "eth_call", params: [] })).toBe("0x1");
    const error = events.find((event) => event.type === "error");
    expect(error?.type === "error" && error.terminal).toBe(false);
    const deadSnap = client.value?.snapshot().find((endpoint) => endpoint.url === "transport:0");
    expect(deadSnap?.methods["*"]?.error).toBeGreaterThan(0);
  });
});

describe("provider limits coded as invalid params", () => {
  test("eth_getLogs fails over a -32602 block range limit", async () => {
    const rpc = mockFetch((url) =>
      url === A ? { error: { code: -32602, message: "query exceeds max block range 1000" } } : { result: [] },
    );
    const client = open({ endpoints: [A, B], fetchFn: rpc.fetchFn });
    expect(await client.request({ method: "eth_getLogs", params: [{ fromBlock: "0x1", toBlock: "0x7d0" }] })).toEqual(
      [],
    );
    expect(rpc.calls.map((call) => call.url)).toEqual([A, B]);
  });

  test("genuine invalid params stay terminal", async () => {
    const rpc = mockFetch((url) =>
      url === A
        ? { error: { code: -32602, message: "invalid argument 0: hex string without 0x prefix" } }
        : { result: [] },
    );
    const client = open({ endpoints: [A, B], fetchFn: rpc.fetchFn });
    await expect(client.request({ method: "eth_getLogs", params: [{ fromBlock: "1" }] })).rejects.toThrow(
      /hex string without 0x prefix/,
    );
    expect(rpc.calls.map((call) => call.url)).toEqual([A]);
  });
});

describe("re-trying endpoints with backoff", () => {
  test("a single endpoint survives one 429 with the default retryCount", async () => {
    const rpc = mockFetch((_url, _body, seen) => (seen === 0 ? { status: 429 } : { result: "0x10" }));
    const client = hyperevm({ endpoints: [A], fetchFn: rpc.fetchFn, headLag: false })({ timeout: 1_000 });
    const started = Date.now();
    expect(await client.request({ method: "eth_blockNumber" })).toBe("0x10");
    expect(rpc.calls).toHaveLength(2);
    // Default base is 100ms with jitter between half and all of it.
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
  });

  test("every endpoint is tried once before any is tried again", async () => {
    const rpc = mockFetch((_url, _body, seen) => (seen === 0 ? { status: 503 } : { result: "0x1" }));
    const client = open({ endpoints: [A, B], fetchFn: rpc.fetchFn, retryCount: 3, retryDelay: 1 });
    expect(await client.request({ method: "eth_chainId" })).toBe("0x1");
    const urls = rpc.calls.map((call) => call.url);
    expect(urls).toHaveLength(3);
    // Both endpoints fail once before either is called a second time. The re-try goes to the better score.
    expect(urls.slice(0, 2)).toEqual([A, B]);
    expect([A, B]).toContain(urls[2] ?? "");
  });

  test("the caller's AbortSignal cancels a backoff", async () => {
    const rpc = mockFetch(() => ({ status: 503 }));
    const client = open({ endpoints: [A], fetchFn: rpc.fetchFn, retryDelay: 1_500 });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const started = Date.now();
    const error = await client
      .request({ method: "eth_blockNumber" }, { signal: controller.signal })
      .then(() => undefined)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("AbortError");
    expect(Date.now() - started).toBeLessThan(500);
    expect(rpc.calls).toHaveLength(1);
  });
});

describe("circuit breaker", () => {
  test("a full 429 outage does not multiply upstream requests", async () => {
    const events: HyperevmEvent[] = [];
    const rpc = mockFetch(() => ({ status: 429 }));
    const client = open({ endpoints: [A, B, C], fetchFn: rpc.fetchFn, onEvent: (event) => events.push(event) });
    for (let index = 0; index < 10; index += 1) {
      await expect(client.request({ method: "eth_call", params: [] })).rejects.toThrow();
    }
    // Three calls trip all three breakers (9 requests). The rest send one request each.
    expect(rpc.calls).toHaveLength(16);
    const ejected = events.filter((event) => event.type === "eject");
    expect(ejected.map((event) => event.endpoint).sort()).toEqual([A, B, C]);
    for (const event of ejected) expect(event).toMatchObject({ failures: 3, cooldownMs: 5_000 });
  });

  test("Retry-After ejects the endpoint for the time the provider asked for", async () => {
    const events: HyperevmEvent[] = [];
    const rpc = mockFetch((url, _body, seen) =>
      url === A && seen === 0 ? { status: 429, headers: { "retry-after": "30" } } : { result: "0x1" },
    );
    const client = open({ endpoints: [A, B], fetchFn: rpc.fetchFn, onEvent: (event) => events.push(event) });
    for (let index = 0; index < 6; index += 1) expect(await client.request({ method: "eth_chainId" })).toBe("0x1");
    const eject = events.find((event) => event.type === "eject");
    expect(eject).toMatchObject({ type: "eject", endpoint: A, failures: 1, cooldownMs: 30_000 });
    expect(rpc.calls.filter((call) => call.url === A)).toHaveLength(1);
    expect(rpc.calls.filter((call) => call.url === B)).toHaveLength(6);
  });

  test("a success after ejection restores the endpoint", async () => {
    let nowMs = 0;
    const events: HyperevmEvent[] = [];
    const flaky = mockEndpoint("flaky", (_method, seen) => {
      if (seen < 3) throw new Error("socket hang up");
      return "0x1";
    });
    const client = open({
      endpoints: [flaky.transport],
      retryCount: 0,
      now: () => nowMs,
      breaker: { threshold: 3, cooldown: 1_000 },
      onEvent: (event) => events.push(event),
    });
    for (let index = 0; index < 3; index += 1) {
      await expect(client.request({ method: "eth_chainId" })).rejects.toThrow(/socket hang up/);
    }
    expect(events.filter((event) => event.type === "eject")).toHaveLength(1);
    nowMs += 1_000;
    expect(await client.request({ method: "eth_chainId" })).toBe("0x1");
    expect(events.at(-1)).toEqual({ type: "restore", endpoint: "transport:0" });
  });

  test("breaker false keeps every failover", async () => {
    const rpc = mockFetch(() => ({ status: 429 }));
    const client = open({ endpoints: [A, B, C], fetchFn: rpc.fetchFn, breaker: false });
    for (let index = 0; index < 4; index += 1) {
      await expect(client.request({ method: "eth_call", params: [] })).rejects.toThrow();
    }
    expect(rpc.calls).toHaveLength(12);
  });
});

describe("raw transaction rebroadcast", () => {
  test("eth_sendRawTransaction fails over an endpoint error", async () => {
    const hash = keccak256(RAW_TX);
    const rpc = mockFetch((url) => (url === A ? { status: 503 } : { result: hash }));
    const client = open({ endpoints: [A, B], fetchFn: rpc.fetchFn });
    expect(await client.request({ method: "eth_sendRawTransaction", params: [RAW_TX] })).toBe(hash);
    expect(rpc.calls.map((call) => call.url)).toEqual([A, B]);
  });

  test("an already known answer on a re-send returns the transaction hash", async () => {
    const slow = mockEndpoint("slow", hang);
    const known = mockEndpoint("known", () => {
      throw rpcError("already known", -32000);
    });
    const client = open({ endpoints: [slow.transport, known.transport], timeout: 40 });
    expect(await client.request({ method: "eth_sendRawTransaction", params: [RAW_TX] })).toBe(keccak256(RAW_TX));
    expect(slow.calls).toHaveLength(1);
    expect(known.calls).toHaveLength(1);
  });

  test("already known on the first send is returned to the caller", async () => {
    const known = mockEndpoint("known", () => {
      throw rpcError("already known", -32000);
    });
    const other = mockEndpoint("other", () => "0xother");
    const client = open({ endpoints: [known.transport, other.transport] });
    await expect(client.request({ method: "eth_sendRawTransaction", params: [RAW_TX] })).rejects.toThrow(
      /already known/,
    );
    expect(other.calls).toHaveLength(0);
  });

  test("a node's verdict on the transaction does not fail over", async () => {
    const low = mockEndpoint("low", () => {
      throw rpcError("nonce too low: next nonce 5, tx nonce 4", -32000);
    });
    const other = mockEndpoint("other", () => "0xother");
    const client = open({ endpoints: [low.transport, other.transport] });
    await expect(client.request({ method: "eth_sendRawTransaction", params: [RAW_TX] })).rejects.toThrow(
      /nonce too low/,
    );
    expect(other.calls).toHaveLength(0);
    const lowSnap = client.value?.snapshot().find((endpoint) => endpoint.url === "transport:0");
    expect(lowSnap?.methods["*"]?.error).toBe(0);
  });

  test("eth_sendRawTransactionSync fails over but cannot turn already known into a receipt", async () => {
    const down = mockEndpoint("down", () => {
      throw new Error("socket hang up");
    });
    const receipt = { transactionHash: keccak256(RAW_TX), status: "0x1" };
    const live = mockEndpoint("live", () => receipt);
    const client = open({ endpoints: [down.transport, live.transport] });
    expect(await client.request({ method: "eth_sendRawTransactionSync", params: [RAW_TX] })).toEqual(receipt);

    const slow = mockEndpoint("slow", hang);
    const known = mockEndpoint("known", () => {
      throw rpcError("already known", -32000);
    });
    const sync = open({ endpoints: [slow.transport, known.transport], timeout: 40 });
    await expect(sync.request({ method: "eth_sendRawTransactionSync", params: [RAW_TX] })).rejects.toThrow(
      /already known/,
    );
  });

  test("rebroadcastRawTransactions false sends once", async () => {
    const rpc = mockFetch((url) => (url === A ? { status: 503 } : { result: "0xhash" }));
    const client = open({ endpoints: [A, B], fetchFn: rpc.fetchFn, rebroadcastRawTransactions: false });
    await expect(client.request({ method: "eth_sendRawTransaction", params: [RAW_TX] })).rejects.toThrow();
    expect(rpc.calls).toHaveLength(1);
  });

  test("other non-idempotent methods stay single-attempt and raw sends are never hedged", async () => {
    const rpc = mockFetch(() => ({ status: 503 }));
    const client = open({ endpoints: [A, B], fetchFn: rpc.fetchFn });
    await expect(client.request({ method: "eth_sendTransaction", params: [{}] })).rejects.toThrow();
    await expect(client.request({ method: "personal_sign", params: ["0x00", A] })).rejects.toThrow();
    expect(rpc.calls.map((call) => call.method)).toEqual(["eth_sendTransaction", "personal_sign"]);

    const slow = mockEndpoint("slow", async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      return "0xslow";
    });
    const fast = mockEndpoint("fast", () => "0xfast");
    const hedged = open({ endpoints: [slow.transport, fast.transport], hedge: { minDelay: 10, multiplier: 0 } });
    expect(await hedged.request({ method: "eth_sendRawTransaction", params: [RAW_TX] })).toBe("0xslow");
    expect(fast.calls).toHaveLength(0);
  });
});
