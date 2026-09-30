import { describe, expect, it } from "vitest";
import { DEFAULT_RATE_LIMIT, RateLimiter, rateLimitFromEnv } from "../src/ratelimit.js";

/** A limiter on a hand-driven clock: `advance(ms)` moves time forward. */
function limiterAt(limit: number, start = 1_000_000) {
  let now = start;
  const limiter = new RateLimiter(limit, 60_000, () => now);
  return { limiter, advance: (ms: number) => (now += ms) };
}

describe("RateLimiter", () => {
  it("allows `limit` hits in a window and refuses the next one", () => {
    const { limiter } = limiterAt(3);
    for (let i = 0; i < 3; i++) expect(limiter.hit("1.1.1.1").allowed).toBe(true);
    const refused = limiter.hit("1.1.1.1");
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBe(60);
  });

  it("counts each key separately", () => {
    const { limiter } = limiterAt(2);
    limiter.hit("1.1.1.1");
    limiter.hit("1.1.1.1");
    expect(limiter.hit("1.1.1.1").allowed).toBe(false);
    expect(limiter.hit("2.2.2.2").allowed).toBe(true);
  });

  it("slides: Retry-After counts down to when the oldest hit leaves the window", () => {
    const { limiter, advance } = limiterAt(2);
    limiter.hit("ip");
    advance(20_000);
    limiter.hit("ip");
    advance(10_500);
    expect(limiter.hit("ip").retryAfterSeconds).toBe(30); // 29.5 s rounded up
    advance(29_500);
    expect(limiter.hit("ip").allowed).toBe(true); // the first hit is now a minute old
    expect(limiter.hit("ip").allowed).toBe(false);
  });

  it("does not count refused hits against the client", () => {
    const { limiter, advance } = limiterAt(1);
    limiter.hit("ip");
    advance(30_000);
    limiter.hit("ip"); // refused, must not extend the window
    advance(30_000);
    expect(limiter.hit("ip").allowed).toBe(true);
  });

  it("forgets clients whose hits have all expired", () => {
    const { limiter, advance } = limiterAt(5);
    limiter.hit("a");
    limiter.hit("b");
    advance(60_000);
    limiter.hit("c");
    expect(limiter.size).toBe(1);
  });

  it("rejects a limit that is not a positive integer", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => new RateLimiter(bad), `limit=${bad}`).toThrow(/positive integer/);
    }
  });
});

describe("rateLimitFromEnv", () => {
  it("defaults to 10 when LINKR_RATE_LIMIT is unset or blank", () => {
    expect(DEFAULT_RATE_LIMIT).toBe(10);
    expect(rateLimitFromEnv({})).toBe(10);
    expect(rateLimitFromEnv({ LINKR_RATE_LIMIT: " " })).toBe(10);
  });

  it("reads a positive integer", () => {
    expect(rateLimitFromEnv({ LINKR_RATE_LIMIT: "25" })).toBe(25);
  });

  it("throws on anything else", () => {
    for (const bad of ["0", "-3", "2.5", "ten"]) {
      expect(() => rateLimitFromEnv({ LINKR_RATE_LIMIT: bad }), bad).toThrow(/LINKR_RATE_LIMIT/);
    }
  });
});
