import { describe, expect, test } from "bun:test";

import { assignLags } from "../scripts/probe.ts";
import type { ProbeObservation } from "../src/policy.ts";

function observation(url: string, head: number, headAt: string): ProbeObservation {
  return {
    at: headAt,
    url,
    ok: true,
    chainIdOk: true,
    head,
    lag: null,
    headAt,
    methods: { eth_blockNumber: { ms: 10, ok: true } },
  };
}

describe("assignLags", () => {
  test("projects an earlier head forward by one block per second", () => {
    const early = observation("https://early.example/evm", 1000, "2026-10-30T00:00:00.000Z");
    const late = observation("https://late.example/evm", 1004, "2026-10-30T00:00:04.000Z");
    const [first, second] = assignLags([early, late]);
    expect(first?.lag).toBe(0);
    expect(second?.lag).toBe(0);
  });

  test("keeps a real gap after the time adjustment", () => {
    const stale = observation("https://stale.example/evm", 1000, "2026-10-30T00:00:00.000Z");
    const tip = observation("https://tip.example/evm", 1010, "2026-10-30T00:00:03.000Z");
    const [first, second] = assignLags([stale, tip]);
    expect(first?.lag).toBe(7);
    expect(second?.lag).toBe(0);
  });

  test("ignores a head from the wrong chain", () => {
    const wrong: ProbeObservation = {
      ...observation("https://wrong.example/evm", 5000, "2026-10-30T00:00:05.000Z"),
      chainIdOk: false,
      ok: false,
    };
    const right = observation("https://right.example/evm", 1000, "2026-10-30T00:00:00.000Z");
    const [first, second] = assignLags([wrong, right]);
    expect(first?.lag).toBeNull();
    expect(second?.lag).toBe(0);
  });
});
