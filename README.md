<h1 align="center">HyperEVM RPC</h1>

<p align="center"><strong>A fast, load-balanced RPC transport for HyperEVM. It works as a drop-in upgrade over viem's <code>fallback</code> transport.</strong></p>

> **Status: early scaffolding.** The connector isn't published yet. Watch or star the repo to follow along.

## What it is

`@bloxwap/hyperevm` is a TypeScript RPC connector for HyperEVM chains. You give it several JSON-RPC endpoints, and it sends each request to the one that is fastest and healthiest right now, based on latency it measures live. It's designed to slot in wherever you'd use viem's `fallback([...])` transport today, with no other changes to your client code.

## Why it exists

Free public HyperEVM RPCs are easy to start with, but they throttle, rate-limit and fall behind the chain head under load. viem's `fallback` transport only moves to the next endpoint after one fails, and its optional ranking samples latency on a timer instead of from real traffic. That leaves apps sitting on a slow or stale node until it errors out.

This package spreads requests across many public RPCs using latency telemetry from the requests themselves, so traffic moves away from a node as soon as it starts to degrade rather than after it fails.

## Planned features

- **Per-method latency tracking.** Latency and error rates are tracked separately for each endpoint and each RPC method, because a node that's fast at `eth_call` can be slow at `eth_getLogs`.
- **Head-lag checks.** Nodes whose latest block trails the best known head are deprioritized, so reads don't return stale state.
- **Request hedging.** When the first endpoint is slower than its usual latency, a duplicate read goes to the next-best endpoint and whichever answers first wins. This only applies to idempotent reads, never to transaction sends.
- **Open node registry.** A community list of public HyperEVM RPC endpoints, ranked by measured uptime and latency, which you can use as is or extend with your own.
- **viem-compatible API.** It's a viem `Transport`, so `createPublicClient({ transport: hyperevm() })` just works.
- **Cross-runtime.** It runs on Bun, Node.js, browsers and edge runtimes with minimal dependencies.

## Planned usage

```ts
import { createPublicClient } from "viem";
import { hyperEvm } from "viem/chains";
import { hyperevm } from "@bloxwap/hyperevm";

const client = createPublicClient({
  chain: hyperEvm,
  transport: hyperevm(), // uses the open node registry by default
});
```

This API is a sketch and may change before the first release.

## Roadmap

1. **v0.1:** Latency-weighted routing across a static endpoint list, retries with failover, and full viem `Transport` compatibility.
2. **v0.2:** Per-method latency tracking and head-lag checks.
3. **v0.3:** Request hedging for reads, plus benchmarks against viem's `fallback` transport.
4. **v0.4:** An open node registry with uptime-based ranking and a community submission process.
5. **v1.0:** A stable API, documentation site, and telemetry hooks for metrics.

## Contributing

Issues and ideas are welcome. Please open an issue before starting a large change.

## License

[MIT](./LICENSE)
