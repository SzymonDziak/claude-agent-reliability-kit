import type { Claim } from "./schema.ts";

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; headers?: Headers }>;

export class DeliveryError extends Error {
  constructor(public status: number, public headers?: Headers) { super(`webhook responded ${status}`); }
}

/**
 * POST a validated row to the downstream webhook (e.g. n8n). The Idempotency-Key header lets the receiver
 * de-duplicate if we retry after a timeout. 5xx/429 surface as DeliveryError{status}, which the worker retries.
 */
export async function deliver(url: string, key: string, claim: Claim, fetchImpl: Fetch = fetch as unknown as Fetch) {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify({ idempotency_key: key, ...claim }),
  });
  if (!res.ok) throw new DeliveryError(res.status, res.headers);
}
