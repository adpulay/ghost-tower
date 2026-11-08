import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadScenario } from '../../sim/src/scenario.ts';
import { corridor, runLocal } from '../src/local_run.ts';
import { pointInPolygon, quantile, score } from '../src/metrics.ts';

test('quantile + point in polygon', () => {
  assert.equal(quantile([3, 1, 2], 0.5), 2);
  assert.equal(quantile([], 0.5), null);
  const sq: [number, number][] = [[0, 0], [0, 1], [1, 1], [1, 0]];
  assert.ok(pointInPolygon(0.5, 0.5, sq));
  assert.ok(!pointInPolygon(1.5, 0.5, sq));
  const c = corridor(32.98, -96.78, 90, 11);
  assert.ok(pointInPolygon(32.98, -96.77, c), 'ahead is inside');
  assert.ok(!pointInPolygon(32.98, -96.80, c), 'well behind is outside');
});

test('end to end, in process: demo-01 meets its pass conditions', async () => {
  const m = score(await runLocal(loadScenario('demo-01'), { mockAlerts: true }));
  assert.equal(m.activeTracks, 1);
  assert.equal(m.falseActiveTracks, 0);
  assert.ok(m.timeToFirstAlertS !== null && m.timeToFirstAlertS < 30, `first alert ${m.timeToFirstAlertS}`);
  assert.ok(m.errMedianM !== null && m.errMedianM < 400, `median error ${m.errMedianM}`);
  assert.ok(m.eventRecall! > 0.9 && m.eventPrecision! > 0.9);
});

test('end to end, in process: benign-only produces zero active tracks', async () => {
  for (const id of ['benign-01', 'benign-02', 'border-01']) {
    const m = score(await runLocal(loadScenario(id)));
    assert.equal(m.activeTracks, 0, id);
  }
});

test('end to end, in process: twin-01 is two tracks, never merged', async () => {
  const m = score(await runLocal(loadScenario('twin-01')));
  assert.equal(m.activeTracks, 2);
  assert.equal(m.falseActiveTracks, 0);
});
