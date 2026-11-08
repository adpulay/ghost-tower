import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversine } from '../../spacetime/src/geo.ts';
import { distanceAt, Polyline } from '../src/route.ts';
import { listScenarios, loadRoute, loadScenario } from '../src/scenario.ts';
import { SimWorld, urlHash } from '../src/world.ts';

test('same seed = same run; different seed = different run', () => {
  const s = loadScenario('demo-01');
  const run = (suffix?: string) => {
    const out: string[] = [];
    for (const t of new SimWorld(s, { seedSuffix: suffix }).ticks()) {
      if (t.tS > 120) break;
      for (const e of t.events) out.push(`${e.args.ts_ms}:${e.args.lat}:${e.args.lon}:${e.kind}:${e.args.sms_score.toFixed(4)}`);
    }
    return out.join('|');
  };
  assert.equal(run(), run());
  assert.notEqual(run(), run('/r2'));
});

test('every scenario loads and its routes exist', () => {
  const ids = listScenarios();
  assert.equal(ids.length, 10);
  for (const id of ids) {
    const s = loadScenario(id);
    for (const b of s.blasters) assert.ok(loadRoute(b.route).points.length > 1, `${id}: ${b.route}`);
  }
});

test('demo route is the real road: Campbell Rd east, then north on Coit Rd', () => {
  const r = loadRoute('routes/demo.json');
  assert.deepEqual(r.roads, ['Campbell Road', 'North Coit Road', 'Coit Road']);
  const [first, last] = [r.points[0], r.points.at(-1)!];
  assert.ok(last[0] > first[0] + 0.02, 'ends north');
  assert.ok(last[1] > first[1] + 0.02, 'ends east');
});

test('blaster motion: speed and stops', () => {
  assert.equal(distanceAt(10, 11), 110);
  const stops = [{ at_m: 100, dur_s: 60 }];
  assert.equal(distanceAt(5, 10, stops), 50);
  assert.equal(distanceAt(30, 10, stops), 100, 'parked');
  assert.equal(distanceAt(75, 10, stops), 150, 'moving again after 10 + 60 s');
  const line = new Polyline([[32.97, -96.79], [32.97, -96.78]]);
  const mid = line.at(line.length / 2);
  assert.ok(Math.abs(mid.lon + 96.785) < 1e-9);
  assert.deepEqual(line.at(1e9), line.pts[1]);
});

test('blaster hits only phones in range, once per 60 s, and reports are coarsened + delayed', () => {
  const s = loadScenario('walker-01');
  const w = new SimWorld(s);
  const seen = new Map<number, number[]>();
  for (const t of w.ticks()) {
    for (const e of t.events) {
      assert.equal(e.args.lat, Math.round(e.args.lat * 1000) / 1000, 'coarsened');
      const hitMs = Number(e.args.ts_ms);
      assert.ok(t.tsMs - hitMs >= 1000, 'delivered after the hit');
      if (e.kind !== 'blaster') continue;
      assert.equal(e.args.smsc_match, 'no');
      assert.equal(e.args.url_hash, urlHash('txtag-pay-demo.example'));
      const truth = w.movers[0].at((hitMs - w.t0Ms) / 1000);
      const p = w.phones[e.phone];
      assert.ok(haversine(p.lat, p.lon, truth.lat, truth.lon) <= s.blasters[0].range_m + 1e-6, 'in range');
      seen.set(e.phone, [...(seen.get(e.phone) ?? []), hitMs]);
    }
  }
  assert.ok(seen.size > 10);
  for (const hits of seen.values()) {
    hits.sort((a, b) => a - b);
    for (let i = 1; i < hits.length; i++) assert.ok(hits[i] - hits[i - 1] >= 60_000);
  }
});

test('url_hash normalizes the link domain', () => {
  const h = urlHash('txtag-pay-demo.example');
  assert.equal(urlHash('HTTPS://www.TxTag-Pay-Demo.example:443/pay?id=1'), h);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.notEqual(urlHash('txtag.org'), h);
});
