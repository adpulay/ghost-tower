import assert from "node:assert/strict";
import { test } from "node:test";
import { carrierSmscLookup } from "../tools/carrier_smsc_lookup.js";
import { draftReport, warningTemplate } from "../tools/draft_report/index.js";
import { getTrackContext } from "../tools/get_track_context.js";
import { predictRoute } from "../tools/predict_route/index.js";
import { rdapDomainAge } from "../tools/rdap_domain_age.js";
import { _resetSendThrottle, sendWarning, validateWarning } from "../tools/send_warning.js";
import { urlHash } from "../src/knownDomains.js";
import { MemoryWorld } from "../src/world/memory.js";
import type { Track } from "../src/types.js";

const NOW = Date.UTC(2026, 10, 8, 16, 0, 0);
const TRACK: Track = {
  id: 7, lat: 32.9858, lon: -96.77, heading_deg: 90, speed_mps: 11, confidence: 0.9,
  event_count: 12, status: "active", campaign_id: 0, updated_ms: NOW,
};
const ZONE: [number, number][] = [[32.97, -96.78], [32.97, -96.73], [33.0, -96.73], [33.0, -96.78]];

function worldWithTrack() {
  const w = new MemoryWorld(() => NOW);
  w.driverUpsertTrack(TRACK);
  for (let i = 0; i < 60; i++) {
    w.driverAddEvent({
      ts_ms: NOW - i * 1000, lat: 32.986, lon: -96.77, rat_drop: true, rat_drop_secs: 7, sms_score: 0.95,
      url_hash: urlHash("txtag-pay-demo.example"), brand: "TxTag", smsc_match: "no", fusion_score: 0.97,
      source: "sim", track_id: 7,
    });
  }
  return w;
}

test("get_track_context returns the track row and the last 50 events, newest first", async () => {
  const out = await getTrackContext({ track_id: 7 }, { world: worldWithTrack() });
  assert.equal(out.track?.id, 7);
  assert.equal(out.events.length, 50);
  assert.equal(out.events[0].ts_ms, NOW);
  const missing = await getTrackContext({ track_id: 99 }, { world: worldWithTrack() });
  assert.deepEqual(missing, { track: null, events: [] });
});

test("rdap_domain_age: demo scam domain is canned, never fetched", async () => {
  let fetched = false;
  const out = await rdapDomainAge({ domain: "TXTAG-pay-demo.example" }, {
    now: () => NOW,
    fetchImpl: (async () => { fetched = true; throw new Error("no"); }) as unknown as typeof fetch,
  });
  assert.equal(fetched, false);
  assert.deepEqual(Object.keys(out).sort(), ["age_days", "created", "domain"]);
  assert.equal(out.domain, "txtag-pay-demo.example");
  assert.equal(out.age_days, 2);
  assert.equal(out.created, new Date(NOW - 2 * 86_400_000).toISOString());
});

test("rdap_domain_age: unknown (possibly live phishing) domain is refused, never fetched", async () => {
  let fetched = false;
  const log: Record<string, unknown>[] = [];
  const out = await rdapDomainAge({ domain: "txtag-secure-pay.top" }, {
    fetchImpl: (async () => { fetched = true; throw new Error("no"); }) as unknown as typeof fetch,
    log: (e) => log.push(e),
  });
  assert.equal(fetched, false);
  assert.deepEqual(out, { domain: "txtag-secure-pay.top", created: null, age_days: -1 });
  assert.equal(log[0].mode, "refused-not-allowlisted");
});

test("rdap_domain_age: allowlisted benign domain uses live RDAP registration date", async () => {
  const fakeFetch = (async (url: string) => {
    assert.match(String(url), /^https:\/\/rdap\.org\/domain\/usps\.com$/);
    return new Response(JSON.stringify({ events: [{ eventAction: "registration", eventDate: "1997-01-01T00:00:00Z" }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const out = await rdapDomainAge({ domain: "www.usps.com" }, { now: () => NOW, fetchImpl: fakeFetch });
  assert.equal(out.domain, "usps.com");
  assert.equal(out.created, "1997-01-01T00:00:00.000Z");
  assert.ok(out.age_days > 10_000);
});

test("carrier_smsc_lookup (mock): campaign → no, benign toll → yes, unknown → unknown", () => {
  assert.deepEqual(carrierSmscLookup({ url_hash: urlHash("txtag-pay-demo.example"), ts_ms: NOW }), { match: "no" });
  assert.deepEqual(carrierSmscLookup({ url_hash: urlHash("txtag.org"), ts_ms: NOW }), { match: "yes" });
  assert.deepEqual(carrierSmscLookup({ url_hash: "deadbeef", ts_ms: NOW }), { match: "unknown" });
});

test("predict_route output shape: path, intercept, eta_s, source", async () => {
  const out = await predictRoute({ lat: 32.9858, lon: -96.77, heading_deg: 90, speed_mps: 11, horizon_s: 300 }, { offline: true });
  assert.equal(out.path.length, 21); // one point per 15 s, including now
  assert.equal(out.source, "straight_line");
  assert.ok(out.path.every((p) => p.length === 2));
  assert.equal(out.intercept.length, 2);
  assert.ok(Number.isInteger(out.eta_s));
  assert.ok(out.intercept[1] > -96.77, "heading east should increase longitude");
  assert.ok(Math.abs(out.intercept[0] - 32.9858) < 0.001, "heading east keeps latitude");
});

test("draft_report (stub): warning ≤160 chars, no URL; police + registrar contain key facts", async () => {
  const w = worldWithTrack();
  await w.agentLinkCampaign(7, urlHash("txtag-pay-demo.example"), "TxTag", 2);
  const warn = await draftReport({ track_id: 7, kind: "warning" }, { world: w });
  assert.equal(validateWarning(warn.text), null);
  assert.match(warn.text, /TxTag/);
  const police = await draftReport({ track_id: 7, kind: "police" }, { world: w });
  assert.match(police.text, /32\.9858/);
  assert.match(police.text, /east/);
  assert.ok(police.text.split("\n").length <= 5);
  const reg = await draftReport({ track_id: 7, kind: "registrar" }, { world: w });
  assert.match(reg.text, /txtag-pay-demo\.example/);
  assert.match(reg.text, /TxTag/);
  for (const brand of ["TxTag", "NTTA", "USPS", "Chase"]) assert.ok(warningTemplate(brand, "Campbell Rd, Richardson").length <= 160);
});

test("send_warning: dry run counts simulated phones in zone, output is { sent }", async () => {
  _resetSendThrottle();
  const out = await sendWarning(
    { zone_polygon: ZONE, message: "Scam alert: fake toll texts nearby. Do not tap links." },
    { twilio: { accountSid: "", authToken: "", from: "", verifiedNumbers: [], dryRun: true }, phones: { count: 300, bbox: [32.97, -96.78, 33.0, -96.73], seed: "t" } },
  );
  assert.deepEqual(Object.keys(out), ["sent"]);
  assert.equal(out.sent, 300);
});

test("send_warning: texts only verified numbers via Twilio and adds their deliveries", async () => {
  _resetSendThrottle();
  const sentTo: string[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    assert.match(String(url), /api\.twilio\.com\/2010-04-01\/Accounts\/AC1\/Messages\.json/);
    sentTo.push(new URLSearchParams(String(init.body)).get("To")!);
    return new Response("{}", { status: 201 });
  }) as unknown as typeof fetch;
  const out = await sendWarning(
    { zone_polygon: ZONE, message: "Scam alert: fake toll texts nearby. Do not tap links." },
    {
      twilio: { accountSid: "AC1", authToken: "x", from: "+15550000000", verifiedNumbers: ["+15551111111", "+15552222222"], dryRun: false },
      phones: { count: 10, bbox: [32.97, -96.78, 33.0, -96.73], seed: "t" },
      fetchImpl: fakeFetch,
    },
  );
  assert.deepEqual(sentTo, ["+15551111111", "+15552222222"]);
  assert.equal(out.sent, 12);
});

test("send_warning refuses links, long text and bad zones", async () => {
  await assert.rejects(sendWarning({ zone_polygon: ZONE, message: "Pay at https://txtag-pay-demo.example now" }), /link/);
  await assert.rejects(sendWarning({ zone_polygon: ZONE, message: "x".repeat(161) }), /160/);
  await assert.rejects(sendWarning({ zone_polygon: [[1, 2]], message: "ok" }), /zone_polygon/);
});
