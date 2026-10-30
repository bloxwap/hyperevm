<h1 align="center">HyperEVM RPC</h1>

<p align="center">
  <strong>A latency-aware JSON-RPC transport for HyperEVM. It is a drop-in viem <code>Transport</code> that ranks endpoints from real requests, instead of viem's <code>fallback</code>.</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/bloxwap/hyperevm?style=flat-square" alt="license"></a>
  <img src="https://img.shields.io/badge/npm-not%20published-lightgrey?style=flat-square" alt="not published to npm">
</p>

> **Not published.** `@bloxwap/hyperevm` is private and is not on npm. Installing from the registry will 404 until a release is approved. The code in this repository is the v0.1 transport.

## Features

- **Live ranking.** Each endpoint keeps a latency EWMA, a slow-moving tail, an error rate, and an in-flight penalty. The next call follows those numbers. viem's `fallback` only moves after a failure, and its `rank` option samples on a timer.
- **Failover with a deadline.** Idempotent calls try the next endpoint on timeout, rate limit, and connection loss. Execution reverts and invalid params are returned as-is.
- **Sends are not retried.** `eth_sendRawTransaction` and the other non-idempotent methods go to one endpoint. They are never hedged.
- **Per-method books.** `eth_call` and `eth_getLogs` are scored separately, so a node that is fast at one and slow at the other is used for the one it is fast at.
- **Head lag.** A node whose latest block trails the best head this process has seen is deprioritized. The background probe refreshes heads. It does not write the latency EWMA.
- **Optional hedging.** When enabled, a slow idempotent read is copied to the next endpoint and the first success wins. This is off by default.
- **A public registry.** `hyperevm()` with no arguments uses [`registry/nodes.json`](registry/nodes.json): public HyperEVM URLs, chain id 999, with weights from the ranker. You can pass your own URLs or viem transports instead.
- **Cross-runtime.** The source is TypeScript with no runtime dependencies of its own. viem is a peer. It runs on Bun, Node.js, browsers, and edge runtimes that provide `fetch`.

## Installation

The package is not on npm yet. For now, depend on the repository:

```sh
bun add github:bloxwap/hyperevm
```

After a published release, the install will be:

```sh
bun add @bloxwap/hyperevm
```

```sh
npm i @bloxwap/hyperevm
```

ESM only. Node.js 22.12 or newer. viem 2 is a peer dependency.

## Release status

`0.1.0` is an early developer preview and the package is still private. Expect breaking changes before `1.0`. Hedging defaults off. Registry weights are capped until an endpoint has stayed up across the probe window. There is no docs site yet.

## Usage

```ts
import { createPublicClient } from "viem";
import { hyperEvm } from "viem/chains";
import { hyperevm } from "@bloxwap/hyperevm";

const client = createPublicClient({
  chain: hyperEvm,
  transport: hyperevm(),
});

const block = await client.getBlockNumber();
```

Your own endpoints, as URLs or as viem transports:

```ts
import { http } from "viem";
import { hyperevm } from "@bloxwap/hyperevm";

const transport = hyperevm({
  endpoints: [
    "https://rpc.hyperliquid.xyz/evm",
    http("https://rpc.hypurrscan.io", { batch: true }),
  ],
  // Copy a slow eth_call to the next endpoint. Sends are never hedged.
  hedge: { minDelay: 250, multiplier: 2 },
  onEvent(event) {
    if (event.type === "failover") console.log(event.from, "->", event.to);
  },
});
```

URL strings are wrapped in viem's `http()`, or `webSocket()` when the URL is `wss://`. Pass `batch: true` (or `{ batchSize, wait }`) to coalesce those HTTP calls the same way `http(url, { batch: true })` does. A transport you pass in keeps its own batching because the instance is created once, not on every call.

## How this differs from `fallback`

| | `fallback([...])` | `hyperevm()` |
| --- | --- | --- |
| When it leaves an endpoint | After that endpoint throws | After a failure, and before that when the score gets worse |
| Latency signal | Optional timer ping, default `net_listening` | EWMA and tail of the calls you actually made |
| In-flight work | Ignored | Inflates the score (Prequal), with a damped queue term |
| Per method | One ranking for every method | Separate books, blended until a method has samples |
| Head lag | None | Nodes behind the best known head are pushed down |
| Hedging | None | Opt-in, idempotent reads only |
| `eth_sendRawTransaction` | The next transport is tried | Not retried, not hedged |
| Batching | Whatever the child transport does | Same, via viem `http` for URL endpoints |
| Subscriptions | No merged `subscribe` | Same gap. `eth_subscribe` is not retried |

The score, the registry window, and the anti-gaming rules are written out in [docs/ranking.md](docs/ranking.md).

## API

```ts
import {
  hyperevm,
  defaultRegistry,
  registryHttpEndpoints,
  HYPEREVM_CHAIN_ID,
  NON_IDEMPOTENT_METHODS,
  type HyperevmTransportOptions,
  type HyperevmEvent,
} from "@bloxwap/hyperevm";
```

| Export | Description |
| --- | --- |
| `hyperevm(options?)` | Returns a viem `Transport`. No arguments uses the eligible HTTP rows in the registry. |
| `defaultRegistry` | The parsed `registry/nodes.json` document shipped with the package. |
| `registryHttpEndpoints()` | `{ url, weight }[]` for rows the default transport will call. |
| `HYPEREVM_CHAIN_ID` | `999`. |
| `NON_IDEMPOTENT_METHODS` | Methods that are sent to at most one endpoint. |
| `rankRegistry` | Pure function the probe script uses to turn observations into weights. |

### Options

| Option | Default | Description |
| --- | --- | --- |
| `endpoints` | Registry HTTP pool | URLs or viem `Transport`s. |
| `batch` | off | Forwarded to viem `http()` for URL endpoints. |
| `fetchFn` | global `fetch` | Injected fetch for URL endpoints. |
| `timeout` | Client timeout, or `10000` | Per-attempt deadline in milliseconds. |
| `retryCount` | `2` | Extra failovers after the first attempt. Idempotent methods only. |
| `retryDelay` | `0` | Wait between failovers, in milliseconds. |
| `perMethod` | `true` | Keep a separate score per JSON-RPC method. |
| `headLag` | on, probe every `4000`ms, `maxLag` 2 blocks | Set `false` to disable. `probeInterval: false` keeps lag penalties but skips the timer. |
| `hedge` | off | `true`, or `{ minDelay, multiplier }`, for idempotent reads. |
| `routing` | `"p2c"` | `"best"` always picks the lowest score. `"p2c"` draws two candidates and keeps the better one. |
| `nonIdempotentMethods` | none | Extra method names that must not be retried or hedged. |
| `shouldThrow` | terminal errors already stop failover | Return true to stop failover for an error the default policy would retry. Same hook as viem `fallback`. |
| `onEvent` | none | Telemetry. Throwing from the listener does not fail the request. |

`transport.value.snapshot()` returns the current scores, heads, and in-flight counts. `transport.value.onEvent(listener)` subscribes to the same events as the option and returns an unsubscribe function.

### Gaps

- No merged WebSocket `subscribe`. A live subscription stays on the socket that accepted it. That matches viem `fallback`.
- JSON-RPC batches are one HTTP call inside the child `http()` transport. If that call fails, each idempotent request failovers on its own. A batch that includes `eth_sendRawTransaction` is still not sent to a second endpoint.
- Hedge and the registry math are implemented. A published benchmark against `fallback` is not.

## Registry

Public endpoints live in [`registry/nodes.json`](registry/nodes.json). The shape is [`registry/schema.json`](registry/schema.json). [`registry/history.json`](registry/history.json) is the rolling probe window.

`bun run rank` fetches Chainlist (the HyperEVM additional-registry file and the `999` block of `extraRpcs.js`), ChainIndex, OpenChainBench, and the Hyperliquid docs. It probes each HTTP URL and writes ranks. ethereum-lists chain 999 is Wanchain Testnet and is not a source.

To add an endpoint, open a pull request that appends a community row. The steps are in [CONTRIBUTING.md](CONTRIBUTING.md). New URLs stay on a low weight until they have been up across the window, and a pile of new URLs cannot outweigh endpoints that have already earned full weight.

## Roadmap

1. **v0.1 (this repository).** Latency-weighted routing, failover, timeouts, non-idempotent safety, viem `http` batching, per-method scores, head lag, an opt-in hedge, an `onEvent` hook, the public registry, and the ranker that opens a pull request.
2. **Still open.** A measured comparison against `fallback` under load. Subscription re-homing when a socket drops. A documentation site.
3. **v1.0.** A stable API, the docs site, and an npm publish. Publishing stays blocked until it is explicitly approved.

## Development

```sh
bun install --frozen-lockfile
bun run check          # format, lint, typecheck
bun test
bun run build          # bundle emit in dist/, exports still point at src/mod.ts
bun run rank           # refresh registry/nodes.json from the public lists
```

Requires Bun. Node.js 22.12 or newer. CI runs on GitHub-hosted Ubuntu. The other Bloxwap repositories use the org's self-hosted macOS runners. This repo does not.

## License

[MIT](LICENSE)
