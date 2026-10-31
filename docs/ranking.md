# Ranking

`@bloxwap/hyperevm` has two rankers. They answer different questions.

The **transport** ranks endpoints from the calls your process is making right now. The **registry ranker** (`bun run rank`) decides which public URLs are worth putting in that pool, and at what weight, from a rolling window of probes. A fast sample on a brand-new URL cannot take the pool over.

## Runtime score

For each endpoint the transport keeps a latency EWMA, a tail EWMA, an error EWMA, and the number of calls currently in flight. Per-method books (`eth_call`, `eth_getLogs`, and so on) are separate. Until a method has a few samples, its score blends back toward the endpoint's global book.

Service time is

```
service = mix * ewma + (1 - mix) * tail
```

with `mix` defaulting to 0.6 (`latencyMix`). The tail EWMA uses a larger step when the new sample is slower than the tail (`tailAlphaUp` 0.5), and a small step when it is faster (`tailAlphaDown` 0.05). The mean uses `ewmaAlphaUp` 0.4 and `ewmaAlphaDown` 0.2. Failures move an error EWMA with `errorAlpha` 0.3. A single slow response moves the tail immediately. A run of fast responses does not wipe it out. That is the C3 idea used here: rank on the slow tail, not only the mean. The cubic queue function from the C3 paper is not used raw. A burst of parallel `eth_call`s would otherwise exile a healthy public node. The in-flight term is Prequal's "your call waits behind the ones already running", plus a damped square:

```
inflation = 1 + inflight + 0.25 * inflight^2
score     = service * inflation * (1 + 8 * error) * lagPenalty / weight
```

Lower score is better. `weight` comes from the registry. An explicit endpoint you pass yourself defaults to weight 1 when the registry has no positive weight for it.

`lagPenalty` is 1 when head-lag checks are off, when this endpoint's head is unknown, or when it is within `maxLag` blocks (default 2) of the best head seen recently. Past that, the penalty is `1 + lagWeight * (lag - maxLag)`, and `lagWeight` defaults to 1.

The first attempt uses power of two choices: draw two endpoints that support the method, send to the one with the better score. Failover, and hedging, then take the best remaining endpoint. Ties break toward the earlier endpoint.

Head probes call `eth_blockNumber` on an interval (default 4 seconds). A successful probe updates the head and cools the error rate. It does not write the latency EWMA, so the timer is not a second copy of viem's `rank` ping. A failed probe does push the tail, because a node that stops answering should lose traffic before the next user call hangs. The timer is unref'd on Node and Bun so it does not keep a short-lived process alive.

## What is not retried

These methods go to one endpoint and are never hedged:

`eth_sendRawTransaction`, `eth_sendRawTransactionSync`, `eth_sendTransaction`, `eth_sign`, `eth_signTransaction`, `eth_signTypedData`, `eth_signTypedData_v3`, `eth_signTypedData_v4`, `personal_sign`, `personal_sendTransaction`, `eth_submitWork`, `eth_submitHashrate`, `wallet_sendTransaction`, `wallet_sendCalls`, `eth_subscribe`.

Pass more names in `nonIdempotentMethods`.

Failover also stops on execution reverts, invalid params, invalid requests, parse errors, transaction rejections, user rejections, and caller aborts. A timeout, a reset connection, a rate limit, an internal error, or "method not found" tries the next endpoint, up to `retryCount` extra attempts (default 2). The same endpoint is not tried twice for one call.

Hedging is off unless you set `hedge`. When it is on, an idempotent read that is still running after `max(minDelay, multiplier * tail)` is copied to the next endpoint. The first success wins. Cancelling the loser does not count as an error. A lost `eth_sendRawTransaction` response is not proof the transaction was never seen, so sends are not hedged.

## Registry score

`packages/hyperevm/.dev/rank.ts` fetches the source lists, merges them with `packages/hyperevm/registry/nodes.json`, probes every HTTP URL, appends the observations to `packages/hyperevm/registry/history.json`, and writes ranks back. The workflow `.github/workflows/rank-registry.yml` runs that weekly and on demand, then opens a pull request. It does not push to `main`.

A probe is `eth_chainId`, `eth_blockNumber`, `eth_call` to the zero address, and `eth_getLogs` for a single block filtered to an address that should have no logs. The chain id must be 999. A higher head from a node on the wrong chain is ignored.

`lag` is how many blocks behind the best head in that probe run the node was. Heads are not sampled at the same instant, and HyperEVM produces a block about once a second, so each head is projected forward to the latest sample in the run before the gap is measured. The registry score then ignores the first 2 blocks of lag, the same grace the transport uses. Past that, the penalty is `1 + (lag - 2)`.

Inside the window (28 days):

- **Uptime** is successes over observations. Below 0.5 the endpoint stays listed at weight 0.
- **Latency** is the worst per-method median, not the best. A node that is quick at `eth_chainId` and slow at `eth_getLogs` is scored on `eth_getLogs`. **Tail** is the slowest successful sample in the window.
- **Lag** uses the adjustment above. A node one or two blocks behind scores the same as a node at the tip. A node many blocks behind does not.
- **Established** means at least 3 successes, uptime at least 0.8, and the first and last observation in the window at least 14 days apart. Established endpoints get weight 1.
- Everyone else with a success and uptime at least 0.5 gets the **new-node cap**, weight 0.15. Three probes fired the same day do not establish a node. The weekly schedule cannot be gamed by re-running the workflow.
- Once any endpoint is established, the non-established endpoints together are scaled down until they are at most 25% of the total weight. If nobody is established yet, the cap is not applied on top of itself, so a fresh registry still spreads traffic.

WebSocket URLs are stored and are not part of the default HTTP pool. The transport will use a `wss://` URL when you pass it yourself.

Community submissions (see [CONTRIBUTING.md](../CONTRIBUTING.md)) stay in the file when upstream lists stop mentioning them. An upstream URL that disappears from every source is removed on the next successful run.

If a source list fails to download, the script exits and does not write. If a registry that already had eligible endpoints gets a run where nobody returns chain id 999, the script also refuses to write. One bad network day must not empty the pool.

## Sources

The ranker reads only these documents:

| Source | What it contributes |
| --- | --- |
| [chainlist `chainid-999.js`](https://github.com/DefiLlama/chainlist/blob/main/constants/additionalChainRegistry/chainid-999.js) | HyperEVM's `rpc` array. The file's name and `"chainId": 999` are both required, so a different chain cannot be parsed by accident. |
| [chainlist `extraRpcs.js`](https://github.com/DefiLlama/chainlist/blob/main/constants/extraRpcs.js) | The `999` object only. Chainlist's chain id table labels 999 as Hyperliquid. |
| [ChainIndex](https://www.chainindex.dev/chains/hyperevm) | RPC-shaped links on the HyperEVM page. |
| [OpenChainBench](https://openchainbench.com/benchmarks/hyperliquid-rpc) | RPC-shaped links on the Hyperliquid public-endpoint benchmark. |
| [Hyperliquid docs](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm) | The documented mainnet URL. Testnet URLs in the same page are dropped. |

URLs with a query string, a username, or a hash are rejected. `http://` is rejected. Anything whose URL contains `testnet` is rejected.

**ethereum-lists `eip155-999.json` is not a source.** That file is Wanchain Testnet, which reused chain id 999. The parser and the registry check both refuse a hostname of `wandevs.org` or a subdomain of it.

## Gaps

- There is no merged `value.subscribe`. A subscription stays on the socket that accepted `eth_subscribe`. viem's `fallback` has the same gap. HTTP endpoints do not serve subscriptions.
- Hedge defaults off. A stall study is in [benchmarks.md](benchmarks.md). The cold hedge fires at `minDelay` (250ms), and several public nodes are slower than that, so those first calls would be duplicated.
- The shipped history starts with one probe run. Full weight waits for the window above, so every endpoint in the first ranked file is on the new-node cap.
- The simulated comparison with viem `fallback` is in [benchmarks.md](benchmarks.md). A live run is a manual workflow, not part of CI.
