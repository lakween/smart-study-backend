import assert from 'node:assert/strict';
import test from 'node:test';
import { Request, Response } from 'express';
import { ApiError } from '../utils/asyncHandler';
import { clearRateLimitBucketsForTests, rateLimit } from './rateLimit.middleware';

test('rate limiter rejects requests after the configured maximum', () => {
  clearRateLimitBucketsForTests();
  const middleware = rateLimit({ windowMs: 60_000, maxRequests: 1, scope: 'test' });
  const req = { ip: '127.0.0.1', socket: {} } as Request;
  const headers = new Map<string, unknown>();
  const res = { setHeader: (name: string, value: unknown) => headers.set(name, value) } as unknown as Response;
  const errors: unknown[] = [];

  middleware(req, res, (error?: unknown) => errors.push(error));
  middleware(req, res, (error?: unknown) => errors.push(error));

  assert.equal(errors[0], undefined);
  assert.ok(errors[1] instanceof ApiError);
  assert.equal((errors[1] as ApiError).status, 429);
  assert.equal(headers.get('x-ratelimit-remaining'), 0);
});

