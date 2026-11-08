// Ported from Role 1's Python tests (TESTING.md §2h). Offline by default;
// PREDICT_ROUTE_LIVE=1 also queries the public OSRM router.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { bearing, haversine, lineLength, MIN_MOVING_SPEED_MPS, predictRoute } from "../tools/predict_route/index.js";
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
