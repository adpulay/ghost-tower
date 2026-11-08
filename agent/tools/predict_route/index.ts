// OWNER: Role 1 (route prediction). TypeScript port of the original Python tool so the agent
// can call it in-process.
//
//   predict_route(lat, lon, heading_deg, speed_mps, horizon_s)
//     -> { path: [[lat,lon],...], intercept: [lat,lon], eta_s: int, source: "osrm" | "straight_line" }   (INTERFACES.md §7)
//
// 1. Road map (default): walk the offline OpenStreetMap road graph (roadgraph.ts, roads_richardson.json).
//    Snap to the road the vehicle is on (the one that best explains its last ~20 s of positions and runs the
//    way it is heading), then follow it, taking the straightest exit at each junction, for speed_mps * horizon_s
//    meters, sampling a point every 15 s of travel. No network, no rate limits, no off-road target to snap to.
// 2. If the position is off the map or on no road heading that way, and the network is allowed: route with OSRM
//    toward a point straight ahead along heading_deg (rejected if it starts with a U-turn).
// 3. Otherwise a straight-line projection along heading_deg.
// 4. Intercept: the path point at ~65% of the horizon, so a patrol has time to get there;
//    eta_s is when the blaster reaches it.
//
// Env: PREDICT_ROUTE_ROADMAP=0 (don't use the road map), OSRM_URL (self-hosted router), PREDICT_ROUTE_OFFLINE=1
// (no network: the road map still works; only the OSRM step is skipped). Read per call.
//
// Difference from the Python original: speed is capped at 40 m/s and the horizon at 900 s, because
// the model supplies these arguments and an absurd value would otherwise send OSRM a huge route.

import { appendFileSync } from "node:fs";
import type { LatLon } from "../../src/types.js";
import type { PredictRouteOutput, ToolDef } from "../types.js";
import { defaultRoadGraph, type RoadGraph } from "./roadgraph.js";

const EARTH_R = 6371008.8;
const SAMPLE_S = 15;
const INTERCEPT_FRAC = 0.65;
const TIMEOUT_MS = 4000;
/** OSRM geometry whose first ~150 m points further than this from heading_deg is rejected. */
const MAX_HEADING_DEV_DEG = 75;
const USER_AGENT = "ghost-tower-predict-route/0.1";
const MAX_SPEED_MPS = 40;
/** At or above this a track counts as moving; below it the speed is used as given (parked, walking). */
const MOVING_MPS = 2;
/**
 * A moving vehicle is predicted at no less than this (about 29 km/h). New tracks under-estimate speed
 * (seen live: 4 m/s for a car doing 11), which made the predicted path, and so the warned area, far too
 * short: the first warning reached 2 phones. Longer is the safe side for a warning.
 */
export const MIN_MOVING_SPEED_MPS = 8;
const MAX_HORIZON_S = 900;

export interface PredictRouteInput {
  lat: number;
  lon: number;
  heading_deg: number;
  speed_mps: number;
  horizon_s: number;
  /**
   * Recent track positions (oldest first, `ms` on the track's own clock). When given, the start,
   * direction and speed come from snapping this trail to the road network instead of trusting the
   * single noisy heading/speed above. Supplied by the agent service, never by the model.
   */
  trail?: TrailPoint[];
  /**
   * The speed the previous prediction for this track used. A speed fitted from the trail may move at most
   * SPEED_STEP_DOWN..SPEED_STEP_UP times it per call: the live track's fitted speed swung between 6 and 20 m/s
   * for a car doing 11, which stretched and shrank the predicted path by kilometres from one refresh to the next.
   * Supplied by the agent service, never by the model.
   */
  speed_hint?: number;
}

/** Limits on how far a trail-fitted speed may move from the previous one, per prediction. */
export const SPEED_STEP_DOWN = 0.75;
export const SPEED_STEP_UP = 1.33;

export interface TrailPoint {
  lat: number;
  lon: number;
  ms: number;
}

export interface PredictRouteDeps {
  /** Fetch + parse JSON for a URL. Injectable for tests. */
  fetchJson?: (url: string) => Promise<unknown>;
  /** No network (overrides PREDICT_ROUTE_OFFLINE). The road map, if used, still works. */
  offline?: boolean;
  /** How to use `trail`: snap to roads (default), least-squares fit only, or ignore it. For evals. */
  trailMode?: "snap" | "fit" | "none";
  /** Seconds the track lags the blaster (default REPORT_LAG_S; only applied when a trail is given). */
  lagS?: number;
  /**
   * The offline road map to walk. Default: the committed Richardson map, but only when the caller injects neither
   * `fetchJson` nor `offline` (those mean "test the router / straight-line paths"). null disables the map.
   */
  roads?: RoadGraph | null;
}

// ---- geometry ----

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;
const mod = (a: number, n: number) => ((a % n) + n) % n;

export function haversine(a: LatLon, b: LatLon): number {
  const la1 = rad(a[0]), lo1 = rad(a[1]), la2 = rad(b[0]), lo2 = rad(b[1]);
  const h = Math.sin((la2 - la1) / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin((lo2 - lo1) / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Bearing in degrees, 0 = north, clockwise (flat-earth, fine at city scale). */
export function bearing(a: LatLon, b: LatLon): number {
  const mlat = rad(1) * EARTH_R;
  const mlon = mlat * Math.cos(rad(a[0]));
  const e = (b[1] - a[1]) * mlon;
  const n = (b[0] - a[0]) * mlat;
  return mod(deg(Math.atan2(e, n)), 360);
}

export function project(p: LatLon, headingDeg: number, distM: number): LatLon {
  const mlat = rad(1) * EARTH_R;
  const mlon = mlat * Math.cos(rad(p[0]));
  const h = rad(headingDeg);
  return [p[0] + (Math.cos(h) * distM) / mlat, p[1] + (Math.sin(h) * distM) / mlon];
}

const angleDiff = (a: number, b: number) => Math.abs(mod(b - a + 180, 360) - 180);

/** Point dist_m along a polyline (clamped to its end). */
export function walk(line: LatLon[], distM: number): LatLon {
  let left = distM;
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i], b = line[i + 1];
    const seg = haversine(a, b);
    if (seg >= left && seg > 0) {
      const f = left / seg;
      return [a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])];
    }
    left -= seg;
  }
  return line[line.length - 1];
}

export function lineLength(line: LatLon[]): number {
  let total = 0;
  for (let i = 0; i < line.length - 1; i++) total += haversine(line[i], line[i + 1]);
  return total;
}

// ---- OSRM ----

async function defaultFetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`OSRM HTTP ${res.status}`);
  return res.json();
}

interface OsrmResponse {
  code?: string;
  routes?: { geometry: { coordinates: [number, number][] } }[];
}

/** Road geometry from the snapped start, heading roughly along heading_deg, >= dist_m long. */
export async function osrmRoadLine(
  lat: number,
  lon: number,
  headingDeg: number,
  distM: number,
  fetchJson: (url: string) => Promise<unknown>,
): Promise<LatLon[] | null> {
  const base = process.env.OSRM_URL ?? "https://router.project-osrm.org";
  const target = project([lat, lon], headingDeg, distM);
  const url =
    `${base}/route/v1/driving/${lon.toFixed(6)},${lat.toFixed(6)};${target[1].toFixed(6)},${target[0].toFixed(6)}` +
    `?overview=full&geometries=geojson&bearings=${mod(Math.round(headingDeg), 360)},60;&continue_straight=true`;
  const data = (await fetchJson(url)) as OsrmResponse;
  if (data.code !== "Ok" || !data.routes?.length) return null;
  const line: LatLon[] = data.routes[0].geometry.coordinates.map((c) => [c[1], c[0]]);
  if (line.length < 2) return null;
  // Reject routes that start by going the wrong way (U-turn to reach the target).
  if (angleDiff(bearing(line[0], walk(line, 150)), headingDeg) > MAX_HEADING_DEV_DEG) return null;
  // If the road ends early, continue straight along the last segment's direction.
  const length = lineLength(line);
  if (length < distM) {
    const lastB = bearing(line[line.length - 2], line[line.length - 1]);
    line.push(project(line[line.length - 1], lastB, distM - length));
  }
  return line;
}

// ---- trail: motion fit and road snapping ----

/** Trail points older than this (track clock) are ignored. Override with PREDICT_ROUTE_TRAIL_S. */
export const TRAIL_WINDOW_MS = 60_000;
const trailWindowMs = () => Number(process.env.PREDICT_ROUTE_TRAIL_S ?? TRAIL_WINDOW_MS / 1000) * 1000;
/** OSRM's public server refuses larger map-matching search radii ("TooBig" at 50 m). Self-hosted: OSRM_MATCH_RADIUS_M. */
const MATCH_RADIUS_M = () => Number(process.env.OSRM_MATCH_RADIUS_M ?? 40);
/** OSRM's public server answers "TooBig" above roughly a dozen coordinates per match request. */
const MAX_TRAIL_POINTS = 10;
/** Below this much movement over the trail, there is no direction to snap. */
const MIN_TRAIL_SPAN_M = 60;
const MIN_MATCH_CONFIDENCE = 0.5;
/** How much recent trail the road map weighs when deciding which road the vehicle is on. */
const ROAD_EVIDENCE_MS = 20_000;
/** The trail replaces the given heading only when they differ by more than this. */
const TRAIL_OVERRULE_DEG = () => Number(process.env.PREDICT_ROUTE_OVERRULE_DEG ?? 90);
/** A trail counts as having turned when two legs leave at most this share of one line's squared error... */
const TURN_SSE_RATIO = 0.5;
/** ...and the legs point at least this far apart. */
const TURN_MIN_DEG = 30;
/** The snapped road's direction must agree with the trail's own fitted direction. */
const MAX_MATCH_FIT_DEV_DEG = 45;
/**
 * A track trails the blaster: phones report after their 5-10 s on 2G plus delivery, and the module
 * smooths over a window. Measured against simulator ground truth (eval/src/route_accuracy.ts):
 * ~24 s / ~250 m behind, only 25-65 m to the side. Starting the path that far ahead helped at +30 s
 * but hurt at +60/+120 s (it pushes the start past turns not yet seen), so it is off by default.
 * PREDICT_ROUTE_LAG_S sets it (seconds; only applied with a trail).
 */
export const REPORT_LAG_S = 0;
/** Road direction is measured over the last stretch of the snapped geometry. */
const HEADING_BACK_M = 120;

function recentTrail(trail: readonly TrailPoint[], windowMs = trailWindowMs()): TrailPoint[] {
  const sorted = [...trail].filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon) && Number.isFinite(p.ms)).sort((a, b) => a.ms - b.ms);
  if (!sorted.length) return [];
  const last = sorted[sorted.length - 1]!.ms;
  const out: TrailPoint[] = [];
  for (const p of sorted) {
    if (last - p.ms > windowMs) continue;
    if (out.length && out[out.length - 1]!.ms === p.ms) out[out.length - 1] = p;
    else out.push(p);
  }
  return out;
}

export interface Motion {
  heading_deg: number;
  speed_mps: number;
  span_m: number;
}

interface LinFit {
  vE: number;
  vN: number;
  /** Sum of squared residuals, m². */
  sse: number;
  tSpanS: number;
}

/** Least-squares east/north velocity of points against time (local flat plane). Null below 2 points. */
function linFit(pts: readonly TrailPoint[]): LinFit | null {
  if (pts.length < 2) return null;
  const o = pts[0]!;
  const mlat = rad(1) * EARTH_R;
  const mlon = mlat * Math.cos(rad(o.lat));
  const t = pts.map((p) => (p.ms - o.ms) / 1000);
  const e = pts.map((p) => (p.lon - o.lon) * mlon);
  const n = pts.map((p) => (p.lat - o.lat) * mlat);
  const tm = t.reduce((s, x) => s + x, 0) / t.length;
  const varT = t.reduce((s, x) => s + (x - tm) ** 2, 0);
  if (varT <= 0) return null;
  let sse = 0;
  const fit1 = (ys: number[]) => {
    const ym = ys.reduce((s, y) => s + y, 0) / ys.length;
    const v = t.reduce((s, x, i) => s + (x - tm) * (ys[i]! - ym), 0) / varT;
    for (let i = 0; i < ys.length; i++) sse += (ys[i]! - (ym + v * (t[i]! - tm))) ** 2;
    return v;
  };
  const vE = fit1(e), vN = fit1(n);
  return { vE, vN, sse, tSpanS: t[t.length - 1]! - t[0]! };
}

function toMotion(f: LinFit | null, minPoints: number, count: number): Motion | null {
  if (!f || count < minPoints || f.tSpanS < 10) return null; // under ~10 s of history
  const speed = Math.hypot(f.vE, f.vN);
  const span = speed * f.tSpanS;
  if (span < MIN_TRAIL_SPAN_M) return null;
  return { heading_deg: mod(deg(Math.atan2(f.vE, f.vN)), 360), speed_mps: speed, span_m: span };
}

/**
 * Least-squares velocity over the trail (east/north metres against time), so one noisy fix can't
 * flip the direction. Null when there are too few points or too little movement.
 */
export function fitMotion(trail: readonly TrailPoint[], windowMs?: number): Motion | null {
  const pts = recentTrail(trail, windowMs);
  return toMotion(linFit(pts), 3, pts.length);
}

/**
 * Direction of the latest straight stretch of the trail. A single fit across a turn averages the two
 * roads into a diagonal (seen live after the Coit Rd turn: a straight-line route heading northeast).
 * So try every split into "before" and "after"; if two lines explain the trail much better than one
 * and they point TURN_MIN_DEG or more apart, it turned, and only the part after the turn counts.
 * `turned` with a null `fit` means the turn is too recent to have its own fit (fewer than 3 points
 * after it): the caller should use the heading it was given. Works on point counts, not seconds, so
 * it behaves the same whether the track updates every 3 s or every 12 s (live at 4x).
 */
export function latestLeg(trail: readonly TrailPoint[]): { fit: Motion | null; turned: boolean } {
  const pts = recentTrail(trail);
  const full = linFit(pts);
  const whole = toMotion(full, 3, pts.length);
  if (!full || pts.length < 4) return { fit: whole, turned: false };
  let best: { sse: number; a: LinFit; b: LinFit; bCount: number } | null = null;
  for (let k = 2; k <= pts.length - 1; k++) {
    // Both legs share the corner point, so neither leg jumps.
    const a = linFit(pts.slice(0, k));
    const bPts = pts.slice(k - 1);
    const b = linFit(bPts);
    if (!a || !b) continue;
    if (!best || a.sse + b.sse < best.sse) best = { sse: a.sse + b.sse, a, b, bCount: bPts.length };
  }
  if (!best || best.sse > TURN_SSE_RATIO * full.sse) return { fit: whole, turned: false };
  const dirA = mod(deg(Math.atan2(best.a.vE, best.a.vN)), 360);
  const dirB = mod(deg(Math.atan2(best.b.vE, best.b.vN)), 360);
  if (Math.hypot(best.a.vE, best.a.vN) < MOVING_MPS || Math.hypot(best.b.vE, best.b.vN) < MOVING_MPS) return { fit: whole, turned: false };
  if (angleDiff(dirA, dirB) < TURN_MIN_DEG) return { fit: whole, turned: false };
  return { fit: toMotion(best.b, 3, best.bCount), turned: true };
}

interface OsrmMatchResponse {
  code?: string;
  matchings?: { confidence: number; distance: number; geometry: { coordinates: [number, number][] } }[];
  tracepoints?: ({ location: [number, number]; matchings_index: number; name?: string } | null)[];
}

export interface SnappedMotion {
  lat: number;
  lon: number;
  heading_deg: number;
  speed_mps: number;
  confidence: number;
  road?: string;
}

/**
 * Snap the trail to roads with OSRM's map-matching service and read off where the blaster is now
 * (on the road), which way that road runs, and how fast it has been covered. Null when the trail is
 * too short, OSRM can't match it confidently, or the snapped direction disagrees with the trail.
 */
export async function snapTrail(trail: readonly TrailPoint[], fetchJson: (url: string) => Promise<unknown>): Promise<SnappedMotion | null> {
  let pts = recentTrail(trail);
  const fit = fitMotion(pts);
  if (!fit) return null;
  if (pts.length > MAX_TRAIL_POINTS) {
    const step = (pts.length - 1) / (MAX_TRAIL_POINTS - 1);
    pts = Array.from({ length: MAX_TRAIL_POINTS }, (_, i) => pts[Math.round(i * step)]!);
  }
  // OSRM wants strictly increasing whole-second timestamps.
  const ts: number[] = [];
  for (const p of pts) ts.push(Math.max(Math.floor(p.ms / 1000), (ts[ts.length - 1] ?? -Infinity) + 1));
  const base = process.env.OSRM_URL ?? "https://router.project-osrm.org";
  const url =
    `${base}/match/v1/driving/${pts.map((p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join(";")}` +
    `?timestamps=${ts.join(";")}&radiuses=${pts.map(() => MATCH_RADIUS_M()).join(";")}` +
    `&geometries=geojson&overview=full&gaps=ignore&tidy=true`;
  const data = (await fetchJson(url)) as OsrmMatchResponse;
  if (data.code !== "Ok" || !data.matchings?.length || !data.tracepoints?.length) return null;

  let lastIdx = -1;
  for (let i = data.tracepoints.length - 1; i >= 0; i--) if (data.tracepoints[i]) { lastIdx = i; break; }
  if (lastIdx < 0) return null;
  const tp = data.tracepoints[lastIdx]!;
  const m = data.matchings[tp.matchings_index];
  if (!m || m.confidence < MIN_MATCH_CONFIDENCE) return null;
  const line: LatLon[] = m.geometry.coordinates.map((c) => [c[1], c[0]]);
  if (line.length < 2) return null;
  const end: LatLon = [tp.location[1], tp.location[0]];

  // Direction of the road over its last stretch up to the snapped position.
  let endIdx = 0;
  for (let i = 1; i < line.length; i++) if (haversine(line[i]!, end) < haversine(line[endIdx]!, end)) endIdx = i;
  const upToEnd = [...line.slice(0, endIdx + 1), end].reverse();
  const back = walk(upToEnd, Math.min(HEADING_BACK_M, lineLength(upToEnd)));
  if (haversine(back, end) < 20) return null;
  const heading = bearing(back, end);
  if (angleDiff(heading, fit.heading_deg) > MAX_MATCH_FIT_DEV_DEG) return null;

  let firstIdx = 0;
  while (firstIdx < lastIdx && (!data.tracepoints[firstIdx] || data.tracepoints[firstIdx]!.matchings_index !== tp.matchings_index)) firstIdx++;
  const dt = ts[lastIdx]! - ts[firstIdx]!;
  const speed = dt > 0 ? m.distance / dt : fit.speed_mps;
  return { lat: end[0], lon: end[1], heading_deg: heading, speed_mps: speed, confidence: m.confidence, road: tp.name || undefined };
}

// ---- tool ----

const r6 = (p: LatLon): LatLon => [Math.round(p[0] * 1e6) / 1e6, Math.round(p[1] * 1e6) / 1e6];

/**
 * Diagnostics: with PREDICT_ROUTE_LOG=<file>, every call appends one JSON line (its input and the result's start,
 * intercept, source, basis and speed) so a bad path seen live can be replayed exactly.
 */
function logCall(input: PredictRouteInput, out: PredictRouteOutput): void {
  const file = process.env.PREDICT_ROUTE_LOG;
  if (!file) return;
  try {
    appendFileSync(file, JSON.stringify({ wall: Date.now(), input, out: { start: out.path[0], second: out.path[1], intercept: out.intercept, source: out.source, basis: out.basis, speed_mps: out.speed_mps } }) + "\n");
  } catch {
    // diagnostics must never break a prediction
  }
}

export async function predictRoute(input: PredictRouteInput, deps: PredictRouteDeps = {}): Promise<PredictRouteOutput> {
  const out = await predictRouteImpl(input, deps);
  logCall(input, out);
  return out;
}

async function predictRouteImpl(input: PredictRouteInput, deps: PredictRouteDeps = {}): Promise<PredictRouteOutput> {
  let lat = Number(input.lat), lon = Number(input.lon);
  let reported = Math.min(MAX_SPEED_MPS, Math.max(0, Number(input.speed_mps) || 0));
  let heading = Number(input.heading_deg) || 0;
  const horizon = Math.min(MAX_HORIZON_S, Math.max(SAMPLE_S, Number(input.horizon_s) || 300));
  const offline = deps.offline ?? process.env.PREDICT_ROUTE_OFFLINE === "1";
  const fetchJson = deps.fetchJson ?? defaultFetchJson;
  const roads = deps.roads !== undefined ? deps.roads : deps.fetchJson === undefined && deps.offline === undefined ? defaultRoadGraph() : null;

  // Prefer the trail over the single heading/speed: its least-squares direction and speed (or, when
  // enabled, the trail snapped to roads). On simulator ground truth this cut the median error at
  // +60 s from 572 m to 403 m and at +120 s from 1,326 m to 758 m (eval/src/route_accuracy.ts).
  let basis: PredictRouteOutput["basis"] = "track";
  let road: string | undefined;
  // Snapping is opt-in: on the public OSRM server (40 m radius cap, ~10 points) it matched about a
  // third of trails and did not beat the plain fit. Worth trying with a self-hosted OSRM.
  const trailMode = deps.trailMode ?? (process.env.PREDICT_ROUTE_SNAP === "1" ? "snap" : "fit");
  let usedTrailSpeed = false;
  if (input.trail?.length && trailMode !== "none") {
    // Only the stretch since the last turn; if the turn is too recent to fit, the given heading
    // (the service passes the last few seconds of movement) is the best we have.
    const { fit } = latestLeg(input.trail);
    // Only overrule the given heading when it is clearly wrong (pointing well away from where the
    // track has gone, or no speed to speak of). Live at 4x, a fit that merely differs did worse.
    const overrule = !!fit && (reported < MOVING_MPS || angleDiff(fit.heading_deg, heading) > TRAIL_OVERRULE_DEG());
    let snapped: SnappedMotion | null = null;
    if (fit && trailMode === "snap" && !offline) {
      try {
        snapped = await snapTrail(input.trail, fetchJson);
      } catch {
        snapped = null;
      }
    }
    if (snapped) {
      [lat, lon, heading, reported, road, basis] = [snapped.lat, snapped.lon, snapped.heading_deg, Math.min(MAX_SPEED_MPS, snapped.speed_mps), snapped.road, "snapped"];
    } else {
      // The heading and the speed are separate decisions. The heading stays the given one unless it is clearly
      // wrong (above), but the trail's speed is far steadier than the track row's, which swings between 0 and 30
      // m/s for a car doing 11 and stretches or shrinks the predicted path by kilometres from one refresh to the next.
      // It comes from the whole-trail fit, not the latest leg: legs are short and noisy, and a spurious split
      // leaves the leg too short to fit at all.
      const whole = fitMotion(input.trail);
      if (whole) {
        reported = Math.min(MAX_SPEED_MPS, whole.speed_mps);
        usedTrailSpeed = true;
      }
      if (fit && overrule) [heading, basis] = [fit.heading_deg, "trail"];
    }
    const hint = Number(input.speed_hint);
    if ((usedTrailSpeed || basis === "snapped") && Number.isFinite(hint) && hint >= MOVING_MPS) {
      reported = Math.min(hint * SPEED_STEP_UP, Math.max(hint * SPEED_STEP_DOWN, reported));
    }
  }
  const speed = reported >= MOVING_MPS ? Math.max(reported, MIN_MOVING_SPEED_MPS) : reported;
  const lagS = basis === "track" ? 0 : Math.max(0, deps.lagS ?? Number(process.env.PREDICT_ROUTE_LAG_S ?? REPORT_LAG_S));
  const lagM = speed >= MOVING_MPS ? speed * lagS : 0;
  const distM = lagM + speed * horizon;

  let source: "roadmap" | "osrm" | "straight_line" = "straight_line";
  let line: LatLon[] | null = null;
  if (roads && distM >= 1) {
    // Which way the road runs is read from the last few seconds of movement: the road map keeps a noisy fix on the
    // right road, and this reacts to a turn as soon as the track has rounded the corner (the 60 s fit takes ~30 s
    // longer). Without a usable short trail, the heading from above is used.
    const wholeFit = input.trail?.length && trailMode !== "none" ? fitMotion(input.trail) : null;
    const roadHeading = wholeFit && speed >= MOVING_MPS ? wholeFit.heading_deg : heading;
    // The last ~20 s of positions, newest weighted most (half-life 5 s): the road is the one that explains them all.
    const rt = input.trail?.length && trailMode !== "none" ? recentTrail(input.trail, ROAD_EVIDENCE_MS) : [];
    const lastMs = rt.length ? rt[rt.length - 1]!.ms : 0;
    const evidence = rt.length >= 3 ? rt.map((q) => ({ p: [q.lat, q.lon] as LatLon, w: 0.5 ** ((lastMs - q.ms) / 12000) })) : undefined;
    const longFit = input.trail?.length && trailMode !== "none" ? fitMotion(input.trail) : null;
    line = roads.line([lat, lon], roadHeading, distM, evidence, longFit?.heading_deg);
    if (line) {
      source = "roadmap";
      const length = lineLength(line);
      // A dead end or the edge of the map: carry on straight along the last stretch.
      if (length < distM) {
        const lastB = bearing(line[line.length - 2]!, line[line.length - 1]!);
        line.push(project(line[line.length - 1]!, lastB, distM - length));
      }
    }
  }
  if (!line && distM >= 1 && !offline) {
    try {
      line = await osrmRoadLine(lat, lon, heading, distM, fetchJson);
      if (line) source = "osrm";
    } catch {
      line = null; // timeout, rate limit, bad JSON: use the straight line
    }
  }
  if (!line) line = [[lat, lon], project([lat, lon], heading, distM)];

  const steps = Math.floor(horizon / SAMPLE_S);
  const path: LatLon[] = [];
  for (let i = 0; i <= steps; i++) path.push(walk(line, lagM + speed * SAMPLE_S * i));
  if (horizon % SAMPLE_S) path.push(walk(line, distM));
  const eta = Math.round(horizon * INTERCEPT_FRAC);
  const intercept = walk(line, lagM + speed * eta);
  return { path: path.map(r6), intercept: r6(intercept), eta_s: eta, source, basis, speed_mps: Math.round(speed * 100) / 100, ...(road ? { road } : {}) };
}

export const predictRouteTool: ToolDef<PredictRouteInput, PredictRouteOutput> = {
  name: "predict_route",
  description:
    "Predict the blaster's path for the next horizon_s seconds (following roads when the router is reachable) and suggest an intercept point.",
  parameters: {
    type: "object",
    properties: {
      lat: { type: "number" },
      lon: { type: "number" },
      heading_deg: { type: "number", description: "0 = north, clockwise" },
      speed_mps: { type: "number" },
      horizon_s: { type: "integer", description: "Seconds ahead, normally 300" },
    },
    required: ["lat", "lon", "heading_deg", "speed_mps", "horizon_s"],
  },
  async run(input, ctx) {
    // The trail comes from the service (ctx), never from the model's arguments.
    const out = await predictRoute({ ...input, trail: ctx.trail });
    ctx.memory.lastPrediction = out;
    return out;
  },
  summarize(out) {
    const [la, lo] = out.intercept;
    const how = out.source === "roadmap" || out.source === "osrm" ? (out.basis === "snapped" ? `along roads, snapped to ${out.road ?? "the road"}` : "along roads") : "straight-line";
    return `Predicted ${out.path.length}-point route (${how}); intercept at ${la.toFixed(4)}, ${lo.toFixed(4)} in ~${out.eta_s} s.`;
  },
};
