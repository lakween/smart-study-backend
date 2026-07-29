import assert from 'node:assert/strict';
import test from 'node:test';

import { calculateExamScore, canReleaseSolutions, effectiveExamStatus, examDeadline } from './exam.service';

test('exam deadline never exceeds the shared close time', () => {
  const startedAt = new Date('2026-07-29T10:00:00.000Z');
  const closesAt = new Date('2026-07-29T10:20:00.000Z');
  assert.equal(examDeadline(startedAt, 30, closesAt).toISOString(), closesAt.toISOString());
});

test('exam lifecycle is derived from authoritative timestamps', () => {
  const start = new Date('2026-07-29T10:00:00.000Z');
  const close = new Date('2026-07-29T11:00:00.000Z');
  assert.equal(effectiveExamStatus('SCHEDULED', start, close, new Date('2026-07-29T09:59:00.000Z')), 'SCHEDULED');
  assert.equal(effectiveExamStatus('SCHEDULED', start, close, new Date('2026-07-29T10:01:00.000Z')), 'STARTED');
  assert.equal(effectiveExamStatus('STARTED', start, close, new Date('2026-07-29T11:01:00.000Z')), 'COMPLETED');
});

test('exam scoring treats missing answers as incorrect', () => {
  const result = calculateExamScore(
    [
      { id: 'q1', correctAnswer: 'A' },
      { id: 'q2', correctAnswer: 'B' },
    ],
    [{ questionId: 'q1', selectedAnswer: 'A' }]
  );
  assert.deepEqual(result, { correctCount: 1, totalQuestions: 2, scorePercent: 50 });
});

test('friend exam solutions stay hidden until the exam completes', () => {
  assert.equal(
    canReleaseSolutions({
      examType: 'FRIEND_EXAM',
      releasePolicy: 'AFTER_CLOSE',
      examStatus: 'STARTED',
      attemptSubmitted: true,
    }),
    false
  );
  assert.equal(
    canReleaseSolutions({
      examType: 'FRIEND_EXAM',
      releasePolicy: 'AFTER_CLOSE',
      examStatus: 'COMPLETED',
      attemptSubmitted: true,
    }),
    true
  );
});
