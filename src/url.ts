/**
 * Canonical public RPC URLs. Query strings and credentials are rejected so a
 * contributed endpoint cannot smuggle an API key into the registry.
 * @module
 */

/** Result of checking one URL before it enters the registry or the transport. */
export interface NormalizedRpcUrl {
  url: string;
  kind: "http" | "websocket";
}

/** Normalize `url` or throw when it is not a public http(s) or ws(s) endpoint. */
export function normalizeRpcUrl(url: string): NormalizedRpcUrl {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw new Error(`Invalid RPC URL: ${url}`);
  }
  const websocket = parsed.protocol === "wss:" || parsed.protocol === "ws:";
  const http = parsed.protocol === "https:" || parsed.protocol === "http:";
  if (!websocket && !http) {
    throw new Error(`RPC URL must be http(s) or ws(s): ${url}`);
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error(`RPC URL must not include credentials: ${parsed.host}`);
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new Error(`RPC URL must not include a query or hash: ${parsed.host}`);
  }
  parsed.hostname = parsed.hostname.toLowerCase();
  parsed.hash = "";
  parsed.search = "";
  if (parsed.pathname.length > 1 && parsed.pathname.endsWith("/")) {
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  }
  return {
    url: parsed.toString(),
    kind: websocket ? "websocket" : "http",
  };
}
