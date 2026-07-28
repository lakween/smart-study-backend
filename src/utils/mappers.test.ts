import assert from 'node:assert/strict';
import test from 'node:test';
import { visibilityFromDb, visibilityToDb, studyLevelFromDb, studyLevelToDb } from './mappers';

test('visibility values round-trip between API and database formats', () => {
  for (const value of ['private', 'friendsOnly', 'public'] as const) {
    assert.equal(visibilityFromDb(visibilityToDb(value)), value);
  }
});

test('study level values round-trip between API and database formats', () => {
  for (const value of ['school', 'undergraduate', 'postgraduate', 'selfLearner'] as const) {
    assert.equal(studyLevelFromDb(studyLevelToDb(value)), value);
  }
});

