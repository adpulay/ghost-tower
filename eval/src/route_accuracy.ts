#!/usr/bin/env node
// eval/route_accuracy: how far is predict_route's path from where the blaster really goes?
//
//   npm run eval:routes [-- scenario ...]
//
// Runs each scenario through the real module in-process (same harness as run_eval), records the
// track row at every recluster, and every 15 s of an active track predicts the route three ways:
//   track   heading/speed from the track row, corrected like the agent service does today
//   trail   least-squares direction/speed over the last 60 s of track positions
//   trail+lag the same, starting PREDICT_ROUTE_LAG_S (default 20) seconds ahead along the road
//   snapped   the trail snapped to roads with OSRM map matching (falls back to trail)
// ROUTE_EVAL_METHODS=track,trail picks methods; ROUTE_EVAL_RECLUSTER_S=12 replays the live 4x update rate.
// Error = distance from the predicted position to the true blaster position 30/60/120 s later.
// Uses the public OSRM router (OSRM_URL to override); responses are cached in eval/.osrm-cache.json.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadScenario } from '../../sim/src/scenario.ts';
import { LocalWorld } from '../../spacetime/test/harness.ts';
import { SimWorld } from '../../sim/src/world.ts';
import { haversine, predictRoute, type TrailPoint } from '../../agent/tools/predict_route/index.ts';
import { refreshHeading, DIRECTION_WINDOW_MS } from '../../agent/src/service.ts';

const CACHE = join(dirname(fileURLToPath(import.meta.url)), '..', '.osrm-cache.json');
const cache: Record<string, unknown> = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {};
let lastFetch = 0;
async function fetchJson(url: string): Promise<unknown> {
  if (url in cache) return cache[url];
  const wait = 350 - (Date.now() - lastFetch); // be polite to the public demo server
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastFetch = Date.now();
  const res = await fetch(url, { headers: { 'User-Agent': 'ghost-tower-route-eval/0.1' }, signal: AbortSignal.timeout(8000) });
  const body = await res.json();
  if (res.ok || res.status === 400) cache[url] = body; // 400 = NoMatch etc: a real answer, cache it
  return body;
}

type Snap = { tMs: number; lat: number; lon: number; heading: number; speed: number };
const HORIZONS = [30, 60, 120];
const METHODS = (process.env.ROUTE_EVAL_METHODS?.split(',') ?? ['track', 'trail', 'trail+lag', 'snapped']) as string[];
const LAG_S = Number(process.env.PREDICT_ROUTE_LAG_S || 20);
/** Track update interval in sim seconds: 3 (real time) or 12 (live at --speed 4x). */
const RECLUSTER_MS = Number(process.env.ROUTE_EVAL_RECLUSTER_S || 3) * 1000;

async function runScenario(id: string) {
  const s = loadScenario(id);
  const world = new SimWorld(s);
  const truth: { tMs: number; lat: number; lon: number }[] = [];
  const snaps: Snap[] = [];
  // Same as sim/src/sinks.ts localSink, but with the recluster interval as a parameter: live, recluster
  // runs every 3 s of wall clock, so at --speed 4x the track only updates every 12 s of sim time.
  const lw = new LocalWorld(world.t0Ms);
  let nextRecluster = world.t0Ms;
  for (const tick of world.ticks()) {
    const b = tick.truth[0];
    if (b) truth.push({ tMs: tick.tsMs, lat: b.lat, lon: b.lon });
    lw.setNow(tick.tsMs);
    for (const t of tick.truth) lw.call('sim_write_truth', t);
    for (const r of tick.events) lw.call('report_anomaly', r.args);
    while (tick.tsMs >= nextRecluster) {
      lw.recluster();
      nextRecluster += RECLUSTER_MS;
      const t = lw.rows('track').find(r => r.status === 'active');
      if (t) snaps.push({ tMs: tick.tsMs, lat: t.lat, lon: t.lon, heading: t.heading_deg, speed: t.speed_mps });
    }
  }
  const truthAt = (ms: number) => {
    let best = truth[0]!;
    for (const p of truth) if (Math.abs(p.tMs - ms) < Math.abs(best.tMs - ms)) best = p;
    return Math.abs(best.tMs - ms) <= 2000 ? best : null;
  };

  const errs: Record<string, Record<number, number[]>> = {};
  const basisCount: Record<string, number> = {};
  for (const m of METHODS) errs[m] = Object.fromEntries(HORIZONS.map(h => [h, []]));
  let nextMs = -Infinity;
  for (const cur of snaps) {
    if (cur.tMs < nextMs) continue;
    if (!truthAt(cur.tMs + Math.max(...HORIZONS) * 1000)) break;
    nextMs = cur.tMs + 15_000;
    const trail: TrailPoint[] = snaps.filter(p => p.tMs <= cur.tMs && cur.tMs - p.tMs <= 60_000).map(p => ({ lat: p.lat, lon: p.lon, ms: p.tMs }));
    const positions = snaps.filter(p => p.tMs <= cur.tMs && cur.tMs - p.tMs <= DIRECTION_WINDOW_MS).map(p => ({ ms: p.tMs, lat: p.lat, lon: p.lon }));
    const heading = refreshHeading({ lat: cur.lat, lon: cur.lon, heading_deg: cur.heading, speed_mps: cur.speed }, positions, cur.tMs);
    for (const m of METHODS) {
      const out = await predictRoute(
        { lat: cur.lat, lon: cur.lon, heading_deg: heading, speed_mps: cur.speed, horizon_s: 300, trail: m === 'track' ? undefined : trail },
        { fetchJson, offline: false, trailMode: m === 'track' ? 'none' : m.startsWith('snapped') ? 'snap' : 'fit', lagS: m.endsWith('+lag') ? LAG_S : 0 },
      );
      basisCount[`${m}:${out.basis}/${out.source}`] = (basisCount[`${m}:${out.basis}/${out.source}`] ?? 0) + 1;
      for (const h of HORIZONS) {
        const truthP = truthAt(cur.tMs + h * 1000)!;
        const pred = out.path[Math.min(out.path.length - 1, h / 15)]!;
        errs[m]![h]!.push(haversine(pred, [truthP.lat, truthP.lon]));
      }
    }
  }
  return { id, errs, basisCount, n: errs.track![30]!.length };
}

const q = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : NaN;
};

const ids = process.argv.slice(2).length ? process.argv.slice(2) : ['demo-01', 'turns-01', 'straight-01'];
const all: Record<string, Record<number, number[]>> = Object.fromEntries(METHODS.map(m => [m, Object.fromEntries(HORIZONS.map(h => [h, []]))]));
for (const id of ids) {
  const r = await runScenario(id);
  console.log(`\n${id}: ${r.n} predictions`);
  console.log('  method   ' + HORIZONS.map(h => `+${h}s median / p90`.padEnd(20)).join(''));
  for (const m of METHODS) {
    console.log(`  ${m.padEnd(8)} ` + HORIZONS.map(h => `${Math.round(q(r.errs[m]![h]!, 0.5))} / ${Math.round(q(r.errs[m]![h]!, 0.9))} m`.padEnd(20)).join(''));
    for (const h of HORIZONS) all[m]![h]!.push(...r.errs[m]![h]!);
  }
  console.log('  ' + Object.entries(r.basisCount).map(([k, v]) => `${k}=${v}`).join('  '));
}
console.log(`\nall scenarios:`);
for (const m of METHODS) console.log(`  ${m.padEnd(8)} ` + HORIZONS.map(h => `${Math.round(q(all[m]![h]!, 0.5))} / ${Math.round(q(all[m]![h]!, 0.9))} m`.padEnd(20)).join(''));
writeFileSync(CACHE, JSON.stringify(cache));
