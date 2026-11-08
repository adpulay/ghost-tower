import assert from "node:assert/strict";
import { test } from "node:test";
import { focusCampaign, focusTrack } from "./focusTrack.ts";
import type { Campaign, Track } from "./types.ts";

const tr = (id: number, status: string, confidence: number, updated_ms = 0, campaign_id = 0): Track => ({
  id, lat: 0, lon: 0, heading_deg: 0, speed_mps: 0, confidence, event_count: 0, status, campaign_id, updated_ms,
});

test("an active track wins over newer low-confidence candidates (live noise)", () => {
  // what Maincloud looked like during a demo-01 run: #1 active, #2–#9 noise
  const tracks = [tr(1, "active", 1, 100), tr(2, "candidate", 0.22, 200), tr(7, "candidate", 0.11, 300), tr(9, "candidate", 0.06, 400)];
  assert.equal(focusTrack(tracks)?.id, 1);
});

test("with several active tracks, the most confident is followed", () => {
  assert.equal(focusTrack([tr(1, "active", 0.85), tr(2, "active", 0.97)])?.id, 2);
});

test("no active track: best candidate, then dormant; empty → undefined", () => {
  assert.equal(focusTrack([tr(1, "closed", 0), tr(2, "candidate", 0.3), tr(3, "candidate", 0.6)])?.id, 3);
  assert.equal(focusTrack([tr(1, "closed", 0), tr(2, "dormant", 0.9)])?.id, 2);
  assert.equal(focusTrack([]), undefined);
});

test("campaign card shows the focused track's campaign, not the newest campaign", () => {
  const camps: Campaign[] = [
    { id: 1, url_hash: "a", brand: "TxTag", domain_age_days: 2, first_seen_ms: 0 },
    { id: 2, url_hash: "b", brand: "USPS", domain_age_days: 1, first_seen_ms: 0 },
  ];
  assert.equal(focusCampaign(tr(1, "active", 1, 0, 1), camps)?.brand, "TxTag");
  assert.equal(focusCampaign(tr(1, "active", 1, 0, 0), camps), undefined);
  assert.equal(focusCampaign(undefined, camps), undefined);
});
