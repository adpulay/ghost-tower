import assert from "node:assert/strict";
import { test } from "node:test";
import { MockPolicy } from "../src/llm/mockPolicy.js";
import { runScenario } from "../src/runScenario.js";
import { SCENARIOS } from "../src/scenarios.js";
import {
  AgentService, DIRECTION_TOLERANCE_DEG, FIRST_WARNING_MAX_WAIT_MS, STALE_PREDICTION_MS, directionReliable, refreshHeading,
} from "../src/service.js";
import { bearingDeg } from "../src/geo.js";
import type { ChatModel } from "../src/llm/types.js";
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

// ---- a noisy heading at low speed is not a turn ----

interface Phase { secs: number; speed: number; heading: number; eastMps: number; northMps: number }

async function driveReplans(phases: Phase[]) {
  let now = T0;
  const w = new MemoryWorld(() => now);
  const svc = new AgentService(w, new MockPolicy(), { now: () => now });
  let lat = LAT, lon = -96.79;
  const replanAt: number[] = [];
  let sec = 0;
  for (const p of phases) {
    for (let i = 0; i < p.secs; i++, sec++) {
      lon += p.eastMps / M_PER_DEG_LON;
      lat += p.northMps / 111_320;
      w.driverUpsertTrack({
        id: 5, lat, lon, heading_deg: p.heading, speed_mps: p.speed, confidence: 0.9, event_count: 12,
        status: "active", campaign_id: 0, updated_ms: now,
      });
      const before = w.traces.filter((t) => t.kind === "replan").length;
      await svc.tick();
      await svc.idle();
      if (w.traces.filter((t) => t.kind === "replan").length > before) replanAt.push(sec);
      now += 1000;
    }
  }
  return replanAt;
}

test("a heading that flips at low speed while the track keeps going the same way is not a replan", async () => {
  // East at 12 m/s, then 15 s of "heading northwest at 3 m/s" (the position still heads east), then east again.
  const replans = await driveReplans([
    { secs: 25, speed: 12, heading: 90, eastMps: 12, northMps: 0 },
    { secs: 15, speed: 3, heading: 314, eastMps: 12, northMps: 0 },
    { secs: 15, speed: 12, heading: 90, eastMps: 12, northMps: 0 },
  ]);
  assert.deepEqual(replans, [], "no replan for heading noise");
});

test("a real turn (heading and movement both go north) still replans, once", async () => {
  const replans = await driveReplans([
    { secs: 25, speed: 12, heading: 90, eastMps: 12, northMps: 0 },
    { secs: 40, speed: 12, heading: 0, eastMps: 0, northMps: 12 },
  ]);
  assert.equal(replans.length, 1, `replans at ${replans}`);
  assert.ok(replans[0] >= 25 + 8 && replans[0] <= 25 + 20, `replanned ${replans[0] - 25}s after the turn`);
});

// ---- the route (and the warning zone drawn from it) refreshes regularly, and follows a turn ----

async function driveRefresh(phases: Phase[]) {
  let now = T0;
  const w = new MemoryWorld(() => now);
  let calls = 0;
  const mock = new MockPolicy();
  const counting: ChatModel = { name: "counting", chat: (m) => { calls++; return mock.chat(m); } };
  const svc = new AgentService(w, counting, { now: () => now });
  let lat = LAT, lon = -96.79;
  const seen: number[] = [];
  const snapshots: { sec: number; path: [number, number][]; replans: number; calls: number }[] = [];
  let sec = 0;
  for (const p of phases) {
    for (let i = 0; i < p.secs; i++, sec++) {
      lon += p.eastMps / M_PER_DEG_LON;
      lat += p.northMps / 111_320;
      w.driverUpsertTrack({
        id: 5, lat, lon, heading_deg: p.heading, speed_mps: p.speed, confidence: 0.9, event_count: 12,
        status: "active", campaign_id: 0, updated_ms: now,
      });
      await svc.tick();
      await svc.idle();
      const pred = w.predictions.get(5);
      if (pred && !seen.includes(pred.updated_ms)) seen.push(pred.updated_ms);
      snapshots.push({ sec, path: pred ? JSON.parse(pred.path_json) : [], replans: w.traces.filter((t) => t.kind === "replan").length, calls });
      now += 1000;
    }
  }
  return { w, calls, seen, snapshots };
}

test("the predicted route refreshes every few seconds without calling the model", async () => {
  const east: Phase = { secs: 60, speed: 12, heading: 90, eastMps: 12, northMps: 0 };
  const { w, seen, snapshots } = await driveRefresh([east]);
  // Investigation done (it alone uses the model); then count how many times the route was re-published.
  const doneAt = snapshots.find((s) => w.alerts.length > 0 && s.calls > 0)!;
  const after = snapshots.filter((s) => s.sec > doneAt.sec);
  assert.equal(after.at(-1)!.calls, doneAt.calls, "no model calls after the investigation: refreshes are plain computation");
  const expected = Math.floor((60 - doneAt.sec) / (STALE_PREDICTION_MS / 1000));
  assert.ok(seen.length >= expected, `route published ${seen.length} times, expected at least ${expected}`);
  assert.equal(w.traces.filter((t) => /Refreshing|route predicted/i.test(t.text) && t.kind !== "summary").length, 0, "refreshes write no log lines");
  assert.equal(w.alerts.length, 1, "refreshes send no warnings");
});

test("through a turn the route follows the movement before the replan settles", async () => {
  const { snapshots } = await driveRefresh([
    { secs: 30, speed: 12, heading: 90, eastMps: 12, northMps: 0 },
    { secs: 8, speed: 12, heading: 0, eastMps: 0, northMps: 12 },
  ]);
  const last = snapshots.at(-1)!;
  assert.equal(last.replans, 0, "the replan itself is still waiting for the heading to settle");
  const head = bearingDeg(last.path[0], last.path.at(-1)!);
  assert.ok(head < 30 || head > 330, `the route already points north (${Math.round(head)} degrees)`);
});

test("refreshHeading: trusts the reported heading, but follows the movement when they disagree or the track is slow", () => {
  const pos = (n: number, eastMps: number) => Array.from({ length: n }, (_, i) => ({ ms: T0 + i * 1000, lat: LAT, lon: -96.79 + (eastMps * i) / M_PER_DEG_LON }));
  const at = { lat: LAT, lon: -96.79 + (12 * 8) / M_PER_DEG_LON };
  const now = T0 + 8_000;
  assert.equal(refreshHeading({ ...at, speed_mps: 12, heading_deg: 80 }, pos(9, 12), now), 80, "agrees: use the reported heading");
  assert.ok(Math.abs(refreshHeading({ ...at, speed_mps: 12, heading_deg: 314 }, pos(9, 12), now) - 90) < 2, "contradicts the movement: use where it went");
  assert.ok(Math.abs(refreshHeading({ ...at, speed_mps: 3, heading_deg: 314 }, pos(9, 12), now) - 90) < 2, "slow track: use where it went");
  assert.equal(refreshHeading({ ...at, speed_mps: 0.5, heading_deg: 200 }, pos(2, 0), T0 + 1_000, 90), 90, "barely moving: keep the last heading");
});
