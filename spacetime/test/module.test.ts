// TESTING.md §2a: Spacetime reducers. Runs the real module in-process (see harness.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalWorld } from './harness.ts';
import { DEFAULT_WEIGHTS, fusionScore } from '../src/fusion.ts';
import { haversine, offset } from '../src/geo.ts';

const T0 = 1_762_548_000_000;
const ORIGIN = { lat: 32.9785, lon: -96.78 };

function report(w: LocalWorld, o: Partial<Parameters<LocalWorld['call']>[1] & object> & { ts_ms: bigint; lat: number; lon: number }) {
  w.call('report_anomaly', {
    rat_drop: true, rat_drop_secs: 8, sms_score: 0.97, url_hash: 'h1', brand: 'TxTag', smsc_match: 'no', source: 'sim',
    ...o,
  } as any);
}

test('fusion score matches INTERFACES §4 for four hand-made payloads', () => {
  const cases = [
    // full blaster signature: 0.45 + 0.35*0.97 + 0.20
    { in: { rat_drop: true, rat_drop_secs: 8.2, sms_score: 0.97, smsc_match: 'no' }, want: 0.45 + 0.3395 + 0.2 },
    // 2G drop too long (> 30 s) is ignored; unknown smsc gives half
    { in: { rat_drop: true, rat_drop_secs: 45, sms_score: 0.5, smsc_match: 'unknown' }, want: 0.175 + 0.1 },
    // real toll text via the normal network
    { in: { rat_drop: false, rat_drop_secs: 0, sms_score: 0.8, smsc_match: 'yes' }, want: 0.28 },
    // 2G drop, no SMS at all
    { in: { rat_drop: true, rat_drop_secs: 30, sms_score: 0, smsc_match: 'unknown' }, want: 0.55 },
  ];
  const w = new LocalWorld(T0);
  cases.forEach((c, i) => {
    assert.ok(Math.abs(fusionScore(c.in) - c.want) < 1e-9, `pure case ${i}`);
    w.call('report_anomaly', { ts_ms: BigInt(T0 + i), lat: 32.98, lon: -96.75, url_hash: '', brand: '', source: 'phone', ...c.in });
  });
  const rows = w.rows('anomaly_event').sort((a, b) => Number(a.ts_ms - b.ts_ms));
  rows.forEach((r, i) => assert.ok(Math.abs(r.fusion_score - cases[i].want) < 1e-6, `stored case ${i}: ${r.fusion_score}`));
});

test('report_anomaly coarsens position server-side and normalizes inputs', () => {
  const w = new LocalWorld(T0);
  w.call('report_anomaly', {
    ts_ms: BigInt(T0), lat: 32.986_44, lon: -96.750_61, rat_drop: true, rat_drop_secs: 8, sms_score: 7,
    url_hash: 'x', brand: 'TxTag', smsc_match: 'NO', source: 'phone',
  });
  const [r] = w.rows('anomaly_event');
  assert.equal(r.lat, 32.986);
  assert.equal(r.lon, -96.751);
  assert.equal(r.sms_score, 1);
  assert.equal(r.smsc_match, 'no');
  assert.equal(r.track_id, 0n);
  assert.throws(() => report(w, { ts_ms: BigInt(T0), lat: 200, lon: 0 }));
});

/** A blaster parked at `at`, hitting `n` phones scattered within ~400 m, one every `everyMs`. */
function burst(w: LocalWorld, at: { lat: number; lon: number }, startMs: number, n: number, everyMs = 1000, hash = 'h1') {
  for (let i = 0; i < n; i++) {
    const ang = (i * 137.5 * Math.PI) / 180;
    const r = 100 + ((i * 53) % 300);
    const p = offset(at, Math.sin(ang) * r, Math.cos(ang) * r);
    report(w, { ts_ms: BigInt(startMs + i * everyMs), lat: p.lat, lon: p.lon, url_hash: hash });
  }
}

test('recluster: fixed event sequence -> one active track within 300 m of the source', () => {
  const w = new LocalWorld(T0);
  burst(w, ORIGIN, T0, 12);
  w.setNow(T0 + 12_000);
  w.recluster();
  const tracks = w.rows('track');
  assert.equal(tracks.length, 1);
  const tr = tracks[0];
  assert.equal(tr.status, 'active');
  assert.ok(tr.confidence >= 0.8 && tr.confidence <= 1, `confidence ${tr.confidence}`);
  assert.equal(tr.event_count, 12);
  const err = haversine(tr.lat, tr.lon, ORIGIN.lat, ORIGIN.lon);
  assert.ok(err < 300, `error ${err.toFixed(0)} m`);
  assert.ok(w.rows('anomaly_event').every(e => e.track_id === tr.id), 'all events assigned');
});

test('recluster: low-fusion events never form tracks', () => {
  const w = new LocalWorld(T0);
  for (let i = 0; i < 30; i++) {
    w.call('report_anomaly', {
      ts_ms: BigInt(T0 + i * 500), lat: ORIGIN.lat, lon: ORIGIN.lon, rat_drop: false, rat_drop_secs: 0,
      sms_score: 0.7, url_hash: 'real', brand: 'TxTag', smsc_match: 'yes', source: 'sim',
    });
  }
  w.setNow(T0 + 15_000);
  w.recluster();
  assert.equal(w.rows('track').length, 0);
});

test('status: candidate -> active -> dormant -> active (same url_hash, 2 km away)', () => {
  const w = new LocalWorld(T0);
  burst(w, ORIGIN, T0, 3);
  w.setNow(T0 + 3_000);
  w.recluster();
  assert.equal(w.rows('track')[0].status, 'candidate', '3 events is not enough');

  burst(w, ORIGIN, T0 + 3_000, 6);
  w.setNow(T0 + 9_000);
  w.recluster();
  const [tr] = w.rows('track');
  assert.equal(tr.status, 'active');

  // 89 s after the last event: still active. 91 s: dormant.
  const last = T0 + 8_000;
  w.setNow(last + 89_000);
  w.recluster();
  assert.equal(w.rows('track')[0].status, 'active');
  w.setNow(last + 91_000);
  w.recluster();
  assert.equal(w.rows('track')[0].status, 'dormant');

  // Leftover old events still inside the 120 s window must not revive it or spawn a twin.
  w.setNow(last + 100_000);
  w.recluster();
  assert.deepEqual(w.rows('track').map(t => t.status), ['dormant']);

  // Back on air 2 km east, same campaign: the same track comes back as active.
  const far = offset(ORIGIN, 2000, 0);
  burst(w, far, last + 180_000, 3);
  w.setNow(last + 183_000);
  w.recluster();
  const tracks = w.rows('track');
  assert.equal(tracks.length, 1, 'no new track');
  assert.equal(tracks[0].id, tr.id);
  assert.equal(tracks[0].status, 'active');
  assert.ok(haversine(tracks[0].lat, tracks[0].lon, far.lat, far.lon) < 400, 'jumped to the new position');
});

test('two campaigns 1.5 km apart stay two tracks', () => {
  const w = new LocalWorld(T0);
  burst(w, ORIGIN, T0, 10, 1000, 'campaignA');
  burst(w, offset(ORIGIN, 0, -1500), T0, 10, 1000, 'campaignB');
  w.setNow(T0 + 10_000);
  w.recluster();
  const tracks = w.rows('track');
  assert.equal(tracks.length, 2);
  assert.ok(tracks.every(t => t.status === 'active'));
  const byTrack = new Map<bigint, Set<string>>();
  for (const e of w.rows('anomaly_event')) byTrack.set(e.track_id, (byTrack.get(e.track_id) ?? new Set()).add(e.url_hash));
  for (const hashes of byTrack.values()) assert.equal(hashes.size, 1, 'never mixes campaigns');
});

test('a moving blaster is followed and gets a heading', () => {
  const w = new LocalWorld(T0);
  // 11 m/s due east; each second a phone ~200 m ahead of it gets hit.
  for (let s = 0; s <= 60; s++) {
    const pos = offset(ORIGIN, 11 * s, 0);
    const hit = offset(pos, 150 * Math.cos(s), 200 * Math.sin(s * 1.7));
    report(w, { ts_ms: BigInt(T0 + s * 1000), lat: hit.lat, lon: hit.lon });
    if (s % 3 === 0) {
      w.setNow(T0 + s * 1000);
      w.recluster();
    }
  }
  const tracks = w.rows('track').filter(t => t.status !== 'closed');
  assert.equal(tracks.length, 1);
  const tr = tracks[0];
  const truth = offset(ORIGIN, 660, 0);
  const err = haversine(tr.lat, tr.lon, truth.lat, truth.lon);
  assert.ok(err < 300, `error ${err.toFixed(0)} m`);
  assert.ok(Math.abs(tr.heading_deg - 90) < 45, `heading ${tr.heading_deg}`);
  assert.ok(tr.speed_mps > 4 && tr.speed_mps <= 40, `speed ${tr.speed_mps}`);
});

test('agent reducers cannot change track.confidence or track.status', () => {
  const w = new LocalWorld(T0);
  burst(w, ORIGIN, T0, 12);
  w.setNow(T0 + 12_000);
  w.recluster();
  const before = w.rows('track')[0];

  w.call('agent_write_trace', { track_id: before.id, kind: 'plan', text: 'x'.repeat(300) });
  w.call('agent_set_prediction', {
    track_id: before.id, path_json: '[[32.98,-96.77],[32.99,-96.76]]', intercept_lat: 32.99, intercept_lon: -96.76,
    eta_s: 120, updated_ms: 0n,
  });
  w.call('agent_link_campaign', { track_id: before.id, url_hash: 'h1', brand: 'TxTag', domain_age_days: 2 });
  w.call('agent_record_alert', {
    track_id: before.id, zone_json: '[[32.98,-96.77],[32.99,-96.77],[32.99,-96.76]]', message: 'warn', sent_ms: 0n, recipients: 3,
  });

  const after = w.rows('track')[0];
  assert.equal(after.confidence, before.confidence);
  assert.equal(after.status, before.status);
  assert.equal(after.lat, before.lat);
  const camp = w.rows('campaign')[0];
  assert.equal(after.campaign_id, camp.id);
  assert.equal(camp.first_seen_ms, BigInt(T0), 'first_seen from the earliest event');
  assert.equal(w.rows('agent_trace')[0].text.length, 140);
  assert.equal(w.rows('prediction')[0].updated_ms, BigInt(T0 + 12_000));

  // Agent reducers reject bad input instead of half-writing.
  assert.throws(() => w.call('agent_write_trace', { track_id: before.id, kind: 'set_status', text: '' }));
  assert.throws(() => w.call('agent_set_prediction', {
    track_id: before.id, path_json: 'nope', intercept_lat: 0, intercept_lon: 0, eta_s: 0, updated_ms: 0n,
  }));
  // Upsert: a second prediction replaces the first.
  w.call('agent_set_prediction', {
    track_id: before.id, path_json: '[]', intercept_lat: 1, intercept_lon: 2, eta_s: 5, updated_ms: 7n,
  });
  assert.equal(w.rows('prediction').length, 1);
  assert.equal(w.rows('prediction')[0].eta_s, 5);
});

test('sim_write_truth advances the sim clock; reset_world clears everything', () => {
  const w = new LocalWorld(T0);
  burst(w, ORIGIN, T0, 12);
  w.call('sim_write_truth', { scenario: 'demo-01#0', ts_ms: BigInt(T0 + 500_000), lat: 1, lon: 2, on_air: true });
  // Server clock is still T0, but recluster ages events on the (sped-up) sim clock:
  w.recluster();
  assert.equal(w.rows('track').length, 0, 'events are 500 s old on sim time');

  w.call('dev_set_fusion_weights', { w_rat: 1, w_sms: 0, w_smsc: 0, smsc_bonus: 0 });
  w.call('reset_world', {});
  for (const t of ['anomaly_event', 'track', 'campaign', 'agent_trace', 'prediction', 'alert', 'sim_truth'] as const) {
    assert.equal(w.rows(t).length, 0, t);
  }
  const cfg = w.rows('dev_config')[0];
  assert.equal(cfg.sim_now_ms, 0n);
  assert.equal(cfg.w_rat, 1, 'weights survive a reset');
  assert.equal(w.rows('recluster_schedule').length, 1, 'schedule survives a reset');

  w.call('dev_set_fusion_weights', DEFAULT_WEIGHTS);
  assert.throws(() => w.call('dev_set_fusion_weights', { w_rat: 2, w_sms: 0, w_smsc: 0, smsc_bonus: 0 }));
});
