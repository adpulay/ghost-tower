import { test } from 'node:test';
import assert from 'node:assert/strict';
import { phonesWarned, worldClock } from './metrics.ts';

test('phonesWarned does not count re-plans and duplicate alerts twice', () => {
  const alerts = [
    { track_id: 1, recipients: 40 },
    { track_id: 1, recipients: 40 },
    { track_id: 1, recipients: 55 },
    { track_id: 2, recipients: 10 },
  ];
  assert.equal(phonesWarned(alerts), 65);
  assert.equal(phonesWarned([]), 0);
});

test('worldClock follows a sped-up simulator but never runs behind the wall clock', () => {
  assert.equal(worldClock([{ ts_ms: 5_000 }, { ts_ms: 9_000 }], 7_000), 9_000);
  assert.equal(worldClock([{ ts_ms: 5_000 }], 7_000), 7_000);
  assert.equal(worldClock([], 7_000), 7_000);
});
