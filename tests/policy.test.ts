import { describe, expect, test } from "bun:test";

import {
  defaultRankPolicy,
  mergeEndpointInputs,
  rankRegistry,
  type ProbeObservation,
  type RegistryEndpointInput,
} from "../src/policy.ts";

const NOW = Date.parse("2026-10-30T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function endpoint(url: string, kind: RegistryEndpointInput["kind"] = "http"): RegistryEndpointInput {
  return {
    url,
    kind,
    tracking: "unknown",
    sources: [{ name: "chainlist", url: "https://example.test/chain" }],
    submission: "upstream",
    addedAt: new Date(NOW - 30 * DAY).toISOString(),
  };
}

function observation(url: string, daysAgo: number, ms: number, ok = true, chainIdOk = true): ProbeObservation {
  return {
    at: new Date(NOW - daysAgo * DAY).toISOString(),
    url,
    ok: ok && chainIdOk,
    chainIdOk,
    head: chainIdOk ? 1_000 : null,
    lag: 0,
    methods: {
      eth_chainId: { ms, ok: chainIdOk },
      eth_blockNumber: { ms, ok },
      eth_call: { ms: ms + 5, ok },
      eth_getLogs: { ms: ms + 50, ok },
    },
  };
}

describe("rankRegistry", () => {
  test("a single fast probe stays under the new-node cap", () => {
    const [ranked] = rankRegistry(
      [endpoint("https://new.example/evm")],
      [observation("https://new.example/evm", 0, 40)],
      NOW,
    );
    expect(ranked?.eligible).toBe(true);
    expect(ranked?.stats?.established).toBe(false);
    expect(ranked?.weight).toBe(defaultRankPolicy.newNodeWeightCap);
    expect(ranked?.rank).toBe(1);
  });

  test("three successes spread across the window earn full weight", () => {
    const url = "https://veteran.example/evm";
    const observations = [20, 10, 1].map((daysAgo) => observation(url, daysAgo, 80));
    const [ranked] = rankRegistry([endpoint(url)], observations, NOW);
    expect(ranked?.stats?.established).toBe(true);
    expect(ranked?.weight).toBe(1);
  });

  test("three probes on the same day do not establish an endpoint", () => {
    const url = "https://burst.example/evm";
    const observations = [0, 0, 0].map(() => observation(url, 0, 30));
    const [ranked] = rankRegistry([endpoint(url)], observations, NOW);
    expect(ranked?.stats?.established).toBe(false);
    expect(ranked?.weight).toBe(defaultRankPolicy.newNodeWeightCap);
  });

  test("low uptime is listed but not eligible", () => {
    const url = "https://flaky.example/evm";
    const observations = [
      observation(url, 0, 40, true),
      observation(url, 0, 40, false),
      observation(url, 0, 40, false),
    ];
    const [ranked] = rankRegistry([endpoint(url)], observations, NOW);
    expect(ranked?.eligible).toBe(false);
    expect(ranked?.weight).toBe(0);
    expect(ranked?.rank).toBeNull();
  });

  test("a wrong chain id does not count as success", () => {
    const url = "https://wanchain.example/evm";
    const [ranked] = rankRegistry([endpoint(url)], [observation(url, 0, 10, true, false)], NOW);
    expect(ranked?.eligible).toBe(false);
  });

  test("the slowest successful method sets the latency, so a cheap eth_chainId cannot hide a slow eth_getLogs", () => {
    const url = "https://skewed.example/evm";
    const sample = observation(url, 0, 20);
    sample.methods.eth_chainId = { ms: 15, ok: true };
    sample.methods.eth_getLogs = { ms: 900, ok: true };
    const [ranked] = rankRegistry([endpoint(url)], [sample], NOW);
    expect(ranked?.stats?.latencyMs).toBe(900);
  });

  test("two blocks of lag do not outrank a faster node, and a large lag does", () => {
    const fresh = "https://fresh.example/evm";
    const fast = "https://fast.example/evm";
    const behind = "https://behind.example/evm";
    const freshObs = observation(fresh, 0, 200);
    const fastObs = observation(fast, 0, 40);
    fastObs.lag = 2;
    const ranked = rankRegistry([endpoint(fresh), endpoint(fast)], [freshObs, fastObs], NOW);
    expect(ranked[0]?.url).toBe(fast);

    const behindObs = observation(behind, 0, 40);
    behindObs.lag = 10;
    const compared = rankRegistry([endpoint(fresh), endpoint(behind)], [freshObs, behindObs], NOW);
    expect(compared[0]?.url).toBe(fresh);
  });

  test("new endpoints together cannot crowd out an established one", () => {
    const veteran = "https://veteran.example/evm";
    const fresh = Array.from({ length: 10 }, (_, index) => `https://new-${index}.example/evm`);
    const observations = [
      ...[20, 10, 1].map((daysAgo) => observation(veteran, daysAgo, 100)),
      ...fresh.map((url) => observation(url, 0, 10)),
    ];
    const ranked = rankRegistry([endpoint(veteran), ...fresh.map((url) => endpoint(url))], observations, NOW);
    const established = ranked.find((item) => item.url === veteran);
    const newcomers = ranked.filter((item) => item.url !== veteran && item.eligible);
    expect(established?.weight).toBe(1);
    const newWeight = newcomers.reduce((sum, item) => sum + item.weight, 0);
    const share = newWeight / (established!.weight + newWeight);
    expect(share).toBeLessThanOrEqual(defaultRankPolicy.maxNewNodeShare + 0.001);
    expect(newcomers.every((item) => item.weight < defaultRankPolicy.newNodeWeightCap)).toBe(true);
  });

  test("websocket urls stay listed and out of the HTTP pool", () => {
    const [ranked] = rankRegistry(
      [endpoint("wss://socket.example/evm", "websocket")],
      [observation("wss://socket.example/evm", 0, 20)],
      NOW,
    );
    expect(ranked?.eligible).toBe(false);
    expect(ranked?.weight).toBe(0);
    expect(ranked?.stats).toBeNull();
  });

  test("observations outside the window are ignored", () => {
    const url = "https://old.example/evm";
    const [ranked] = rankRegistry([endpoint(url)], [observation(url, 40, 20)], NOW);
    expect(ranked?.stats?.observations).toBe(0);
    expect(ranked?.eligible).toBe(false);
  });
});

describe("mergeEndpointInputs", () => {
  test("keeps community submissions and drops upstream urls that disappeared", () => {
    const previous: RegistryEndpointInput[] = [
      {
        ...endpoint("https://gone.example/evm"),
        addedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        ...endpoint("https://community.example/evm"),
        submission: "community",
        sources: [{ name: "community", url: "https://example.test/pr/1" }],
        addedAt: "2026-02-01T00:00:00.000Z",
      },
    ];
    const fetched: RegistryEndpointInput[] = [
      {
        ...endpoint("https://community.example/evm"),
        tracking: "none",
        sources: [{ name: "chainlist", url: "https://example.test/chain" }],
        addedAt: "",
      },
      {
        ...endpoint("https://fresh.example/evm"),
        addedAt: "",
      },
    ];
    const merged = mergeEndpointInputs(fetched, previous, "2026-10-30T00:00:00.000Z");
    const urls = merged.map((item) => item.url);
    expect(urls).not.toContain("https://gone.example/evm");
    expect(urls).toContain("https://community.example/evm");
    expect(urls).toContain("https://fresh.example/evm");
    const community = merged.find((item) => item.url === "https://community.example/evm");
    expect(community?.submission).toBe("community");
    expect(community?.addedAt).toBe("2026-02-01T00:00:00.000Z");
    expect(community?.sources.map((source) => source.name).sort()).toEqual(["chainlist", "community"]);
    expect(merged.find((item) => item.url === "https://fresh.example/evm")?.addedAt).toBe("2026-10-30T00:00:00.000Z");
  });
});
