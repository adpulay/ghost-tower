// Headline metrics (A.md Phase 6 / TESTING.md §3), computed from one recorded run.
// Pure: the same code scores local (in-process) runs and live recordings.
import { haversine } from '../../spacetime/src/geo.ts';

export interface TrackSnap {
  id: bigint;
  lat: number;
  lon: number;
  status: string;
}

export interface Snapshot {
  tMs: number;
  tracks: TrackSnap[];
  /** truth per blaster at this time */
  truth: { lat: number; lon: number; onAir: boolean }[];
}

export interface EventRec {
  id: bigint;
  tsMs: number;
  lat: number;
  lon: number;
  trackId: bigint;
  /** ground truth: was this report caused by a blaster? */
  isTrue: boolean;
  /** phone index if known (local runs), for "protected before hit" */
  phone?: number;
}

export interface AlertRec {
  sentMs: number;
  zone: [number, number][];
}

export interface RunRecord {
  scenario: string;
  kind: 'attack' | 'benign';
  blasters: number;
  phoneHours: number;
  firstOnAirMs: number[];
  snapshots: Snapshot[];
  events: EventRec[];
  alerts: AlertRec[];
  /** phone true positions (local runs) */
  phones?: { lat: number; lon: number }[];
  reclusterMs: number[];
}

export interface Metrics {
  timeToFirstAlertS: number | null;
  timeToUsableFixS: number | null;
  errMedianM: number | null;
  errP90M: number | null;
  protectedPct: number | null;
  activeTracks: number;
  falseActiveTracks: number;
  falseAlarmsPer1kPhoneHr: number;
  eventPrecision: number | null;
  eventRecall: number | null;
  /** raw counts behind precision/recall, for pooling across runs */
  eventCounts: { tp: number; fp: number; pos: number };
  reclusterMeanMs: number;
  reclusterMaxMs: number;
}

const ASSOC_RADIUS_M = 1500;
const FIX_M = 300;
const FIX_HOLD_MS = 30_000;

export function quantile(xs: number[], q: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}

/** Greedy unique blaster <-> active-track association by distance. */
export function associate(snap: Snapshot): (TrackSnap | undefined)[] {
  const active = snap.tracks.filter(t => t.status === 'active');
  const pairs: { b: number; t: TrackSnap; d: number }[] = [];
  snap.truth.forEach((tr, b) => {
    for (const t of active) {
      const d = haversine(t.lat, t.lon, tr.lat, tr.lon);
      if (d <= ASSOC_RADIUS_M) pairs.push({ b, t, d });
    }
  });
  pairs.sort((x, y) => x.d - y.d);
  const out: (TrackSnap | undefined)[] = snap.truth.map(() => undefined);
  const used = new Set<bigint>();
  for (const p of pairs) {
    if (out[p.b] || used.has(p.t.id)) continue;
    out[p.b] = p.t;
    used.add(p.t.id);
  }
  return out;
}

export function pointInPolygon(lat: number, lon: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i], [yj, xj] = poly[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function score(r: RunRecord): Metrics {
  const everActive = new Set<bigint>();
  for (const s of r.snapshots) for (const t of s.tracks) if (t.status === 'active') everActive.add(t.id);

  // Which ever-active tracks are real? A track is "true" if most of its events came from a blaster.
  const perTrack = new Map<bigint, { tp: number; n: number }>();
  for (const e of r.events) {
    if (e.trackId === 0n) continue;
    const c = perTrack.get(e.trackId) ?? { tp: 0, n: 0 };
    c.n++;
    if (e.isTrue) c.tp++;
    perTrack.set(e.trackId, c);
  }
  const falseActive = [...everActive].filter(id => {
    const c = perTrack.get(id);
    return !c || c.tp / c.n < 0.5;
  }).length;

  // Event-level precision / recall: "assigned to a track that went active" vs ground truth.
  let tp = 0, fp = 0, pos = 0;
  for (const e of r.events) {
    const predicted = everActive.has(e.trackId);
    if (e.isTrue) pos++;
    if (predicted && e.isTrue) tp++;
    else if (predicted) fp++;
  }

  const m: Metrics = {
    timeToFirstAlertS: null,
    timeToUsableFixS: null,
    errMedianM: null,
    errP90M: null,
    protectedPct: null,
    activeTracks: everActive.size,
    falseActiveTracks: falseActive,
    falseAlarmsPer1kPhoneHr: (falseActive / Math.max(1e-9, r.phoneHours)) * 1000,
    eventPrecision: tp + fp ? tp / (tp + fp) : null,
    eventRecall: pos ? tp / pos : null,
    eventCounts: { tp, fp, pos },
    reclusterMeanMs: r.reclusterMs.length ? r.reclusterMs.reduce((a, b) => a + b, 0) / r.reclusterMs.length : 0,
    reclusterMaxMs: r.reclusterMs.length ? Math.max(...r.reclusterMs) : 0,
  };
  if (r.kind !== 'attack' || !r.blasters) return m;

  // Per blaster: first association time, per-snapshot error, time to a held fix.
  const ttfa: number[] = [];
  const ttfix: number[] = [];
  const errs: number[] = [];
  for (let b = 0; b < r.blasters; b++) {
    const series: { t: number; err: number | null }[] = [];
    for (const s of r.snapshots) {
      if (!s.truth[b]?.onAir) continue;
      const tr = associate(s)[b];
      const err = tr ? haversine(tr.lat, tr.lon, s.truth[b].lat, s.truth[b].lon) : null;
      series.push({ t: s.tMs, err });
      if (err !== null) errs.push(err);
    }
    const t0 = r.firstOnAirMs[b];
    const first = series.find(x => x.err !== null);
    if (first) ttfa.push((first.t - t0) / 1000);
    for (let i = 0; i < series.length; i++) {
      if (series[i].err === null || series[i].err! > FIX_M) continue;
      const end = series[i].t + FIX_HOLD_MS;
      const window = series.slice(i).filter(x => x.t <= end);
      if (window.at(-1)!.t < end - 3000) break; // ran out of on-air time
      if (window.every(x => x.err !== null && x.err <= FIX_M)) {
        ttfix.push((series[i].t - t0) / 1000);
        break;
      }
    }
  }
  m.timeToFirstAlertS = ttfa.length ? Math.max(...ttfa) : null;
  m.timeToUsableFixS = ttfix.length === r.blasters ? Math.max(...ttfix) : null;
  m.errMedianM = quantile(errs, 0.5);
  m.errP90M = quantile(errs, 0.9);

  // Protected before hit: of the phones first hit after the first alert went out, the share
  // that were inside an alert zone sent before their hit.
  if (r.alerts.length) {
    const firstAlert = Math.min(...r.alerts.map(a => a.sentMs));
    const firstHit = new Map<string, EventRec>();
    for (const e of [...r.events].sort((a, b) => a.tsMs - b.tsMs)) {
      if (!e.isTrue) continue;
      const key = e.phone !== undefined ? `p${e.phone}` : `e${e.id}`;
      if (!firstHit.has(key)) firstHit.set(key, e);
    }
    let denom = 0, prot = 0;
    for (const e of firstHit.values()) {
      if (e.tsMs <= firstAlert) continue;
      denom++;
      const at = e.phone !== undefined && r.phones ? r.phones[e.phone] : e;
      if (r.alerts.some(a => a.sentMs < e.tsMs && pointInPolygon(at.lat, at.lon, a.zone))) prot++;
    }
    m.protectedPct = denom ? (100 * prot) / denom : null;
  }
  return m;
}
