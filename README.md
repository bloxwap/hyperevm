<h1 align="center">HyperEVM RPC</h1>

<p align="center"><strong>Latency-aware JSON-RPC transport for HyperEVM. A viem <code>Transport</code> that ranks endpoints from the calls your process already made.</strong></p>

<p align="center">
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/github/license/bloxwap/hyperevm?style=flat-square"></a>
  <img alt="not published to npm" src="https://img.shields.io/badge/npm-not%20published-lightgrey?style=flat-square">
</p>

## Features

- **Typed.** Source code is 100% TypeScript with comprehensive type safety.
- **Minimal dependencies.** No runtime dependencies of its own. [viem](https://github.com/wevm/viem) is a peer.
- **Cross-environment support.** Compatible with Bun, Node.js, browsers, and edge runtimes that provide `fetch`.
- **Easy integration.** `hyperevm()` is a viem `Transport`. Pass it to `createPublicClient` the same way you pass `http()` or `fallback()`.
- **Tested.** The offline suite runs in CI. It does not call the public network.

## Installation

### Bun

```sh
bun add @bloxwap/hyperevm
```

### Node.js 22.12+

```sh
npm i @bloxwap/hyperevm
```

### pnpm

```sh
pnpm add @bloxwap/hyperevm
```

### Yarn

```sh
yarn add @bloxwap/hyperevm
```

> These are the commands a published release will use. `@bloxwap/hyperevm` is still private, so the registry 404s until a publish is approved. Clone this repository to use the source today. `github:bloxwap/hyperevm` resolves to the private workspace root, which does not export the transport. pnpm can select the library with `github:bloxwap/hyperevm#path:packages/hyperevm`.

## Release status

`0.1.0` is an early developer preview. The package stays private until a publish is approved. Expect breaking changes before `1.0`.

## Usage

### Read

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

With no arguments, `hyperevm()` calls the eligible HTTP rows in [`packages/hyperevm/registry/nodes.json`](packages/hyperevm/registry/nodes.json). HyperEVM mainnet is chain id 999.

### Configure

```ts
import { http } from "viem";
import { hyperevm } from "@bloxwap/hyperevm";

const transport = hyperevm({
  endpoints: [
    "https://rpc.hyperliquid.xyz/evm",
    http("https://rpc.hypurrscan.io", { batch: true }),
  ],
  hedge: { minDelay: 250, multiplier: 2 },
});
```

URL strings are wrapped in viem's `http()`, or `webSocket()` when the URL is `wss://`. A transport you pass in keeps the batching it was created with. Idempotent reads fail over on timeout, rate limit, and connection loss. `eth_sendRawTransaction` and the other non-idempotent methods go to one endpoint.

### Observe

```ts
import { hyperevm } from "@bloxwap/hyperevm";

const transport = hyperevm({
  onEvent(event) {
    if (event.type === "failover") console.log(event.from, "->", event.to);
  },
});
```

`onEvent` is telemetry. A throw inside the listener does not fail the request. `transport.value.snapshot()` returns the current scores, heads, and in-flight counts. The score, the registry window, and the anti-gaming rules are in [docs/ranking.md](docs/ranking.md).

## Documentation

The ranking write-up is [docs/ranking.md](docs/ranking.md). Submitting a public endpoint is [CONTRIBUTING.md](CONTRIBUTING.md).

A Fumadocs site is not part of this repository yet. The package reference lives on [`packages/hyperevm`](packages/hyperevm/README.md), and the public types are documented in JSDoc on `src/mod.ts`.

## Development

This repository is a Bun workspace with one install and one root `bun.lock`:

| Workspace | Purpose |
| --- | --- |
| [`packages/hyperevm`](packages/hyperevm/README.md) | `@bloxwap/hyperevm` transport, registry, tests, and package tooling |

The root package is private and coordinates development. The library builds to `packages/hyperevm/dist`. Exports point at TypeScript sources. Nothing in this repository is published to npm.

Run these commands from the repository root:

```sh
bun install --frozen-lockfile
bun run check
bun run test
bun run build
```

Type-checking uses `tsc --noEmit`. `bun run rank` probes the public lists and rewrites the registry. It does not push to `main`.

## Security

**Registry rows and examples are public URLs.** Do not commit an RPC URL that contains an API key, username, or password. The ranker rejects credentials and query strings. Load a private endpoint from the environment. Bun reads a local `.env`, and this repository gitignores it.

This package routes JSON-RPC. It does not sign transactions or hold a wallet.

## License

[MIT](LICENSE)
