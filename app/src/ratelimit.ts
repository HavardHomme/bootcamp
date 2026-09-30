/** How many `POST /links` one client may send per minute unless LINKR_RATE_LIMIT says otherwise. */
export const DEFAULT_RATE_LIMIT = 10;

export interface RateLimitResult {
  allowed: boolean;
  /** Whole seconds until the next hit would be allowed; 0 when this one was. */
  retryAfterSeconds: number;
}

/**
 * A sliding-window limiter: at most `limit` hits per key in any `windowMs` span.
 * Held in memory, so it resets on restart and is per process. Refused hits are not counted.
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private lastSweep: number;

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`rate limit must be a positive integer, got ${limit}`);
    }
    this.lastSweep = now();
  }

  /** Record a hit for `key` if it is under the limit, and say whether it was. */
  hit(key: string): RateLimitResult {
    const now = this.now();
    this.sweep(now);
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      const oldest = recent[0] ?? now;
      return {
        allowed: false,
        retryAfterSeconds: Math.ceil((oldest + this.windowMs - now) / 1000),
      };
    }
    recent.push(now);
    this.hits.set(key, recent);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  /** How many clients are being tracked. */
  get size(): number {
    return this.hits.size;
  }

  /** Drop clients with no hit inside the window, at most once per window, so the map cannot grow without bound. */
  private sweep(now: number): void {
    if (now - this.lastSweep < this.windowMs) return;
    this.lastSweep = now;
    for (const [key, times] of this.hits) {
      const newest = times[times.length - 1];
      if (newest === undefined || now - newest >= this.windowMs) this.hits.delete(key);
    }
  }
}

/** Read the limit from LINKR_RATE_LIMIT, falling back to the default; throw on a value that is not a positive integer. */
export function rateLimitFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.LINKR_RATE_LIMIT;
  if (raw === undefined || raw.trim() === "") return DEFAULT_RATE_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`LINKR_RATE_LIMIT must be a positive integer, got "${raw}"`);
  }
  return n;
}
