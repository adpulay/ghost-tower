// The offline road map (tools/predict_route/roadgraph.ts) and predict_route's use of it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { RoadGraph, defaultRoadGraph, type RoadData } from "../tools/predict_route/roadgraph.js";
import { bearing, haversine, lineLength, predictRoute, type TrailPoint } from "../tools/predict_route/index.js";
import type { LatLon } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));

// ---- a tiny synthetic map ------------------------------------------------------------------------------------
// Metres to degrees around (33, -96.8).
const M = 111_194.93;
const ML = M * Math.cos((33 * Math.PI) / 180);
const pt = (eastM: number, northM: number): [number, number] => [33 + northM / M, -96.8 + eastM / ML];

/**
 * A main road running east-west (class 2) with a side street (class 5) leaving north at x=1000 and a one-way
 * street (class 5, northbound only) crossing at x=2000. The main road is 4 km long and ends in a dead end.
 */
function toyMap(): RoadData {
  const nodes: [number, number][] = [];
  const id = (e: number, n: number) => {
    nodes.push(pt(e, n));
    return nodes.length - 1;
  };
  const main = [0, 500, 1000, 1500, 2000, 2500, 3000, 3500, 4000].map((e) => id(e, 0));
  const side = [main[2]!, id(1000, 300), id(1000, 600)];
  const oneway = [id(2000, -300), main[4]!, id(2000, 300)];
  return {
    bbox: [32.9, -96.9, 33.1, -96.7],
    nodes,
    ways: [
      [2, 0, main],
      [5, 0, side],
      [5, 1, oneway],
    ],
  };
}

test("roadgraph: goes straight on at a junction, onto the bigger road, never down the side street", () => {
  const g = new RoadGraph(toyMap());
  const line = g.line(pt(100, 5), 90, 3000)!;
  assert.ok(line, "found the road");
  assert.ok(line.every((p) => Math.abs((p[0] - 33) * M) < 2), "stayed on the main road");
  assert.ok(lineLength(line) >= 3000 - 5);
});

test("roadgraph: a heading that runs along the road picks the right carriageway (east vs west)", () => {
  const g = new RoadGraph(toyMap());
  const east = g.line(pt(1200, 3), 90, 600)!;
  const west = g.line(pt(1200, 3), 270, 600)!;
  assert.ok(east.at(-1)![1] > east[0]![1], "east heading goes east");
  assert.ok(west.at(-1)![1] < west[0]![1], "west heading goes west");
});

test("roadgraph: one-way streets are only walked the right way", () => {
  // A one-way (northbound) street on its own, so nothing else is near enough to be mistaken for it.
  const nodes: [number, number][] = [pt(0, 0), pt(0, 300), pt(0, 600)];
  const g = new RoadGraph({ bbox: [32.9, -96.9, 33.1, -96.7], nodes, ways: [[5, 1, [0, 1, 2]]] });
  const north = g.line(pt(0, 100), 0, 400)!;
  assert.ok(north, "northbound is allowed");
  assert.ok(north.at(-1)![0] > north[0]![0]);
  assert.equal(g.line(pt(0, 100), 180, 400), null, "southbound is not a road");
});

test("roadgraph: no U-turn at a dead end; the walk just ends there", () => {
  const g = new RoadGraph(toyMap());
  const line = g.line(pt(3800, 2), 90, 2000)!;
  assert.ok(Math.abs(lineLength(line) - 200) < 5, `walked ${Math.round(lineLength(line))} m to the dead end`);
});

test("roadgraph: nothing near, nothing returned", () => {
  const g = new RoadGraph(toyMap());
  assert.equal(g.line(pt(1000, 5000), 90, 500), null);
});

test("roadgraph: recent positions keep a noisy fix on the road it has been driving, not a parallel side street", () => {
  // Main road (class 2) with a parallel residential street 30 m north (class 5). The newest fix lands closer to
  // the side street, but the last 20 s of fixes all hug the main road.
  const nodes: [number, number][] = [pt(0, 0), pt(2000, 0), pt(0, 30), pt(2000, 30)];
  const g = new RoadGraph({ bbox: [32.9, -96.9, 33.1, -96.7], nodes, ways: [[2, 0, [0, 1]], [5, 0, [2, 3]]] });
  const newest = pt(1000, 22);
  assert.ok(g.snap(newest, 90, 80, 60)!.point[0] > 33 + 10 / M, "a single noisy fix snaps to the side street");
  const trail = [0, 1, 2, 3, 4, 5, 6].map((i) => ({ p: pt(1000 - (6 - i) * 40, i === 6 ? 22 : (i % 2 ? 8 : -6)), w: 0.5 ** ((6 - i) / 2) }));
  const line = g.line(newest, 90, 500, trail)!;
  assert.ok(Math.abs((line[1]![0] - 33) * M) < 2, "with the trail it stays on the main road");
});

// ---- the real map ---------------------------------------------------------------------------------------------

test("roadmap: the committed map loads and covers the demo route", () => {
  const g = defaultRoadGraph()!;
  assert.ok(g, "roads_richardson.json is present");
  const route: LatLon[] = JSON.parse(readFileSync(resolve(here, "../../sim/routes/demo.json"), "utf8")).points;
  let offRoad = 0;
  for (const p of route) if (!g.snap(p, 90, 60, 180)) offRoad++;
  assert.ok(offRoad <= 2, `${offRoad} of ${route.length} demo-route points are further than 60 m from any mapped road`);
});

const ROUTE: LatLon[] = JSON.parse(readFileSync(resolve(here, "../../sim/routes/demo.json"), "utf8")).points;
const CUM = [0];
for (let i = 1; i < ROUTE.length; i++) CUM.push(CUM[i - 1]! + haversine(ROUTE[i - 1]!, ROUTE[i]!));
const SPEED = 11;
const TURN_AT_M = 2257;
function carAt(d: number): LatLon {
  d = Math.min(Math.max(d, 0), CUM.at(-1)!);
  for (let i = 0; i < ROUTE.length - 1; i++) {
    if (CUM[i + 1]! >= d) {
      const f = (d - CUM[i]!) / (CUM[i + 1]! - CUM[i]!);
      return [ROUTE[i]![0] + f * (ROUTE[i + 1]![0] - ROUTE[i]![0]), ROUTE[i]![1] + f * (ROUTE[i + 1]![1] - ROUTE[i]![1])];
    }
  }
  return ROUTE.at(-1)!;
}

/** What the service passes at sim time t: a track that trails the car by 24 s, 25 m of position noise, 3 s apart. */
async function predictAt(t: number) {
  let r = 1234 + t;
  const rnd = () => ((r = (r * 1664525 + 1013904223) % 4294967296) / 4294967296 - 0.5) * 2 * 25;
  const trail: TrailPoint[] = [];
  for (let s = t - 24 - 60; s <= t - 24; s += 3) {
    const p = carAt(Math.max(0, s) * SPEED);
    trail.push({ lat: p[0] + rnd() / M, lon: p[1] + rnd() / (M * Math.cos((p[0] * Math.PI) / 180)), ms: s * 1000 });
  }
  const last = trail.at(-1)!;
  const recent = trail.filter((p) => last.ms - p.ms <= 8000);
  const given = bearing([recent[0]!.lat, recent[0]!.lon], [last.lat, last.lon]);
  return predictRoute({ lat: last.lat, lon: last.lon, heading_deg: given, speed_mps: SPEED, horizon_s: 300, trail }, { roads: defaultRoadGraph() });
}

test("roadmap: replaying demo-01 with a noisy, lagging track never leaves the map, hooks, or jumps (except at the turn)", async () => {
  let prev: LatLon | null = null;
  const jumps: string[] = [];
  for (let t = 90; t <= 440; t += 8) {
    const out = await predictAt(t);
    assert.equal(out.source, "roadmap", `t=${t}: ${out.source}`);
    const p = out.path;
    const mid = bearing(p[Math.floor(p.length / 2) - 1]!, p[Math.floor(p.length / 2)]!);
    const tail = bearing(p.at(-2)!, p.at(-1)!);
    const bend = Math.abs(((tail - mid + 540) % 360) - 180);
    // The old router-based paths ended in a hook of 50 to 90 degrees about a third of the time.
    assert.ok(bend <= 50, `t=${t}: the path bends ${Math.round(bend)} degrees at its end`);
    if (prev && haversine(prev, out.intercept) > 700) jumps.push(`t=${t} (${Math.round(haversine(prev, out.intercept))} m)`);
    prev = out.intercept;
  }
  // The only big swing is the real turn onto Coit Rd, which the lagging track cannot show before it gets there.
  assert.equal(jumps.length, 1, `jumps over 700 m: ${jumps.join(", ")}`);
});

test("roadmap: follows Campbell Rd east before the turn and Coit Rd north once the track has rounded it", async () => {
  const before = await predictAt(180); // car at ~1,980 m, well before the corner
  assert.ok(before.intercept[0] < 32.98 && before.intercept[1] > -96.76, `east, got ${before.intercept}`);
  const after = await predictAt(262); // the track reached the corner at ~t=229
  assert.ok(after.intercept[0] > 32.995 && Math.abs(after.intercept[1] - -96.7677) < 0.004, `north on Coit, got ${after.intercept}`);
});
