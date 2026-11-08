// Pure tracking math for the Ghost Tower module (INTERFACES.md §4–§5, A.md Phase 3).
// No SpacetimeDB imports, so it can be unit-tested with plain Node. Deterministic: no clocks,
// no randomness. `now` is always passed in (the reducer uses ctx.timestamp).

// ---- constants (change only together with INTERFACES.md) ----
export const FUSION_W_RAT = 0.45;
export const FUSION_W_SMS = 0.35;
export const FUSION_W_SMSC = 0.2;
export const RAT_DROP_MAX_SECS = 30;
export const MIN_FUSION = 0.3;

export const WINDOW_MS = 120_000; // events in the last 120 s count
export const CLUSTER_RADIUS_M = 800;
export const MATCH_RADIUS_M = 1_000;
export const RECENCY_TAU_MS = 30_000;
export const SMOOTH_CENTROID = 0.6; // new_pos = 0.6 * centroid + 0.4 * predicted
export const VELOCITY_ALPHA = 0.4; // EMA on the fitted velocity, keeps heading from jittering (tuned on 12 seeded drives)
export const MAX_SPEED_MPS = 40;
export const MIN_HEADING_SPEED_MPS = 2; // below this, keep the previous heading (same cutoff the agent uses for turns)
/**
 * Velocity is fitted through the events of the last 90 s. Until the events span ≥30 s the track
 * reports speed 0 (heading unknown) instead of a noisy guess from the first burst of phones.
 */
export const VELOCITY_FIT_MS = 90_000;
export const VELOCITY_FIT_MIN_EVENTS = 4;
export const VELOCITY_FIT_MIN_SPAN_MS = 30_000;
export const MAX_PREDICT_DT_S = 30;
export const ACTIVE_MIN_EVENTS = 5;
export const ACTIVE_MIN_CONFIDENCE = 0.8;
export const DORMANT_AFTER_MS = 90_000;
export const CLOSE_CANDIDATE_AFTER_MS = 90_000;
/** A cluster whose newest event is older than this can't start a new track (stale trail of a moving blaster). */
export const NEW_TRACK_MAX_AGE_MS = 30_000;
/** Future-dated events (clock skew) beyond this are ignored. */
export const MAX_FUTURE_MS = 5_000;

// ---- fusion (INTERFACES.md §4) ----

export function smscSignal(smsc: string): number {
  if (smsc === "no") return 1;
  if (smsc === "yes") return 0;
  return 0.5;
}

export function fusionScore(ratDrop: boolean, ratDropSecs: number, smsScore: number, smscMatch: string): number {
  const rat = ratDrop && ratDropSecs <= RAT_DROP_MAX_SECS ? 1 : 0;
  return FUSION_W_RAT * rat + FUSION_W_SMS * clamp01(smsScore) + FUSION_W_SMSC * smscSignal(smscMatch);
}

/** Round to 3 decimals (~150 m), as INTERFACES.md §2 requires. */
export function coarsen(deg: number): number {
  return Math.round(deg * 1000) / 1000;
}

export function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

// ---- geo ----

const R_EARTH = 6_371_000;
const M_PER_DEG_LAT = 111_320;
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Offset a point by north/east meters (local flat approximation, fine at city scale). */
export function offset(lat: number, lon: number, northM: number, eastM: number): [number, number] {
  return [lat + northM / M_PER_DEG_LAT, lon + eastM / (M_PER_DEG_LAT * Math.cos(rad(lat)))];
}

/** North/east meters from a to b. */
export function enu(aLat: number, aLon: number, bLat: number, bLon: number): [number, number] {
  return [(bLat - aLat) * M_PER_DEG_LAT, (bLon - aLon) * M_PER_DEG_LAT * Math.cos(rad((aLat + bLat) / 2))];
}

/** Heading 0 = north, clockwise, in [0, 360). */
export function headingFromVelocity(velN: number, velE: number): number {
  return (deg(Math.atan2(velE, velN)) + 360) % 360;
}

// ---- recluster ----

export interface EventRow {
  id: number;
  ts_ms: number;
  lat: number;
  lon: number;
  fusion_score: number;
  url_hash: string;
  smsc_match: string;
  track_id: number;
}

export interface TrackRow {
  id: number;
  lat: number;
  lon: number;
  heading_deg: number;
  speed_mps: number;
  confidence: number;
  event_count: number;
  status: string;
  campaign_id: number;
  updated_ms: number;
}

/** Internal per-track state (private table `track_state`). */
export interface TrackState {
  track_id: number;
  last_event_ms: number;
  vel_n: number;
  vel_e: number;
  url_hash: string;
}

export interface TrackResult {
  /** null = new track: the reducer inserts it and uses the assigned id. */
  id: number | null;
  track: Omit<TrackRow, "id">;
  state: Omit<TrackState, "track_id">;
  /** Event ids to assign to this track. */
  eventIds: number[];
}

export interface Cluster {
  urlHash: string;
  events: EventRow[];
  sumLat: number;
  sumLon: number;
}

const centroidOf = (c: Cluster): [number, number] => [c.sumLat / c.events.length, c.sumLon / c.events.length];
const newest = (c: Cluster) => Math.max(...c.events.map((e) => e.ts_ms));

/** Greedy clustering, newest event first, kept separate per url_hash. */
export function clusterEvents(events: EventRow[]): Cluster[] {
  const sorted = [...events].sort((a, b) => b.ts_ms - a.ts_ms || a.id - b.id);
  const clusters: Cluster[] = [];
  for (const e of sorted) {
    let best: Cluster | undefined;
    let bestD = Infinity;
    for (const c of clusters) {
      if (c.urlHash !== e.url_hash) continue;
      const [cl, co] = centroidOf(c);
      const d = haversineM(cl, co, e.lat, e.lon);
      if (d <= CLUSTER_RADIUS_M && d < bestD) {
        best = c;
        bestD = d;
      }
    }
    if (best) {
      best.events.push(e);
      best.sumLat += e.lat;
      best.sumLon += e.lon;
    } else {
      clusters.push({ urlHash: e.url_hash, events: [e], sumLat: e.lat, sumLon: e.lon });
    }
  }
  return clusters;
}

/** Fusion × recency weighted centroid, recency = exp(-(now - ts) / 30 s). */
export function weightedCentroid(events: EventRow[], now: number): [number, number] {
  let w = 0;
  let lat = 0;
  let lon = 0;
  for (const e of events) {
    const wi = Math.max(1e-6, e.fusion_score) * Math.exp(-Math.max(0, now - e.ts_ms) / RECENCY_TAU_MS);
    w += wi;
    lat += wi * e.lat;
    lon += wi * e.lon;
  }
  return [lat / w, lon / w];
}

/** c = min(1, n / 10) * mean(fusion), +0.1 if any smsc_match == "no", capped at 1. */
export function confidenceOf(events: EventRow[]): number {
  if (events.length === 0) return 0;
  const mean = events.reduce((s, e) => s + e.fusion_score, 0) / events.length;
  const bonus = events.some((e) => e.smsc_match === "no") ? 0.1 : 0;
  return Math.min(1, Math.min(1, events.length / 10) * mean + bonus);
}

/**
 * Recency-weighted least-squares fit of event position against time, in m/s (north, east).
 * Phones report in bursts as the blaster passes, so the trail of events is a better velocity
 * signal than the difference of two smoothed positions, which stalls between bursts.
 */
export function fitVelocity(events: EventRow[], now: number): [number, number] | null {
  const evs = events.filter((e) => now - e.ts_ms <= VELOCITY_FIT_MS);
  if (evs.length < VELOCITY_FIT_MIN_EVENTS) return null;
  const tMin = Math.min(...evs.map((e) => e.ts_ms));
  const tMax = Math.max(...evs.map((e) => e.ts_ms));
  if (tMax - tMin < VELOCITY_FIT_MIN_SPAN_MS) return null;
  const o = evs[0]!;
  let sw = 0, st = 0, stt = 0, sn = 0, se = 0, stn = 0, ste = 0;
  for (const e of evs) {
    const w = Math.exp(-Math.max(0, now - e.ts_ms) / RECENCY_TAU_MS);
    const t = (e.ts_ms - tMin) / 1000;
    const [n, ea] = enu(o.lat, o.lon, e.lat, e.lon);
    sw += w; st += w * t; stt += w * t * t; sn += w * n; se += w * ea; stn += w * t * n; ste += w * t * ea;
  }
  const den = sw * stt - st * st;
  if (den <= 1e-9) return null;
  return [(sw * stn - st * sn) / den, (sw * ste - st * se) / den];
}

export function predictedPosition(t: TrackRow, st: TrackState | undefined, now: number): [number, number] {
  if (!st) return [t.lat, t.lon];
  const dt = Math.min(MAX_PREDICT_DT_S, Math.max(0, (now - t.updated_ms) / 1000));
  return offset(t.lat, t.lon, st.vel_n * dt, st.vel_e * dt);
}

/**
 * One recluster pass. Returns only the tracks that need writing.
 * `events` may contain anything; window and fusion filtering happen here.
 */
export function recluster(
  now: number,
  events: EventRow[],
  tracks: TrackRow[],
  states: Map<number, TrackState>,
): TrackResult[] {
  const recent = events.filter(
    (e) => e.fusion_score >= MIN_FUSION && now - e.ts_ms <= WINDOW_MS && e.ts_ms - now <= MAX_FUTURE_MS,
  );
  const clusters = clusterEvents(recent).sort((a, b) => b.events.length - a.events.length || newest(b) - newest(a));

  const live = tracks.filter((t) => t.status !== "closed").sort((a, b) => a.id - b.id);
  const matched = new Map<number, { events: EventRow[]; reactivated: boolean }>();
  const fresh: EventRow[][] = [];

  for (const c of clusters) {
    const [cLat, cLon] = weightedCentroid(c.events, now);

    // 1) a candidate/active track of the same campaign near its predicted position
    let best: TrackRow | undefined;
    let bestD = Infinity;
    for (const t of live) {
      if (t.status === "dormant") continue;
      const st = states.get(t.id);
      if ((st?.url_hash ?? "") !== c.urlHash) continue;
      const [pLat, pLon] = predictedPosition(t, st, now);
      const d = haversineM(pLat, pLon, cLat, cLon);
      if (d < MATCH_RADIUS_M && d < bestD) {
        best = t;
        bestD = d;
      }
    }

    // 2) dormant → active: same url_hash anywhere, or nearby when there is no link at all
    if (!best) {
      let bestMs = -Infinity;
      for (const t of live) {
        if (t.status !== "dormant") continue;
        const st = states.get(t.id);
        const h = st?.url_hash ?? "";
        if (h !== c.urlHash) continue;
        if (h === "" && haversineM(t.lat, t.lon, cLat, cLon) >= MATCH_RADIUS_M) continue;
        const ms = st?.last_event_ms ?? 0;
        if (newest(c) <= ms) continue; // only events from before it went dormant
        if (ms > bestMs) {
          best = t;
          bestMs = ms;
        }
      }
    }

    if (best) {
      const m = matched.get(best.id);
      if (m) m.events.push(...c.events); // the trail of a moving blaster can split into clusters
      else matched.set(best.id, { events: [...c.events], reactivated: best.status === "dormant" });
      continue;
    }

    // 3) new track, but only from a cluster with recent activity
    if (now - newest(c) <= NEW_TRACK_MAX_AGE_MS) fresh.push(c.events);
  }

  const out: TrackResult[] = [];

  for (const t of live) {
    const st = states.get(t.id);
    const m = matched.get(t.id);
    if (m) {
      out.push(updateMatched(now, t, st, m.events, m.reactivated));
      continue;
    }
    const lastEvent = st?.last_event_ms ?? t.updated_ms;
    const idle = now - lastEvent;
    let status = t.status;
    if (t.status === "active" && idle > DORMANT_AFTER_MS) status = "dormant";
    if (t.status === "candidate" && idle > CLOSE_CANDIDATE_AFTER_MS) status = "closed";
    const count = recent.filter((e) => e.track_id === t.id).length;
    if (status !== t.status || count !== t.event_count) {
      const { id: _id, ...row } = t;
      out.push({
        id: t.id,
        track: { ...row, status, event_count: count, speed_mps: status === "active" || status === "candidate" ? t.speed_mps : 0 },
        state: st
          ? { last_event_ms: st.last_event_ms, vel_n: st.vel_n, vel_e: st.vel_e, url_hash: st.url_hash }
          : { last_event_ms: lastEvent, vel_n: 0, vel_e: 0, url_hash: "" },
        eventIds: [],
      });
    }
  }

  for (const evs of fresh) out.push(newTrack(now, evs));
  return out;
}

function updateMatched(
  now: number,
  t: TrackRow,
  st: TrackState | undefined,
  evs: EventRow[],
  reactivated: boolean,
): TrackResult {
  const [cLat, cLon] = weightedCentroid(evs, now);
  let lat = cLat;
  let lon = cLon;
  let velN = 0;
  let velE = 0;
  if (!reactivated && st) {
    const [pLat, pLon] = predictedPosition(t, st, now);
    lat = SMOOTH_CENTROID * cLat + (1 - SMOOTH_CENTROID) * pLat;
    lon = SMOOTH_CENTROID * cLon + (1 - SMOOTH_CENTROID) * pLon;
    // No fit yet (too few events, or too short a span): keep the previous velocity (0 for a new track).
    const inst = fitVelocity(evs, now);
    [velN, velE] = inst
      ? [VELOCITY_ALPHA * inst[0] + (1 - VELOCITY_ALPHA) * st.vel_n, VELOCITY_ALPHA * inst[1] + (1 - VELOCITY_ALPHA) * st.vel_e]
      : [st.vel_n, st.vel_e];
  }
  let speed = Math.hypot(velN, velE);
  if (speed > MAX_SPEED_MPS) {
    velN *= MAX_SPEED_MPS / speed;
    velE *= MAX_SPEED_MPS / speed;
    speed = MAX_SPEED_MPS;
  }
  const heading = speed >= MIN_HEADING_SPEED_MPS ? headingFromVelocity(velN, velE) : t.heading_deg;
  const confidence = confidenceOf(evs);
  const meetsActive = evs.length >= ACTIVE_MIN_EVENTS && confidence >= ACTIVE_MIN_CONFIDENCE;
  const lastEvent = Math.max(...evs.map((e) => e.ts_ms));
  let status = t.status;
  if (reactivated || (t.status === "candidate" && meetsActive)) status = "active";
  // Old events can still be inside the 120 s window after the blaster goes quiet.
  if (status === "active" && now - lastEvent > DORMANT_AFTER_MS) status = "dormant";
  if (status === "candidate" && now - lastEvent > CLOSE_CANDIDATE_AFTER_MS) status = "closed";
  if (status !== "active") [velN, velE, speed] = [0, 0, 0];
  return {
    id: t.id,
    track: {
      lat,
      lon,
      heading_deg: heading,
      speed_mps: speed,
      confidence,
      event_count: evs.length,
      status,
      campaign_id: t.campaign_id,
      updated_ms: now,
    },
    state: { last_event_ms: lastEvent, vel_n: velN, vel_e: velE, url_hash: evs[0]!.url_hash },
    eventIds: evs.map((e) => e.id).sort((a, b) => a - b),
  };
}

function newTrack(now: number, evs: EventRow[]): TrackResult {
  const [lat, lon] = weightedCentroid(evs, now);
  const confidence = confidenceOf(evs);
  const meetsActive = evs.length >= ACTIVE_MIN_EVENTS && confidence >= ACTIVE_MIN_CONFIDENCE;
  return {
    id: null,
    track: {
      lat,
      lon,
      heading_deg: 0,
      speed_mps: 0,
      confidence,
      event_count: evs.length,
      status: meetsActive ? "active" : "candidate",
      campaign_id: 0,
      updated_ms: now,
    },
    state: { last_event_ms: Math.max(...evs.map((e) => e.ts_ms)), vel_n: 0, vel_e: 0, url_hash: evs[0]!.url_hash },
    eventIds: evs.map((e) => e.id).sort((a, b) => a - b),
  };
}
