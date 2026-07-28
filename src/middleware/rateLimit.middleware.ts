import { NextFunction, Request, Response } from 'express';
import { ApiError } from '../utils/asyncHandler';

type RateLimitOptions = {
  windowMs: number;
  maxRequests: number;
  scope: string;
};

type Bucket = { count: number; resetsAt: number };
const buckets = new Map<string, Bucket>();

// Avoid retaining inactive clients forever in a long-running process.
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetsAt <= now) buckets.delete(key);
  }
}, 60_000);
cleanupTimer.unref();

export function rateLimit(options: RateLimitOptions) {
  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const client = req.ip || req.socket.remoteAddress || 'unknown';
    const key = `${options.scope}:${client}`;
    let bucket = buckets.get(key);

    if (!bucket || bucket.resetsAt <= now) {
      bucket = { count: 0, resetsAt: now + options.windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;
    const remaining = Math.max(0, options.maxRequests - bucket.count);
    res.setHeader('x-ratelimit-limit', options.maxRequests);
    res.setHeader('x-ratelimit-remaining', remaining);
    res.setHeader('x-ratelimit-reset', Math.ceil(bucket.resetsAt / 1000));

    if (bucket.count > options.maxRequests) {
      res.setHeader('retry-after', Math.ceil((bucket.resetsAt - now) / 1000));
      return next(new ApiError(429, 'Too many requests. Please try again shortly.'));
    }

    next();
  };
}

export function clearRateLimitBucketsForTests() {
  buckets.clear();
}

