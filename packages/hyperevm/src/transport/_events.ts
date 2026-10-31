/**
 * Telemetry events emitted for each routed call.
 * Every `endpoint`, `from`, and `to` is the endpoint's public label, never a URL that may hold a key.
 * @module
 */

/** A listener receives one of these for every routing decision it asked to see. */
export type HyperevmEvent =
  | {
      type: "request";
      endpoint: string;
      method: string;
    }
  | {
      type: "success";
      endpoint: string;
      method: string;
      latencyMs: number;
      hedged: boolean;
    }
  | {
      type: "error";
      endpoint: string;
      method: string;
      latencyMs: number;
      error: Error;
    }
  | {
      type: "failover";
      from: string;
      to: string;
      method: string;
    }
  | {
      type: "hedge";
      endpoint: string;
      method: string;
    }
  | {
      type: "head";
      endpoint: string;
      head: number;
      best: number;
      lag: number;
    }
  | {
      /** `eth_chainId` disagreed with the client chain. The endpoint gets no more calls. */
      type: "quarantine";
      endpoint: string;
      chainId: number;
      expected: number;
    };

/** One endpoint as the transport currently scores it. */
export interface EndpointSnapshot {
  /** Public label. Same as `url`. */
  id: string;
  /** Public label: the endpoint's `label`, a registry URL, or `scheme://host[:port]`. Never a key-bearing URL. */
  url: string;
  weight: number;
  /** True once `eth_chainId` reported another chain. */
  quarantined: boolean;
  inflight: number;
  head: number | null;
  lag: number | null;
  score: number;
  methods: Record<string, { ewma: number; tail: number; error: number; n: number }>;
}
