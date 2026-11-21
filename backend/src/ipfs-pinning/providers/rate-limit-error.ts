/**
 * Thrown by an HTTP-backed pinning provider when the API responds with HTTP 429
 * (Too Many Requests). Carries the `retryAfter` value (seconds) from the
 * `Retry-After` response header when the provider includes one, so callers can
 * honour it on the final attempt or surface it in logs.
 *
 * The failover logic in `IpfsPinningService` treats this the same as any other
 * provider error — the provider fails and the next one in the priority chain is
 * tried. The dedicated error class simply makes the 429 distinguishable from a
 * generic 5xx or network failure so logs and metrics can tell them apart (#876).
 */
export class RateLimitError extends Error {
  /** Seconds the provider asked us to wait, parsed from the `Retry-After` header. */
  readonly retryAfter?: number;

  constructor(provider: string, retryAfter?: number) {
    const suffix = retryAfter ? ` (Retry-After: ${retryAfter}s)` : '';
    super(`${provider} returned 429 Too Many Requests${suffix}`);
    this.name = 'RateLimitError';
    this.retryAfter = retryAfter;
  }
}
