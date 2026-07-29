import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { ApiError } from '../utils/asyncHandler';
import { publicErrorFor } from './error.middleware';

test('operational API errors preserve their safe message', () => {
  assert.deepEqual(publicErrorFor(new ApiError(404, 'Quiz not found')), {
    status: 404,
    body: { error: 'Quiz not found' },
  });
});

test('validation errors are useful without exposing internals', () => {
  const result = z.object({ title: z.string().min(1) }).safeParse({ title: '' });
  assert.equal(result.success, false);
  if (result.success) return;
  const publicError = publicErrorFor(result.error);
  assert.equal(publicError.status, 400);
  assert.equal(publicError.body.error, 'Invalid request data');
  assert.equal(publicError.body.details?.[0].path, 'title');
});

test('unknown errors never expose their message', () => {
  assert.deepEqual(publicErrorFor(new Error('database host and password')), {
    status: 500,
    body: { error: 'Internal server error' },
  });
});

