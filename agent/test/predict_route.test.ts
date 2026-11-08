// Ported from Role 1's Python tests (TESTING.md §2h). Offline by default;
// PREDICT_ROUTE_LIVE=1 also queries the public OSRM router.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { bearing, fitMotion, haversine, lineLength, MIN_MOVING_SPEED_MPS, predictRoute, predictRouteTool, type TrailPoint } from "../tools/predict_route/index.js";
import type { LatLon } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
// Real Campbell Rd geometry (OpenStreetMap via OSRM), the same road the demo blaster drives.
const CAMPBELL: LatLon[] = JSON.parse(readFileSync(resolve(here, "../../sim/routes/campbell_long.json"), "utf8")).points;
const FIXTURE = JSON.parse(readFileSync(resolve(here, "../tools/predict_route/fixtures/osrm_campbell_east.json"), "utf8"));
const START: LatLon = [32.97888, -96.792119]; // Campbell Rd, west of Coit, heading east
const fixture = async () => FIXTURE;
const inp = (heading: number, speed: number, horizon: number) => ({
  lat: START[0], lon: START[1], heading_deg: heading, speed_mps: speed, horizon_s: horizon,
});

/** Distance from p to the Campbell Rd polyline (sampled every ~10 m). */
function distToRoad(p: LatLon): number {
  let best = Infinity;
  for (let i = 0; i < CAMPBELL.length - 1; i++) {
    const a = CAMPBELL[i], b = CAMPBELL[i + 1];
    const n = Math.max(1, Math.floor(haversine(a, b) / 10));
    for (let k = 0; k <= n; k++) {
      best = Math.min(best, haversine(p, [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]));
    }
  }
  return best;
}

test("predict_route: Campbell Rd east follows the road", async () => {
  const out = await predictRoute(inp(90, 11, 240), { fetchJson: fixture, offline: false });
  assert.equal(out.source, "osrm");
  assert.equal(out.path.length, 240 / 15 + 1); // one point per 15 s, including now
  for (const p of out.path) assert.ok(distToRoad(p) < 60, `${p} is off Campbell Rd`);
  assert.ok(out.path.at(-1)![1] > START[1] + 0.02, "moving east, not west");
});

test("predict_route: intercept at 65% of the horizon, eta matches", async () => {
  const out = await predictRoute(inp(90, 11, 300), { fetchJson: fixture, offline: false });
  assert.equal(out.eta_s, 195);
  const travelled = lineLength(out.path.slice(0, 195 / 15 + 1));
  assert.ok(Math.abs(travelled - 11 * 195) <= 60, `travelled ${travelled}`);
  assert.ok(haversine(out.intercept, out.path[13]) < 5);
});

test("predict_route: straight-line fallback when the router is down", async () => {
  const down = async () => {
    throw new Error("rate limited");
  };
  const out = await predictRoute(inp(90, 11, 300), { fetchJson: down, offline: false });
  assert.equal(out.source, "straight_line");
  const end = out.path.at(-1)!;
  assert.ok(Math.abs(haversine(START, end) - 3300) <= 5);
  assert.ok(Math.abs(bearing(START, end) - 90) <= 0.5);
  assert.equal(out.eta_s, 195);
});

test("predict_route: PREDICT_ROUTE_OFFLINE=1 never touches the network", async () => {
  const prev = process.env.PREDICT_ROUTE_OFFLINE;
  process.env.PREDICT_ROUTE_OFFLINE = "1";
  try {
    const boom = async () => {
      throw new Error("network used");
    };
    const out = await predictRoute(inp(0, 10, 60), { fetchJson: boom });
    assert.equal(out.source, "straight_line");
  } finally {
    if (prev === undefined) delete process.env.PREDICT_ROUTE_OFFLINE;
    else process.env.PREDICT_ROUTE_OFFLINE = prev;
  }
});

test("predict_route: rejects a route that starts with a U-turn", async () => {
  // Same geometry, but claim to be heading west: the road goes east, so fall back.
  const out = await predictRoute(inp(270, 11, 120), { fetchJson: fixture, offline: false });
  assert.equal(out.source, "straight_line");
  assert.ok(out.path.at(-1)![1] < START[1]);
});

test("predict_route: a parked target stays put", async () => {
  const out = await predictRoute(inp(90, 0, 300), { fetchJson: fixture, offline: false });
  assert.ok(out.path.every((p) => haversine(START, p) < 1));
  assert.deepEqual(out.intercept, [Math.round(START[0] * 1e6) / 1e6, Math.round(START[1] * 1e6) / 1e6]);
});

test("predict_route: model-supplied nonsense is clamped (speed <= 40 m/s, horizon <= 900 s)", async () => {
  const out = await predictRoute(inp(90, 5000, 100000), { offline: true });
  // 40 m/s * 900 s = 36 km at most
  assert.ok(haversine(START, out.path.at(-1)!) <= 36_100);
  assert.equal(out.path.length, 900 / 15 + 1);
});

test("predict_route: live OSRM (set PREDICT_ROUTE_LIVE=1)", { skip: process.env.PREDICT_ROUTE_LIVE !== "1" }, async () => {
  const out = await predictRoute(inp(90, 11, 240), { offline: false });
  assert.equal(out.source, "osrm");
  for (const p of out.path) assert.ok(distToRoad(p) < 60);
});

test("predict_route: a moving vehicle is never predicted slower than the minimum (new tracks under-estimate speed)", async () => {
  // Live: the tracker said 4 m/s for a car doing 11, so the warned path was ~1.2 km instead of ~3.3 km.
  const slow = await predictRoute(inp(90, 4, 300), { offline: true });
  assert.ok(Math.abs(haversine(START, slow.path.at(-1)!) - MIN_MOVING_SPEED_MPS * 300) <= 5, "predicted at the floor speed");
  const fast = await predictRoute(inp(90, 11, 300), { offline: true });
  assert.ok(Math.abs(haversine(START, fast.path.at(-1)!) - 11 * 300) <= 5, "a faster estimate is used as given");
});

test("predict_route: parked and walking speeds are not inflated", async () => {
  const parked = await predictRoute(inp(90, 0, 300), { offline: true });
  assert.ok(haversine(START, parked.path.at(-1)!) < 1);
  const walker = await predictRoute(inp(90, 1.4, 300), { offline: true });
  assert.ok(Math.abs(haversine(START, walker.path.at(-1)!) - 1.4 * 300) <= 5);
});

// ---- trail: direction and speed from recent track positions ----

const M_LON = 111_320 * Math.cos((START[0] * Math.PI) / 180);
/** A trail ending at START: `legs` of [seconds, eastMps, northMps], one point per second, with seeded noise. */
function trail(legs: [number, number, number][], noiseM = 0, seed = 7): TrailPoint[] {
  let r = seed;
  const rnd = () => ((r = (r * 16807) % 2147483647) / 2147483647 - 0.5) * 2 * noiseM;
  const steps: [number, number][] = [];
  for (const [secs, e, n] of legs) for (let i = 0; i < secs; i++) steps.push([e, n]);
  // Walk backwards from START so the last point is the current position.
  const pts: TrailPoint[] = [];
  let [la, lo] = START;
  for (let i = steps.length; i >= 0; i--) {
    pts.unshift({ lat: la + rnd() / 111_320, lon: lo + rnd() / M_LON, ms: 1_000_000 + i * 1000 });
    if (i > 0) { la -= steps[i - 1]![1] / 111_320; lo -= steps[i - 1]![0] / M_LON; }
  }
  return pts;
}

test("fitMotion: recovers direction and speed from a noisy trail", () => {
  const f = fitMotion(trail([[60, 11, 0]], 40))!;
  assert.ok(Math.abs(f.heading_deg - 90) < 10, `heading ${f.heading_deg}`);
  assert.ok(Math.abs(f.speed_mps - 11) < 1.5, `speed ${f.speed_mps}`);
  assert.equal(fitMotion(trail([[60, 0, 0]], 5)), null, "parked: no direction");
  assert.equal(fitMotion(trail([[1, 11, 0]])), null, "too few points");
});

test("predict_route: the trail overrules a noisy heading (seen live: 312 degrees for a car driving east)", async () => {
  const out = await predictRoute({ ...inp(312, 4, 240), trail: trail([[60, 11, 0]], 40) }, { fetchJson: fixture, offline: false });
  assert.equal(out.basis, "trail");
  assert.equal(out.source, "osrm");
  assert.ok(out.path.at(-1)![1] > START[1] + 0.02, "follows Campbell Rd east");
  for (const p of out.path) assert.ok(distToRoad(p) < 60, `${p} is off Campbell Rd`);
});

test("predict_route: mid-turn, the recent movement wins over the 60 s fit", async () => {
  // 50 s east, then 10 s north; the service already passes the new heading (north).
  const out = await predictRoute({ ...inp(0, 12, 120), trail: trail([[50, 12, 0], [10, 0, 12]]) }, { offline: true });
  assert.equal(out.basis, "track");
  assert.ok(Math.abs(bearing(START, out.path.at(-1)!)) < 5, "points north");
});

test("predict_route: no trail, or the trail ignored, behaves exactly as before", async () => {
  const a = await predictRoute(inp(90, 11, 240), { fetchJson: fixture, offline: false });
  const b = await predictRoute({ ...inp(90, 11, 240), trail: trail([[60, 11, 0]]) }, { fetchJson: fixture, offline: false, trailMode: "none" });
  assert.deepEqual(a.path, b.path);
  assert.equal(a.basis, "track");
});

test("predict_route tool: a trail in the model's arguments is ignored; only the service's counts", async () => {
  const ctx = { memory: {}, trackId: 1, now: () => 0, world: undefined as never };
  const out = await predictRouteTool.run({ ...inp(90, 11, 120), trail: trail([[60, 0, 11]]) } as never, ctx);
  assert.equal(out.basis, "track");
});

test("predict_route: snapping (PREDICT_ROUTE_SNAP=1) starts on the matched road, and is refused when it disagrees", async () => {
  const on = trail([[60, 11, 0]], 20);
  const snapAt: [number, number] = [32.97895, -96.7915];
  const routeUrls: string[] = [];
  const match = (lonOffset: number) => async (url: string) =>
    (url.includes("/route/") && routeUrls.push(url), url.includes("/match/"))
      ? {
          code: "Ok",
          matchings: [{ confidence: 0.9, distance: 650, geometry: { coordinates: [[snapAt[1] - lonOffset, snapAt[0]], [snapAt[1], snapAt[0]]] } }],
          tracepoints: on.map((_, i) => (i === on.length - 1 ? { location: [snapAt[1], snapAt[0]], matchings_index: 0, name: "Campbell Road" } : { location: [0, 0], matchings_index: 0 })),
        }
      : FIXTURE;
  const ok = await predictRoute({ ...inp(90, 11, 120), trail: on }, { fetchJson: match(0.007), offline: false, trailMode: "snap" });
  assert.equal(ok.basis, "snapped");
  assert.equal(ok.road, "Campbell Road");
  assert.ok(routeUrls[0]!.includes(`driving/${snapAt[1].toFixed(6)},${snapAt[0].toFixed(6)};`), "routes from the snapped position");
  // Road geometry running west while the trail goes east: not trusted, fall back to the fit.
  const bad = await predictRoute({ ...inp(90, 11, 120), trail: on }, { fetchJson: match(-0.007), offline: false, trailMode: "snap" });
  assert.equal(bad.basis, "trail");
});
