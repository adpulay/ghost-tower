// Recluster: the tracking math from A.md Phase 3 + INTERFACES.md §5.
//
// Pure and deterministic: given the recent events, the live tracks and a clock, it returns
// the new track states and event->track assignments. The `recluster` reducer is a thin
// wrapper that reads tables, calls this, and writes the diff back. No randomness, no I/O,
// and iteration order is always by (ts, id) so the same input gives the same output.

import { FUSION_MIN, type FusionWeights } from './fusion.ts';
import { angleDiff, bearing, dist, enu, normDeg, offset, type LatLon } from './geo.ts';

export const P = {
  /** look-back window for events (ms) */
  windowMs: 120_000,
  /** greedy cluster join radius (m) */
  clusterRadiusM: 800,
  /** cluster -> track match radius around the track's predicted position (m) */
  matchRadiusM: 1000,
  /** same-campaign live tracks closer than this are one blaster and get merged (m) */
  dedupeRadiusM: 1000,
  /** recency weight time constant (ms) */
  recencyTauMs: 30_000,
  /** position smoothing: new = a * centroid + (1 - a) * predicted */
  smoothAlpha: 0.6,
  maxSpeedMps: 40,
  /** below this a track is treated as parked and keeps its last heading */
  minHeadingSpeedMps: 1,
  /** velocity is not re-estimated from position steps shorter than this */
  minVelocityDtMs: 1500,
  /** candidate -> active thresholds (§5) */
  activeMinEvents: 5,
  activeMinConfidence: 0.8,
  /** active -> dormant after this long with no new events (§5) */
  dormantAfterMs: 90_000,
  /** a candidate that gets no events for this long is dropped */
  candidateCloseMs: 120_000,
  /** a dormant track that never comes back is closed after this long */
  dormantCloseMs: 600_000,
  /** how far ahead the prediction is allowed to extrapolate (ms) */
  maxPredictDtMs: 30_000,
};

export type TrackStatus = 'candidate' | 'active' | 'dormant' | 'closed';

export interface EventIn {
  id: bigint;
  ts_ms: number;
  lat: number;
  lon: number;
  fusion_score: number;
  url_hash: string;
  smsc_match: string;
  track_id: bigint;
}

export interface TrackIn {
  id: bigint;
  lat: number;
  lon: number;
  heading_deg: number;
  speed_mps: number;
  confidence: number;
  event_count: number;
  status: TrackStatus;
  campaign_id: bigint;
  updated_ms: number;
  /** url_hash of the track's newest event (looked up by the reducer) */
  url_hash: string;
  /** ts of the track's newest assigned event (looked up by the reducer) */
  last_event_ms: number;
}

export type TrackOut = Omit<TrackIn, 'url_hash' | 'last_event_ms'>;

export interface ReclusterResult {
  /** existing tracks whose row changed */
  updated: TrackOut[];
  /** brand-new tracks; `id` is a temporary negative key referenced by `assign` */
  created: TrackOut[];
  /** event id -> track id (existing id, or a negative temp key from `created`) */
  assign: Map<bigint, bigint>;
}

interface Cluster {
  hash: string;
  events: EventIn[];
  /** running unweighted centroid, used only while greedily building the cluster */
  cLat: number;
  cLon: number;
}

interface ClusterStats {
  centroid: LatLon;
  count: number;
  meanFusion: number;
  anySmscNo: boolean;
  newestMs: number;
}

function byTsThenId(a: EventIn, b: EventIn): number {
  return a.ts_ms - b.ts_ms || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function byId(a: { id: bigint }, b: { id: bigint }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Step 1: greedy clustering, separated by url_hash (campaign). */
export function cluster(events: EventIn[]): Cluster[] {
  const clusters: Cluster[] = [];
  for (const e of [...events].sort(byTsThenId)) {
    let best: Cluster | undefined;
    let bestD = Infinity;
    for (const c of clusters) {
      if (c.hash !== e.url_hash) continue;
      const d = dist({ lat: c.cLat, lon: c.cLon }, e);
      if (d <= P.clusterRadiusM && d < bestD) {
        best = c;
        bestD = d;
      }
    }
    if (best) {
      const n = best.events.length;
      best.cLat = (best.cLat * n + e.lat) / (n + 1);
      best.cLon = (best.cLon * n + e.lon) / (n + 1);
      best.events.push(e);
    } else {
      clusters.push({ hash: e.url_hash, events: [e], cLat: e.lat, cLon: e.lon });
    }
  }
  return clusters;
}

/** Steps 3 + 5 inputs: recency-weighted centroid and confidence ingredients. */
export function stats(events: EventIn[], nowMs: number): ClusterStats {
  let wSum = 0, lat = 0, lon = 0, fSum = 0, newest = -Infinity, anyNo = false;
  for (const e of events) {
    const w = e.fusion_score * Math.exp(-Math.max(0, nowMs - e.ts_ms) / P.recencyTauMs);
    wSum += w;
    lat += w * e.lat;
    lon += w * e.lon;
    fSum += e.fusion_score;
    newest = Math.max(newest, e.ts_ms);
    anyNo ||= e.smsc_match === 'no';
  }
  const n = events.length;
  const centroid =
    wSum > 0
      ? { lat: lat / wSum, lon: lon / wSum }
      : { lat: events.reduce((s, e) => s + e.lat, 0) / n, lon: events.reduce((s, e) => s + e.lon, 0) / n };
  return { centroid, count: n, meanFusion: n ? fSum / n : 0, anySmscNo: anyNo, newestMs: newest };
}

export function confidence(s: Pick<ClusterStats, 'count' | 'meanFusion' | 'anySmscNo'>, w: FusionWeights): number {
  if (s.count === 0) return 0;
  const c = Math.min(1, s.count / 10) * s.meanFusion + (s.anySmscNo ? w.smsc_bonus : 0);
  return Math.min(1, c);
}

/** Position the track would be at now if it kept its velocity. */
export function predicted(t: TrackIn | TrackOut, nowMs: number): LatLon {
  const dtS = Math.min(P.maxPredictDtMs, Math.max(0, nowMs - t.updated_ms)) / 1000;
  const h = (t.heading_deg * Math.PI) / 180;
  return offset(t, Math.sin(h) * t.speed_mps * dtS, Math.cos(h) * t.speed_mps * dtS);
}

export function recluster(
  allRecent: EventIn[],
  tracksIn: TrackIn[],
  nowMs: number,
  w: FusionWeights,
): ReclusterResult {
  const events = allRecent.filter(e => nowMs - e.ts_ms <= P.windowMs && e.fusion_score >= FUSION_MIN);
  const tracks = tracksIn.filter(t => t.status !== 'closed').sort(byId);
  const meta = new Map(tracks.map(t => [t.id, { hash: t.url_hash, last: t.last_event_ms }]));
  const clusters = cluster(events);

  // Step 2: match each cluster to a live (candidate/active) track of the same campaign.
  // Continuity first: a cluster holding events that were already assigned to a track last
  // pass belongs to that track. Otherwise, the nearest track whose predicted position is
  // within 1 km of the cluster (measured to the cluster's closest event, so the leading
  // edge of a long 120 s trail still attaches to its own track instead of spawning a twin).
  // Several clusters may feed one track; their events are merged.
  const live = tracks.filter(t => t.status === 'candidate' || t.status === 'active');
  const liveIds = new Set(live.map(t => t.id));
  const feeds = new Map<bigint, EventIn[]>();
  const unmatched: Cluster[] = [];
  for (const c of clusters) {
    let best: TrackIn | undefined;
    const shared = new Map<bigint, number>();
    for (const e of c.events) if (liveIds.has(e.track_id)) shared.set(e.track_id, (shared.get(e.track_id) ?? 0) + 1);
    if (shared.size) {
      const [id] = [...shared].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
      best = live.find(t => t.id === id && meta.get(t.id)!.hash === c.hash);
    }
    if (!best) {
      let bestD = Infinity;
      for (const t of live) {
        if (meta.get(t.id)!.hash !== c.hash) continue;
        const pred = predicted(t, nowMs);
        const d = Math.min(...c.events.map(e => dist(pred, e)));
        if (d < P.matchRadiusM && d < bestD) {
          best = t;
          bestD = d;
        }
      }
    }
    if (best) feeds.set(best.id, [...(feeds.get(best.id) ?? []), ...c.events]);
    else unmatched.push(c);
  }

  // Unmatched clusters: a same-campaign dormant track with genuinely new events comes back
  // (§5: dormant -> active on same url_hash). Stale leftovers of a dormant track are left
  // alone. Anything else seeds a new candidate track.
  const revived = new Set<bigint>();
  const created: TrackOut[] = [];
  const createdFeeds = new Map<bigint, EventIn[]>();
  let tmp = -1n;
  for (const c of unmatched) {
    const s = stats(c.events, nowMs);
    const dormant = tracks
      .filter(t => t.status === 'dormant' && meta.get(t.id)!.hash === c.hash)
      // an empty hash is "no campaign", so only revive those by proximity
      .filter(t => c.hash !== '' || dist(t, s.centroid) < P.matchRadiusM)
      .sort((a, b) => b.updated_ms - a.updated_ms || byId(a, b));
    if (dormant.length) {
      const d = dormant[0];
      if (s.newestMs > meta.get(d.id)!.last) {
        feeds.set(d.id, [...(feeds.get(d.id) ?? []), ...c.events]);
        revived.add(d.id);
      }
      continue;
    }
    const id = tmp--;
    created.push({
      id, lat: s.centroid.lat, lon: s.centroid.lon, heading_deg: 0, speed_mps: 0,
      confidence: 0, event_count: 0, status: 'candidate', campaign_id: 0n, updated_ms: nowMs,
    });
    createdFeeds.set(id, c.events);
    meta.set(id, { hash: c.hash, last: s.newestMs });
  }

  const assign = new Map<bigint, bigint>();
  const out = new Map<bigint, TrackOut>();

  // Steps 3-6 for every non-closed track.
  for (const t of tracks) {
    const fed = feeds.get(t.id);
    let next: TrackOut = {
      id: t.id, lat: t.lat, lon: t.lon, heading_deg: t.heading_deg, speed_mps: t.speed_mps,
      confidence: t.confidence, event_count: t.event_count, status: t.status,
      campaign_id: t.campaign_id, updated_ms: t.updated_ms,
    };
    let lastEvent = meta.get(t.id)!.last;
    if (fed && fed.length) {
      for (const e of fed) assign.set(e.id, t.id);
      const s = stats(fed, nowMs);
      lastEvent = Math.max(lastEvent, s.newestMs);
      if (revived.has(t.id)) {
        // It reappeared somewhere else (e.g. 2 km down the road): jump, reset velocity.
        next = { ...next, lat: s.centroid.lat, lon: s.centroid.lon, speed_mps: 0, status: 'active', updated_ms: nowMs };
      } else {
        next = { ...next, ...smoothAndVelocity(t, s.centroid, nowMs) };
      }
      next.confidence = confidence(s, w);
      next.event_count = s.count;
    } else {
      next.event_count = 0;
      next.confidence = 0;
    }
    next.status = transition(next, lastEvent, nowMs);
    out.set(t.id, next);
  }
  for (const c of created) {
    const fed = createdFeeds.get(c.id)!;
    for (const e of fed) assign.set(e.id, c.id);
    const s = stats(fed, nowMs);
    c.confidence = confidence(s, w);
    c.event_count = s.count;
    c.status = transition(c, s.newestMs, nowMs);
  }

  dedupe([...out.values(), ...created], meta, assign);

  const updated = [...out.values()].filter(n => {
    const o = tracks.find(t => t.id === n.id)!;
    return (
      o.lat !== n.lat || o.lon !== n.lon || o.heading_deg !== n.heading_deg || o.speed_mps !== n.speed_mps ||
      o.confidence !== n.confidence || o.event_count !== n.event_count || o.status !== n.status ||
      o.updated_ms !== n.updated_ms
    );
  });
  return { updated, created: created.filter(c => c.status !== 'closed'), assign };
}

/** Steps 3-4: smoothing and velocity from the last two smoothed positions. */
function smoothAndVelocity(t: TrackIn, centroid: LatLon, nowMs: number): Partial<TrackOut> {
  const pred = predicted(t, nowMs);
  const a = P.smoothAlpha;
  const pos = { lat: a * centroid.lat + (1 - a) * pred.lat, lon: a * centroid.lon + (1 - a) * pred.lon };
  const dtMs = nowMs - t.updated_ms;
  if (dtMs < P.minVelocityDtMs) return { lat: pos.lat, lon: pos.lon, updated_ms: t.updated_ms };
  const { e, n } = enu(t, pos);
  const vE = e / (dtMs / 1000);
  const vN = n / (dtMs / 1000);
  const speed = Math.min(P.maxSpeedMps, Math.hypot(vE, vN));
  const heading = speed >= P.minHeadingSpeedMps ? normDeg((Math.atan2(vE, vN) * 180) / Math.PI) : t.heading_deg;
  return { lat: pos.lat, lon: pos.lon, speed_mps: speed, heading_deg: heading, updated_ms: nowMs };
}

/** Step 6: status machine (§5). */
function transition(t: TrackOut, lastEventMs: number, nowMs: number): TrackStatus {
  const quiet = nowMs - lastEventMs;
  switch (t.status) {
    case 'candidate':
      if (quiet > P.candidateCloseMs) return 'closed';
      return t.event_count >= P.activeMinEvents && t.confidence >= P.activeMinConfidence ? 'active' : 'candidate';
    case 'active':
      return quiet > P.dormantAfterMs ? 'dormant' : 'active';
    case 'dormant':
      return quiet > P.dormantCloseMs ? 'closed' : 'dormant';
    default:
      return t.status;
  }
}

/**
 * Two live tracks of the same campaign sitting on top of each other are one blaster that got
 * split (e.g. a cluster briefly fell outside the match radius). Keep the older track, move
 * the younger one's events to it, and close the younger.
 */
function dedupe(all: TrackOut[], meta: Map<bigint, { hash: string }>, assign: Map<bigint, bigint>) {
  const rank = (t: TrackOut) => (t.status === 'active' ? 0 : 1);
  // Age order: existing tracks by ascending id, then new ones (temp ids -1, -2, ...).
  const age = (t: TrackOut) => (t.id > 0n ? t.id : (1n << 62n) - t.id);
  const live = all
    .filter(t => t.status === 'active' || t.status === 'candidate')
    .sort((a, b) => rank(a) - rank(b) || (age(a) < age(b) ? -1 : age(a) > age(b) ? 1 : 0));
  for (let i = 0; i < live.length; i++) {
    const keep = live[i];
    if (keep.status === 'closed') continue;
    for (let j = i + 1; j < live.length; j++) {
      const drop = live[j];
      if (drop.status === 'closed') continue;
      if (meta.get(keep.id)!.hash !== meta.get(drop.id)!.hash) continue;
      if (dist(keep, drop) > P.dedupeRadiusM) continue;
      for (const [ev, tid] of assign) if (tid === drop.id) assign.set(ev, keep.id);
      keep.event_count += drop.event_count;
      keep.confidence = Math.max(keep.confidence, drop.confidence);
      drop.status = 'closed';
      drop.event_count = 0;
    }
  }
}

// Re-exported for tests / eval.
export { angleDiff, bearing };
