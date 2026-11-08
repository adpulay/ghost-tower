import assert from "node:assert/strict";
import { test } from "node:test";
import { MockPolicy } from "../src/llm/mockPolicy.js";
import { runScenario } from "../src/runScenario.js";
import { SCENARIOS } from "../src/scenarios.js";

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
  assert.ok(replanS > 90 && replanS < 110, `replan at ${replanS}s`);
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
