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
      /**
       * True when the error describes the call (revert, invalid params, rejected
       * transaction). The endpoint answered, so its score and circuit treat it as healthy.
       */
      terminal?: boolean | undefined;
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
      /** Consecutive failures or a `Retry-After` took the endpoint out of rotation. */
      type: "eject";
      endpoint: string;
      failures: number;
      cooldownMs: number;
      error: Error;
    }
  | {
      /** A healthy answer closed an ejected endpoint's circuit. */
      type: "restore";
      endpoint: string;
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
