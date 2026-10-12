/** Classify API failures and compute backoff. Works with SDK APIError (has .status / .headers) and plain test doubles. */
export const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

export function errorStatus(err: unknown): number | undefined {
  const s = (err as { status?: unknown })?.status;
  return typeof s === "number" ? s : undefined;
}

/** Network-level failures (no HTTP status) are retryable too. */
export function isRetryable(err: unknown): boolean {
  const s = errorStatus(err);
  if (s !== undefined) return RETRYABLE_STATUS.has(s);
  const name = (err as { name?: string })?.name ?? "";
  return /APIConnection|Timeout|FetchError/i.test(name) || /ECONNRESET|ETIMEDOUT|fetch failed/i.test(String((err as Error)?.message));
}

/** retry-after header in seconds (or HTTP date) -> ms. */
export function retryAfterMs(err: unknown, now = Date.now()): number | undefined {
  const h = (err as { headers?: unknown })?.headers;
  const v = h instanceof Headers ? h.get("retry-after") : (h as Record<string, string> | undefined)?.["retry-after"];
  if (!v) return undefined;
  const secs = Number(v);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(v);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

export interface BackoffOptions { baseMs?: number; capMs?: number; rng?: () => number }

/** Exponential backoff with "equal jitter"; never earlier than the server's retry-after. */
export function backoffMs(attempt: number, err: unknown, { baseMs = 1000, capMs = 60_000, rng = Math.random }: BackoffOptions = {}): number {
  const exp = Math.min(capMs, baseMs * 2 ** (attempt - 1));
  const jittered = exp / 2 + rng() * (exp / 2);
  return Math.max(jittered, retryAfterMs(err) ?? 0);
}
