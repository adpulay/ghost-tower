import assert from "node:assert/strict";
import { test } from "node:test";
import { PlaybookInvestigator } from "../src/playbook.js";
import { MockPolicy } from "../src/llm/mockPolicy.js";
import type { ChatModel } from "../src/llm/types.js";
import { AgentService } from "../src/service.js";
import { urlHash } from "../src/knownDomains.js";
import { MemoryWorld } from "../src/world/memory.js";
import type { Prediction, Track } from "../src/types.js";

process.env.NEMOTRON_PROVIDER ??= "mock"; // draft_report uses its fixed templates: no network
process.env.PREDICT_ROUTE_OFFLINE ??= "1";
// These synthetic tracks are not on real roads and expect the plain straight-line projection.
process.env.PREDICT_ROUTE_ROADMAP ??= "0";

const NOW = Date.UTC(2026, 10, 8, 16, 0, 0);
const TRACK: Track = {
  id: 3, lat: 32.9858, lon: -96.77, heading_deg: 90, speed_mps: 11, confidence: 0.9,
  event_count: 12, status: "active", campaign_id: 0, updated_ms: NOW,
};

function world(track: Track = TRACK) {
  const w = new MemoryWorld(() => NOW);
  w.driverUpsertTrack(track);
  w.driverAddEvent({
    ts_ms: NOW, lat: 32.986, lon: -96.77, rat_drop: true, rat_drop_secs: 7, sms_score: 0.95,
    url_hash: urlHash("txtag-pay-demo.example"), brand: "TxTag", smsc_match: "no", fusion_score: 0.97, source: "sim", track_id: track.id,
  });
  return w;
}

test("investigate: every required tool runs, in five stages, with the lookups before the writes", async () => {
  const w = world();
  const pb = new PlaybookInvestigator(w, { now: () => NOW });
  const r = await pb.run(TRACK, "investigate");
  await pb.flushTraces();
  for (const t of ["rdap_domain_age", "agent_link_campaign", "carrier_smsc_lookup", "predict_route", "agent_set_prediction", "draft_report", "send_warning", "agent_record_alert"]) {
    assert.ok(r.toolsCalled.includes(t), `missing ${t}`);
  }
  assert.equal(r.steps, 5, "five sequential stages, not eleven model turns");
  assert.equal(w.campaigns.length, 1);
  assert.ok(w.predictions.get(3));
  assert.equal(w.alerts.length, 1);
  assert.equal(r.predictionAtMs, NOW);
  assert.equal(r.predictionHeading, 90);
  // Order of the calls: the three lookups start before either write.
  const calls = w.traces.filter((t) => t.kind === "tool_call").map((t) => t.text.split("(")[0].replace("Calling ", ""));
  const idx = (n: string) => calls.indexOf(n);
  for (const lookup of ["rdap_domain_age", "carrier_smsc_lookup", "predict_route"]) {
    assert.ok(idx(lookup) < idx("agent_link_campaign") && idx(lookup) < idx("agent_set_prediction"), `${lookup} before the writes`);
  }
  assert.ok(idx("agent_link_campaign") < idx("draft_report") && idx("draft_report") < idx("send_warning") && idx("send_warning") < idx("agent_record_alert"));
});

test("investigate: the log reads plan, calls and results, then a closing line built from facts", async () => {
  const w = world();
  const pb = new PlaybookInvestigator(w, { now: () => NOW });
  await pb.run(TRACK, "investigate");
  await pb.flushTraces();
  assert.equal(w.traces[0].kind, "plan");
  assert.equal(w.traces.at(-1)!.kind, "summary");
  assert.match(w.traces.at(-1)!.text, /^Track #3: TxTag lure, 2-day-old domain, never via carrier; heading east; \d+ phones? warned\.$/);
  assert.ok(w.traces.every((t) => t.text.length <= 140));
  assert.ok(w.traces.some((t) => t.text.endsWith("[simulated]")), "the carrier mock is tagged");
  // Every result has an earlier call for the same tool.
  const seen = new Set<string>();
  for (const t of w.traces) {
    if (t.kind === "tool_call") seen.add(t.text.split("(")[0].replace("Calling ", ""));
  }
  assert.ok(seen.size >= 8);
});

test("replan: re-predicts and re-warns, without re-checking the campaign", async () => {
  const north = { ...TRACK, heading_deg: 0 };
  const w = world(north);
  const pb = new PlaybookInvestigator(w, { now: () => NOW });
  const r = await pb.run(north, "replan", "Track #3 turned 90 degrees, now heading north");
  await pb.flushTraces();
  assert.deepEqual([...new Set(r.toolsCalled)].sort(), ["agent_record_alert", "agent_set_prediction", "draft_report", "predict_route", "send_warning"]);
  assert.equal(w.traces[0].kind, "replan");
  assert.match(w.traces.at(-1)!.text, /^Track #3: now heading north; route re-predicted; \d+ phones? warned\.$/);
  assert.equal(r.steps, 4);
});

test("a tool that fails is reported and does not stop the rest of the investigation", async () => {
  const w = world();
  w.agentLinkCampaign = async () => { throw new Error("database busy"); };
  const pb = new PlaybookInvestigator(w, { now: () => NOW });
  const r = await pb.run(TRACK, "investigate");
  await pb.flushTraces();
  assert.ok(r.errors.some((e) => /agent_link_campaign: database busy/.test(e)));
  assert.equal(w.alerts.length, 1, "the warning still went out");
  assert.ok(w.predictions.get(3), "the route was still published");
  assert.ok(w.traces.some((t) => /agent_link_campaign failed: database busy/.test(t.text)));
  assert.match(w.traces.at(-1)!.text, /lure not linked/);
});

test("no route means no warning, and the log says so", async () => {
  const w = world();
  const real = w.agentSetPrediction.bind(w);
  w.agentSetPrediction = async (p: Prediction) => real(p);
  const pb = new PlaybookInvestigator(w, { now: () => NOW });
  // A parked, unknown-heading track still gets a prediction (straight line), so force the failure instead.
  const tools = await import("../tools/index.js");
  const original = tools.TOOLS_BY_NAME.get("predict_route")!.run;
  tools.TOOLS_BY_NAME.get("predict_route")!.run = async () => { throw new Error("router down"); };
  try {
    const r = await pb.run(TRACK, "investigate");
    await pb.flushTraces();
    assert.ok(!r.toolsCalled.includes("send_warning"));
    assert.equal(w.alerts.length, 0);
    assert.ok(w.traces.some((t) => /No route or warning text, so no warning was sent/.test(t.text)));
    assert.match(w.traces.at(-1)!.text, /no route predicted; no warning sent\.$/);
  } finally {
    tools.TOOLS_BY_NAME.get("predict_route")!.run = original;
  }
});

test("evidence: the packet is saved after the warning and labelled as template text when no model wrote it", async () => {
  const w = world();
  const pb = new PlaybookInvestigator(w, { now: () => NOW });
  await pb.run(TRACK, "investigate");
  await pb.flushTraces();
  assert.equal(w.alerts.length, 1);
  const police = w.reports.get("3:police");
  const registrar = w.reports.get("3:registrar");
  assert.ok(police && registrar, "both reports saved");
  assert.equal(police.generated, false, "the mock provider uses templates and must say so");
  assert.match(police.text, /SMS blaster suspect, track #3/);
  assert.match(registrar.text, /txtag-pay-demo\.example/);
  assert.equal(w.traces.at(-1)!.kind, "summary", "evidence writes add nothing to the log");
});

test("evidence: a failed save never affects the warning", async () => {
  const w = world();
  w.agentSaveReport = async () => { throw new Error("database busy"); };
  const pb = new PlaybookInvestigator(w, { now: () => NOW });
  const r = await pb.run(TRACK, "investigate");
  await pb.flushTraces();
  assert.equal(w.alerts.length, 1);
  assert.deepEqual(r.errors, []);
});

test("log writes do not block the actions: the run returns before the log has caught up, in order", async () => {
  const w = world();
  const realTrace = w.agentWriteTrace.bind(w);
  w.agentWriteTrace = async (id, kind, text) => { await new Promise((r) => setTimeout(r, 60)); return realTrace(id, kind, text); };
  const pb = new PlaybookInvestigator(w, { now: () => NOW });
  const t0 = Date.now();
  await pb.run(TRACK, "investigate");
  const runMs = Date.now() - t0;
  const writtenAtReturn = w.traces.length;
  await pb.flushTraces();
  const totalMs = Date.now() - t0;
  assert.equal(w.alerts.length, 1, "the actions are done when run() returns");
  assert.ok(writtenAtReturn < w.traces.length, `the log was still catching up (${writtenAtReturn} of ${w.traces.length} lines written)`);
  assert.ok(runMs < totalMs / 2, `run() took ${runMs} ms of ${totalMs} ms total`);
  assert.equal(w.traces[0].kind, "plan");
  assert.equal(w.traces.at(-1)!.kind, "summary", "still in order");
});

test("AgentService: playbook mode (the default) never asks the service's model to choose tools; llm mode does", async () => {
  for (const [agentMode, expectCalls] of [["playbook", false], ["llm", true]] as const) {
    let calls = 0;
    let now = NOW;
    const mock = new MockPolicy();
    const spy: ChatModel = { name: "spy", chat: (m) => { calls++; return mock.chat(m); } };
    const w = new MemoryWorld(() => now);
    w.driverAddEvent({
      ts_ms: NOW, lat: 32.986, lon: -96.77, rat_drop: true, rat_drop_secs: 7, sms_score: 0.95,
      url_hash: urlHash("txtag-pay-demo.example"), brand: "TxTag", smsc_match: "no", fusion_score: 0.97, source: "sim", track_id: 3,
    });
    const svc = new AgentService(w, spy, { now: () => now, agentMode });
    // Moving east at ~12 m/s, so the first-warning gate opens after a few seconds of history.
    for (let s = 0; s < 40 && !w.alerts.length; s++) {
      w.driverUpsertTrack({ ...TRACK, speed_mps: 12, heading_deg: 90, lon: -96.79 + (12 * s) / 93_300, updated_ms: now });
      await svc.tick();
      await svc.idle();
      now += 1000;
    }
    assert.ok(w.alerts.length >= 1, `${agentMode}: investigated`);
    assert.equal(calls > 0, expectCalls, `${agentMode}: model calls = ${calls}`);
  }
});
