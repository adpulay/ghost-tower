import { test } from 'node:test';
import assert from 'node:assert/strict';
import { etaRemaining, formatEta, parsePath, pickTarget, statusLine, type TrackRow } from './patrolModel.ts';

const tr = (id: bigint, status: string, confidence: number): TrackRow => ({
  id, lat: 32.98, lon: -96.77, heading_deg: 0, speed_mps: 11, confidence, status, updated_ms: 0n,
});

test('follows the most confident active track unless the officer picked one', () => {
  const tracks = [tr(1n, 'active', 0.85), tr(2n, 'active', 0.95), tr(3n, 'candidate', 1)];
  assert.equal(pickTarget(tracks, null)?.id, 2n);
  assert.equal(pickTarget(tracks, 1n)?.id, 1n);
  assert.equal(pickTarget(tracks, 3n)?.id, 2n, 'candidates are not targets');
  assert.equal(pickTarget([tr(4n, 'dormant', 1)], null), undefined);
});

test('status line: latest replan wins, else a plain description', () => {
  const t = tr(1n, 'active', 0.9);
  const traces = [
    { id: 1n, track_id: 1n, ts_ms: 10n, kind: 'replan', text: 'old' },
    { id: 2n, track_id: 1n, ts_ms: 20n, kind: 'replan', text: 'Target turned north on Coit Rd. Intercept at Coit & Frankford, ~3 min.' },
    { id: 3n, track_id: 1n, ts_ms: 30n, kind: 'tool_call', text: 'predict_route(...)' },
    { id: 4n, track_id: 9n, ts_ms: 40n, kind: 'replan', text: 'other track' },
  ];
  assert.match(statusLine(t, traces, undefined, 0), /^Target turned north on Coit Rd/);
  const p = { track_id: 1n, path_json: '[]', intercept_lat: 0, intercept_lon: 0, eta_s: 180, updated_ms: 0n };
  assert.equal(statusLine(t, [], p, 0), 'Target heading north at ~40 km/h. Intercept in ~3 min.');
  assert.equal(statusLine(undefined, [], undefined, 0), 'No active target. Stand by.');
});

test('ETA counts down from the prediction write time', () => {
  const p = { track_id: 1n, path_json: '[[1,2],[3,"x"],[5,6]]', intercept_lat: 0, intercept_lon: 0, eta_s: 125, updated_ms: 1_000n };
  assert.equal(etaRemaining(p, 1_000), 125);
  assert.equal(etaRemaining(p, 61_000), 65);
  assert.equal(etaRemaining(p, 999_000), 0);
  assert.equal(formatEta(65), '1:05');
  assert.equal(formatEta(9), '9s');
  assert.equal(formatEta(0), 'now');
  assert.deepEqual(parsePath(p.path_json), [[1, 2], [5, 6]]);
  assert.deepEqual(parsePath('nope'), []);
});
