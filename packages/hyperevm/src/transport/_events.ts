/**
 * Telemetry events emitted for each routed call.
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
      /** False when this head is ignored as implausible, or no reference head is believed yet. */
      trusted: boolean;
    };

/** One endpoint as the transport currently scores it. */
export interface EndpointSnapshot {
  id: string;
  url: string;
  weight: number;
  inflight: number;
  head: number | null;
  lag: number | null;
  score: number;
  methods: Record<string, { ewma: number; tail: number; error: number; n: number }>;
}
