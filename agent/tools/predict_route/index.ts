// OWNER: Role 1 (route prediction). TypeScript port of the original Python tool so the agent
// can call it in-process.
//
//   predict_route(lat, lon, heading_deg, speed_mps, horizon_s)
//     -> { path: [[lat,lon],...], intercept: [lat,lon], eta_s: int, source: "osrm" | "straight_line" }   (INTERFACES.md §7)
//
// 1. Road-following: snap to the nearest road with OSRM, route toward a point straight ahead
//    along heading_deg, and walk that road geometry for speed_mps * horizon_s meters,
//    sampling a point every 15 s of travel.
// 2. If OSRM fails, times out, is rate-limited, or wanders off the heading (e.g. the only route
//    starts with a U-turn), fall back to a straight-line projection along heading_deg.
// 3. Intercept: the path point at ~65% of the horizon, so a patrol has time to get there;
//    eta_s is when the blaster reaches it.
//
// Env: OSRM_URL (self-hosted router), PREDICT_ROUTE_OFFLINE=1 (always straight line; the venue
// Wi-Fi drill). Both are read per call.
//
// Difference from the Python original: speed is capped at 40 m/s and the horizon at 900 s, because
// the model supplies these arguments and an absurd value would otherwise send OSRM a huge route.

import type { LatLon } from "../../src/types.js";
import type { PredictRouteOutput, ToolDef } from "../types.js";

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
}

export interface PredictRouteDeps {
  /** Fetch + parse JSON for a URL. Injectable for tests. */
  fetchJson?: (url: string) => Promise<unknown>;
  /** Force the straight-line projection (overrides PREDICT_ROUTE_OFFLINE). */
  offline?: boolean;
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

// ---- tool ----

const r6 = (p: LatLon): LatLon => [Math.round(p[0] * 1e6) / 1e6, Math.round(p[1] * 1e6) / 1e6];

export async function predictRoute(input: PredictRouteInput, deps: PredictRouteDeps = {}): Promise<PredictRouteOutput> {
  const { lat, lon } = input;
  const reported = Math.min(MAX_SPEED_MPS, Math.max(0, Number(input.speed_mps) || 0));
  const speed = reported >= MOVING_MPS ? Math.max(reported, MIN_MOVING_SPEED_MPS) : reported;
  const horizon = Math.min(MAX_HORIZON_S, Math.max(SAMPLE_S, Number(input.horizon_s) || 300));
  const heading = Number(input.heading_deg) || 0;
  const distM = speed * horizon;

  const offline = deps.offline ?? process.env.PREDICT_ROUTE_OFFLINE === "1";
  let source: "osrm" | "straight_line" = "straight_line";
  let line: LatLon[] | null = null;
  if (distM >= 1 && !offline) {
    try {
      line = await osrmRoadLine(lat, lon, heading, distM, deps.fetchJson ?? defaultFetchJson);
      if (line) source = "osrm";
    } catch {
      line = null; // timeout, rate limit, bad JSON: use the straight line
    }
  }
  if (!line) line = [[lat, lon], project([lat, lon], heading, distM)];

  const steps = Math.floor(horizon / SAMPLE_S);
  const path: LatLon[] = [];
  for (let i = 0; i <= steps; i++) path.push(walk(line, speed * SAMPLE_S * i));
  if (horizon % SAMPLE_S) path.push(walk(line, distM));
  const eta = Math.round(horizon * INTERCEPT_FRAC);
  const intercept = walk(line, speed * eta);
  return { path: path.map(r6), intercept: r6(intercept), eta_s: eta, source };
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
    const out = await predictRoute(input);
    ctx.memory.lastPrediction = out;
    return out;
  },
  summarize(out) {
    const [la, lo] = out.intercept;
    const how = out.source === "osrm" ? "along roads" : "straight-line";
    return `Predicted ${out.path.length}-point route (${how}); intercept at ${la.toFixed(4)}, ${lo.toFixed(4)} in ~${out.eta_s} s.`;
  },
};
