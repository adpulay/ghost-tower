import assert from "node:assert/strict";
import { test } from "node:test";
import { Investigator } from "../src/agent.js";
import type { ChatModel, ChatResponse } from "../src/llm/types.js";
import { MockPolicy } from "../src/llm/mockPolicy.js";
import { urlHash } from "../src/knownDomains.js";
import { claimsAuthority, MAX_TRACE_CHARS } from "../src/trace.js";
import { MemoryWorld } from "../src/world/memory.js";
import type { Track } from "../src/types.js";

// Scenario runs must be deterministic and offline: no calls to the public OSRM router.
process.env.PREDICT_ROUTE_OFFLINE ??= "1";

const NOW = Date.UTC(2026, 10, 8, 16, 0, 0);
const TRACK: Track = {
  id: 3, lat: 32.9858, lon: -96.77, heading_deg: 90, speed_mps: 11, confidence: 0.9,
  event_count: 12, status: "active", campaign_id: 0, updated_ms: NOW,
};

function world() {
  const w = new MemoryWorld(() => NOW);
  w.driverUpsertTrack(TRACK);
  w.driverAddEvent({
    ts_ms: NOW, lat: 32.986, lon: -96.77, rat_drop: true, rat_drop_secs: 7, sms_score: 0.95,
    url_hash: urlHash("txtag-pay-demo.example"), brand: "TxTag", smsc_match: "no", fusion_score: 0.97, source: "sim", track_id: 3,
  });
  return w;
}

test("investigate: required tools called, all reducers written, trace lines ≤140 chars", async () => {
  const w = world();
  const r = await new Investigator(w, new MockPolicy(), { now: () => NOW }).run(TRACK, "investigate");
  for (const t of ["rdap_domain_age", "agent_link_campaign", "carrier_smsc_lookup", "predict_route", "agent_set_prediction", "draft_report", "send_warning", "agent_record_alert"]) {
    assert.ok(r.toolsCalled.includes(t), `missing ${t}`);
  }
  assert.ok(r.steps <= 8);
  assert.equal(w.campaigns.length, 1);
  assert.equal(w.tracks.get(3)!.campaign_id, w.campaigns[0].id);
  assert.ok(w.predictions.get(3));
  assert.equal(w.alerts.length, 1);
  assert.equal(w.traces[0].kind, "plan");
  assert.equal(w.traces.at(-1)!.kind, "summary");
  assert.ok(w.traces.every((t) => t.text.length <= MAX_TRACE_CHARS));
  assert.ok(w.traces.some((t) => t.text.endsWith("[simulated]")), "carrier mock result is tagged");
  // The agent never touched confidence/status.
  assert.equal(w.tracks.get(3)!.confidence, 0.9);
  assert.equal(w.tracks.get(3)!.status, "active");
});

test("loop is capped at 12 steps", async () => {
  const looping: ChatModel = {
    name: "loop",
    async chat(): Promise<ChatResponse> {
      return { content: null, tool_calls: [{ id: "x", type: "function", function: { name: "get_track_context", arguments: "{}" } }] };
    },
  };
  const w = world();
  const r = await new Investigator(w, looping, { now: () => NOW }).run(TRACK, "investigate");
  assert.equal(r.steps, 12);
  assert.equal(r.aborted, "step_cap");
  assert.equal(w.traces.at(-1)!.kind, "summary");
});

/** Plays back a fixed list of replies: each is a list of tool names (one turn) or a final string. */
function scripted(turns: (string[] | string)[]): ChatModel & { seen: string[] } {
  let i = 0;
  const seen: string[] = [];
  return {
    name: "scripted",
    seen,
    async chat(messages): Promise<ChatResponse> {
      const last = messages.at(-1)!;
      if (last.role === "user") seen.push(last.content ?? "");
      const turn = turns[Math.min(i++, turns.length - 1)];
      if (typeof turn === "string") return { content: turn, tool_calls: [] };
      return {
        content: null,
        tool_calls: turn.map((name, k) => ({ id: `c${i}_${k}`, type: "function", function: { name, arguments: argsFor(name) } })),
      };
    },
  };
}
function argsFor(name: string): string {
  if (name === "rdap_domain_age") return JSON.stringify({ domain: "txtag-pay-demo.example" });
  if (name === "agent_link_campaign") return JSON.stringify({ url_hash: urlHash("txtag-pay-demo.example"), brand: "TxTag", age_days: 2 });
  if (name === "carrier_smsc_lookup") return JSON.stringify({ url_hash: urlHash("txtag-pay-demo.example"), ts_ms: NOW });
  if (name === "predict_route") return JSON.stringify({ lat: 32.9858, lon: -96.77, heading_deg: 90, speed_mps: 11, horizon_s: 300 });
  if (name === "draft_report") return JSON.stringify({ track_id: 3, kind: "warning" });
  return "{}";
}

test("a model that stops early is reminded of the missing steps and finishes", async () => {
  // What live Nemotron did once: one tool, then an empty reply.
  const model = scripted([
    ["rdap_domain_age"],
    "",
    ["agent_link_campaign", "carrier_smsc_lookup"],
    ["predict_route"],
    ["agent_set_prediction"],
    ["draft_report"],
    ["send_warning"],
    ["agent_record_alert"],
    "TxTag lure from a 2-day-old domain; route predicted east; phones warned.",
  ]);
  const w = world();
  const r = await new Investigator(w, model, { now: () => NOW }).run(TRACK, "investigate");
  assert.equal(r.nudges, 1);
  assert.match(model.seen.at(-1)!, /still requires .*agent_link_campaign/);
  assert.equal(w.alerts.length, 1);
  assert.match(w.traces.at(-1)!.text, /phones warned/);
});

test("nudges are limited, so a model that keeps stopping still ends the run", async () => {
  const model = scripted([["rdap_domain_age"], ""]);
  const r = await new Investigator(world(), model, { now: () => NOW }).run(TRACK, "investigate");
  assert.equal(r.nudges, 2);
  assert.ok(!r.aborted);
});

test("a summary claiming a warning that was never sent is replaced", async () => {
  const model = scripted([["predict_route"], ["agent_set_prediction"], "Track heading east; warning broadcast to 41 phones."]);
  const w = world();
  const r = await new Investigator(w, model, { now: () => NOW }).run(TRACK, "refresh");
  assert.equal(r.claimedUnsentWarning, true);
  assert.doesNotMatch(w.traces.at(-1)!.text, /41 phones|broadcast/);
});

test("model failure (e.g. 20 s timeout) is retried once then reported, not thrown", async () => {
  let calls = 0;
  const failing: ChatModel = {
    name: "fail",
    async chat() {
      calls++;
      const e = new Error("aborted");
      e.name = "TimeoutError";
      throw e;
    },
  };
  const w = world();
  const r = await new Investigator(w, failing, { now: () => NOW }).run(TRACK, "investigate");
  assert.equal(calls, 2);
  assert.equal(r.aborted, "model_error");
  assert.match(w.traces.at(-1)!.text, /timed out/);
});

test("a final summary that claims to set confidence is flagged and not broadcast", async () => {
  const claimer: ChatModel = {
    name: "claimer",
    async chat() {
      return { content: "I set the track confidence to 0.99 and marked status active.", tool_calls: [] };
    },
  };
  const w = world();
  const r = await new Investigator(w, claimer, { now: () => NOW }).run(TRACK, "investigate");
  assert.equal(r.claimedAuthority, true);
  assert.doesNotMatch(w.traces.at(-1)!.text, /confidence/);
});

test("authority-claim detector", () => {
  assert.equal(claimsAuthority("I raised the confidence to 0.95."), true);
  assert.equal(claimsAuthority("Updated track status to active."), true);
  assert.equal(claimsAuthority("We have confirmed this is a blaster."), true);
  assert.equal(claimsAuthority("TxTag lure from a 2-day-old domain, never via carrier; 41 phones warned."), false);
  assert.equal(claimsAuthority("Track confidence 0.91 comes from the database."), false);
});

test("write tools are pinned to the investigated track", async () => {
  const sneaky: ChatModel = {
    name: "sneaky",
    n: 0,
    async chat() {
      // @ts-expect-error test-only counter
      if (this.n++ > 0) return { content: "done", tool_calls: [] };
      return {
        content: null,
        tool_calls: [{ id: "1", type: "function", function: { name: "agent_link_campaign", arguments: JSON.stringify({ track_id: 999, url_hash: "abc", brand: "X", domain_age_days: 1 }) } }],
      };
    },
  } as ChatModel;
  const w = world();
  await new Investigator(w, sneaky, { now: () => NOW }).run(TRACK, "investigate");
  assert.ok(w.tracks.get(3)!.campaign_id > 0);
  assert.equal(w.tracks.get(999), undefined);
});

test("an empty final reply gets a readable evidence-only summary", async () => {
  const model = scripted([["predict_route"], ["agent_set_prediction"], ""]);
  const w = world();
  await new Investigator(w, model, { now: () => NOW }).run(TRACK, "refresh");
  assert.equal(w.traces.at(-1)!.text, "Track #3: route predicted.");
});
