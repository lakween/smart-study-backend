import assert from 'node:assert/strict';
import test from 'node:test';
import { computeNextRevision } from './spacedRepetition';

test('a failed revision returns to one day', () => {
  assert.equal(computeNextRevision(14, 59).intervalDays, 1);
});

test('passing revisions advance through the interval ladder', () => {
  assert.equal(computeNextRevision(null, 60).intervalDays, 1);
  assert.equal(computeNextRevision(1, 80).intervalDays, 3);
  assert.equal(computeNextRevision(3, 80).intervalDays, 7);
  assert.equal(computeNextRevision(30, 100).intervalDays, 30);
});

