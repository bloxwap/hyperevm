<p align="center">
  <strong>Latency-aware typescript
    <a href="https://github.com/bloxwap/hyperevm">HyperEVM RPC transport</a></strong>
</p>

<p align="center">
  <a href="https://github.com/bloxwap/hyperevm/blob/main/LICENSE"><img alt="license" src="https://img.shields.io/github/license/bloxwap/hyperevm?style=flat-square"></a>
  <img alt="not published to npm" src="https://img.shields.io/badge/npm-not%20published-lightgrey?style=flat-square">
</p>

## Features

- **Typed**: Source code is 100% TypeScript.
- **Tested**: Offline unit tests run in CI.
- **Minimal dependencies**: viem is a peer. The package has no runtime dependencies of its own.
- **Cross-Environment Support**: Compatible with Bun, Node.js, and other JS runtimes that provide `fetch`.
- **Integratable**: A drop-in viem `Transport` for `createPublicClient`.

## Documentation

Ranking, failover, and the registry window are described in [`docs/ranking.md`](../../docs/ranking.md) in the [repository](https://github.com/bloxwap/hyperevm). Submitting a node is [`CONTRIBUTING.md`](../../CONTRIBUTING.md).

A documentation site is not published with this package yet.

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

> These commands are the published form. The package is private, so they 404 until a release is approved. Clone the repository to use the source. pnpm can install this directory with `github:bloxwap/hyperevm#path:packages/hyperevm`.

## Quick Example

### Read

```ts
// 1. Import module
import { createPublicClient } from "viem";
import { hyperEvm } from "viem/chains";
import { hyperevm } from "@bloxwap/hyperevm";

// 2. Set up client with transport
const client = createPublicClient({
  chain: hyperEvm,
  transport: hyperevm(),
});

// 3. Query data
const block = await client.getBlockNumber();
```

### Configure

```ts
// 1. Import modules
import { http } from "viem";
import { hyperevm } from "@bloxwap/hyperevm";

// 2. Set up transport with your endpoints
const transport = hyperevm({
  endpoints: [
    "https://rpc.hyperliquid.xyz/evm",
    http("https://rpc.hypurrscan.io", { batch: true }),
  ],
});

// 3. Use it from a viem client
// createPublicClient({ chain: hyperEvm, transport })
```

Hedging is off unless you set `hedge`. When it is on, a slow idempotent read is copied to the next endpoint and the first success wins. Sends are never hedged and never retried.

### Observe

```ts
// 1. Import module
import { hyperevm } from "@bloxwap/hyperevm";

// 2. Set up transport with a listener
const transport = hyperevm({
  onEvent(event) {
    if (event.type === "failover") console.log(event.from, "->", event.to);
  },
});

// 3. Read the current scores
// transport({}).value.snapshot()
```

> [!WARNING]
>
> - **Do not commit API keys inside RPC URLs.** The registry rejects credentials and query strings. Load a private endpoint from the environment (Bun auto-loads a local `.env`, which is gitignored in this repo).
> - **Sends go to one endpoint.** `eth_sendRawTransaction` is not retried. A lost response is not proof the transaction was never seen.
> - This package routes JSON-RPC. It does not sign transactions or hold a wallet.
