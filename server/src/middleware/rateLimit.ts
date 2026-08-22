import type { Request, Response, NextFunction } from "express";
import Redis from "ioredis";
import { logger } from "../utils/logger";

// Fixed-window rate limiter backed by Redis (falls back to in-memory if Redis
// is unavailable). Key design points for interviews:
//
//   - Per-route / per-key limits (auth vs ingestion vs public status)
//   - Atomic INCR + EXPIRE so concurrent requests don't race
//   - Returns standard 429 + Retry-After so clients can back off
//   - Fails open if Redis is down — rate limiting must not take down the API

let redis: Redis | null = null;
const memoryBuckets = new Map<string, { count: number; resetAt: number }>();

function getRedis(): Redis | null {
  if (redis) return redis;
  try {
    const url = process.env.REDIS_URL || "redis://localhost:6379";
    redis = new Redis(url, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: true,
      connectTimeout: 1500,
    });
    redis.on("error", (err) => {
      logger.warn({ err: err.message }, "rate-limit redis error — falling back to memory");
    });
    // Fire-and-forget connect; callers handle failure via try/catch on commands.
    void redis.connect().catch(() => {
      /* fall back to memory */
    });
    return redis;
  } catch {
    return null;
  }
}

export interface RateLimitOptions {
  /** Window length in milliseconds */
  windowMs: number;
  /** Max requests per window per key */
  max: number;
  /** Redis / memory key prefix */
  keyPrefix: string;
  /** How to derive the rate-limit key from the request (default: IP) */
  keyFn?: (req: Request) => string;
  /** Optional message body for 429 responses */
  message?: string;
}

export function rateLimit(opts: RateLimitOptions) {
  const {
    windowMs,
    max,
    keyPrefix,
    keyFn = (req) => req.ip || req.socket.remoteAddress || "unknown",
    message = "Too many requests, please try again later",
  } = opts;

  const windowSec = Math.ceil(windowMs / 1000);

  return async (req: Request, res: Response, next: NextFunction) => {
    const id = keyFn(req);
    const key = `rl:${keyPrefix}:${id}`;

    try {
      const client = getRedis();
      if (client && client.status === "ready") {
        const count = await client.incr(key);
        if (count === 1) {
          await client.expire(key, windowSec);
        }
        const ttl = await client.ttl(key);
        res.setHeader("X-RateLimit-Limit", String(max));
        res.setHeader("X-RateLimit-Remaining", String(Math.max(0, max - count)));
        res.setHeader("X-RateLimit-Reset", String(Math.ceil(Date.now() / 1000) + Math.max(ttl, 0)));

        if (count > max) {
          res.setHeader("Retry-After", String(Math.max(ttl, 1)));
          return res.status(429).json({ error: message });
        }
        return next();
      }
    } catch {
      // Fall through to in-memory
    }

    // In-memory fallback (single-process only — fine for local/dev demos).
    const now = Date.now();
    let bucket = memoryBuckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      memoryBuckets.set(key, bucket);
    }
    bucket.count += 1;
    res.setHeader("X-RateLimit-Limit", String(max));
    res.setHeader("X-RateLimit-Remaining", String(Math.max(0, max - bucket.count)));
    res.setHeader("X-RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));

    if (bucket.count > max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader("Retry-After", String(Math.max(retryAfter, 1)));
      return res.status(429).json({ error: message });
    }
    return next();
  };
}

/** Strict limit for auth endpoints (brute-force protection). */
export const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyPrefix: "auth",
  message: "Too many auth attempts, please try again in a few minutes",
});

/** Higher throughput for incident ingestion (monitoring systems retry). */
export const ingestionRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  keyPrefix: "ingest",
  message: "Incident ingestion rate limit exceeded",
});

/** Public status page — unauthenticated, so tighter. */
export const publicStatusRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  keyPrefix: "public-status",
  message: "Status page rate limit exceeded",
});
