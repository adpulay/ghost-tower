import assert from "node:assert/strict";
import { test } from "node:test";
import { MockPolicy } from "../src/llm/mockPolicy.js";
import { runScenario } from "../src/runScenario.js";
import { SCENARIOS } from "../src/scenarios.js";
import {
  AgentService, DIRECTION_TOLERANCE_DEG, FIRST_WARNING_MAX_WAIT_MS, directionReliable,
} from "../src/service.js";
import { MemoryWorld } from "../src/world/memory.js";
import type { Track } from "../src/types.js";

// Scenario runs must be deterministic and offline: no calls to the public OSRM router.
process.env.PREDICT_ROUTE_OFFLINE ??= "1";

test("demo-01: investigates on active, replans after the Coit Rd turn, prediction updates", async () => {
  const run = await runScenario(SCENARIOS["demo-01"], new MockPolicy());
  const traces = run.world.traces;
  const firstPlan = traces.find((t) => t.kind === "plan")!;
  assert.ok((firstPlan.ts_ms - run.startMs) / 1000 <= 30, "first trace within ~10 s of going active at 20 s");
  const replans = traces.filter((t) => t.kind === "replan");
  assert.equal(replans.length, 1);
  const replanS = (replans[0].ts_ms - run.startMs) / 1000;
  // the turn starts at 90 s and the track heading swings over ~25 s (TURN_RAMP_S)
  assert.ok(replanS > 105 && replanS < 135, `replan at ${replanS}s`);
  const pred = run.world.predictions.get(1)!;
  const path = JSON.parse(pred.path_json) as [number, number][];
  assert.ok(path.at(-1)![0] > path[0][0], "final prediction points north after the turn");
  assert.ok(run.world.alerts.length >= 2, "warned original and new path");
});

test("stopgo-like: a parked track's heading noise does not trigger replans", async () => {
  const sc = structuredClone(SCENARIOS["demo-01"]);
  sc.tracks[0].legs = [
    { t: 0, heading_deg: 90, speed_mps: 11 },
    { t: 60, heading_deg: 200, speed_mps: 0 },
  ];
  sc.durationS = 120;
  const run = await runScenario(sc, new MockPolicy());
  assert.equal(run.world.traces.filter((t) => t.kind === "replan").length, 0);
});

test("offon-01: dormant summary, then re-investigation links the same campaign", async () => {
  const run = await runScenario(SCENARIOS["offon-01"], new MockPolicy());
  assert.ok(run.world.traces.some((t) => t.kind === "summary" && /dormant/.test(t.text)));
  assert.equal(run.runs.filter((r) => r.mode === "investigate").length, 2);
  assert.equal(run.world.campaigns.length, 1);
});

test("twin-01: two tracks, two campaigns, never cross-linked", async () => {
  const run = await runScenario(SCENARIOS["twin-01"], new MockPolicy());
  const c1 = run.world.campaigns.find((c) => c.id === run.world.tracks.get(1)!.campaign_id)!;
  const c2 = run.world.campaigns.find((c) => c.id === run.world.tracks.get(2)!.campaign_id)!;
  assert.equal(c1.brand, "TxTag");
  assert.equal(c2.brand, "Chase");
});


// ---- the first warning must not be aimed before we know which way the blaster is going ----

const T0 = Date.UTC(2026, 10, 8, 16, 0, 0);
const LAT = 32.9785;
const M_PER_DEG_LON = 111_320 * Math.cos((LAT * Math.PI) / 180);

/** A track the way the tracker reports it: `speed`/`heading` as claimed, position moving east at `eastMps`. */
function trackAt(sec: number, o: { speed: number; heading: number; eastMps: number }): Track {
  return {
    id: 5, lat: LAT, lon: -96.79 + (o.eastMps * sec) / M_PER_DEG_LON, heading_deg: o.heading, speed_mps: o.speed,
    confidence: 0.9, event_count: 12, status: "active", campaign_id: 0, updated_ms: T0 + sec * 1000,
  };
}

async function drive(secs: number, o: { speed: number; heading: number; eastMps: number }) {
  let now = T0;
  const w = new MemoryWorld(() => now);
  const svc = new AgentService(w, new MockPolicy(), { now: () => now });
  let firstPlanSec: number | null = null;
  for (let s = 0; s < secs; s++) {
    w.driverUpsertTrack(trackAt(s, o));
    await svc.tick();
    await svc.idle();
    if (firstPlanSec === null && w.traces.some((t) => t.kind === "plan")) firstPlanSec = s;
    now += 1000;
  }
  return { firstPlanSec, w };
}

test("directionReliable: needs movement, a window of history, and a heading that matches the displacement", () => {
  const pos = (n: number, eastMps: number) => Array.from({ length: n }, (_, i) => ({ ms: T0 + i * 1000, lat: LAT, lon: -96.79 + (eastMps * i) / M_PER_DEG_LON }));
  const now = T0 + 8_000;
  const east = { lat: LAT, lon: -96.79 + (15 * 8) / M_PER_DEG_LON };
  assert.equal(directionReliable({ ...east, speed_mps: 15, heading_deg: 90 }, pos(9, 15), now), true);
  assert.equal(directionReliable({ ...east, speed_mps: 0, heading_deg: 90 }, pos(9, 15), now), false, "not moving");
  assert.equal(directionReliable({ ...east, speed_mps: 15, heading_deg: 312 }, pos(9, 15), now), false, "heading says northwest, car went east");
  assert.equal(directionReliable({ ...east, speed_mps: 15, heading_deg: 90 }, pos(3, 15), T0 + 2_000), false, "too little history");
  const nearStart = { lat: LAT, lon: -96.79 + 8 / M_PER_DEG_LON }; // 8 m east after 8 s
  assert.equal(directionReliable({ ...nearStart, speed_mps: 15, heading_deg: 90 }, pos(9, 1), now), false, "barely moved");
  assert.ok(DIRECTION_TOLERANCE_DEG > 0);
});

test("first investigation starts once the heading agrees with the movement (no early warning at nobody)", async () => {
  const { firstPlanSec, w } = await drive(30, { speed: 12, heading: 90, eastMps: 12 });
  assert.ok(firstPlanSec !== null, "investigated");
  assert.ok(firstPlanSec! >= 7 && firstPlanSec! <= 10, `waited for a window of history, started at ${firstPlanSec}s`);
  assert.ok(w.alerts.length >= 1);
});

test("a track that is not moving (speed 0) is not investigated until the wait runs out", async () => {
  const { firstPlanSec } = await drive(40, { speed: 0, heading: 0, eastMps: 0 });
  const limit = FIRST_WARNING_MAX_WAIT_MS / 1000;
  assert.ok(firstPlanSec !== null && firstPlanSec >= limit - 1 && firstPlanSec <= limit + 1, `started at ${firstPlanSec}s, expected ~${limit}s`);
});

test("a heading that contradicts the movement (reports northwest, drives east) also waits, then goes ahead", async () => {
  const { firstPlanSec } = await drive(40, { speed: 5, heading: 312, eastMps: 12 });
  const limit = FIRST_WARNING_MAX_WAIT_MS / 1000;
  assert.ok(firstPlanSec !== null && firstPlanSec >= limit - 1, `started at ${firstPlanSec}s; must not trust the wrong heading`);
});
