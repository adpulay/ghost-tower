import assert from "node:assert/strict";
import { test } from "node:test";
import {
  coarsen,
  fusionScore,
  haversineM,
  offset,
  recluster,
  type EventRow,
  type TrackRow,
  type TrackState,
} from "../src/tracking";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** In-memory stand-in for the module tables, applying recluster results like the reducer does. */
class World {
  events: EventRow[] = [];
  tracks = new Map<number, TrackRow>();
  states = new Map<number, TrackState>();
  private nextEvent = 1;
  private nextTrack = 1;

  report(ts: number, lat: number, lon: number, url: string, opts: { fusion?: number; smsc?: string } = {}) {
    const smsc = opts.smsc ?? "no";
    this.events.push({
      id: this.nextEvent++,
      ts_ms: ts,
      lat: coarsen(lat),
      lon: coarsen(lon),
      fusion_score: opts.fusion ?? fusionScore(true, 8, 0.97, smsc),
      url_hash: url,
      smsc_match: smsc,
      track_id: 0,
    });
  }

  tick(now: number) {
    for (const r of recluster(now, this.events, [...this.tracks.values()], this.states)) {
      const id = r.id ?? this.nextTrack++;
      const prev = this.tracks.get(id);
      this.tracks.set(id, { id, ...r.track, campaign_id: prev?.campaign_id ?? 0 });
      this.states.set(id, { track_id: id, ...r.state });
      for (const eid of r.eventIds) this.events.find((e) => e.id === eid)!.track_id = id;
    }
  }

  byStatus(s: string) {
    return [...this.tracks.values()].filter((t) => t.status === s);
  }
}

/** A blaster driving east, then north; phones in a grid report when within range (once per 60 s). */
function drive(world: World, opts: { t0: number; seconds: number; turnAt?: number; url?: string; seed?: number; onTick?: (now: number, pos: [number, number]) => void }) {
  const r = rng(opts.seed ?? 1);
  const phones: [number, number][] = [];
  for (let i = 0; i < 300; i++) phones.push([32.97 + r() * 0.03, -96.78 + r() * 0.05]);
  const lastHit = new Map<number, number>();
  let pos: [number, number] = [32.976, -96.775];
  for (let s = 0; s <= opts.seconds; s++) {
    const now = opts.t0 + s * 1000;
    const north = opts.turnAt !== undefined && s >= opts.turnAt;
    pos = north ? offset(pos[0], pos[1], 11, 0) : offset(pos[0], pos[1], 0, 11);
    phones.forEach(([la, lo], i) => {
      if (haversineM(la, lo, pos[0], pos[1]) > 500) return;
      if (now - (lastHit.get(i) ?? -Infinity) < 60_000) return;
      lastHit.set(i, now);
      world.report(now, la + (r() - 0.5) * 0.002, lo + (r() - 0.5) * 0.002, opts.url ?? HASH_A);
    });
    if (s % 3 === 0) world.tick(now);
    opts.onTick?.(now, pos);
  }
  return pos;
}

test("fusion score matches INTERFACES.md §4 for 4 hand-made payloads", () => {
  const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
  close(fusionScore(true, 8.2, 0.97, "no"), 0.45 + 0.35 * 0.97 + 0.2); // full blaster hit
  close(fusionScore(true, 45, 0.97, "no"), 0.35 * 0.97 + 0.2); // 2G too long: not a blaster drop
  close(fusionScore(false, 0, 0.05, "yes"), 0.35 * 0.05); // benign real toll text
  close(fusionScore(true, 5, 0, "unknown"), 0.45 + 0.1); // 2G drop, no SMS
});

test("demo drive: one active track within 30 s, follows the turn, error stays near the truth", () => {
  const w = new World();
  const t0 = 1_762_548_000_000;
  let firstActive: number | undefined;
  const errors: number[] = [];
  const headings: { s: number; h: number }[] = [];
  drive(w, {
    t0,
    seconds: 180,
    turnAt: 90,
    onTick: (now, pos) => {
      const act = w.byStatus("active");
      if (act.length && firstActive === undefined) firstActive = now;
      if (act.length && (now - t0) % 3000 === 0) {
        errors.push(haversineM(act[0]!.lat, act[0]!.lon, pos[0], pos[1]));
        headings.push({ s: (now - t0) / 1000, h: act[0]!.heading_deg });
      }
    },
  });
  assert.ok(firstActive !== undefined && firstActive - t0 <= 30_000, `active after ${(firstActive! - t0) / 1000}s`);
  const active = w.byStatus("active");
  assert.equal(active.length, 1, `expected one active track, got ${JSON.stringify([...w.tracks.values()])}`);
  const median = [...errors].sort((a, b) => a - b)[Math.floor(errors.length / 2)]!;
  assert.ok(median < 500, `median error ${median.toFixed(0)} m`);
  // Heading is estimated from coarsened phone positions, so allow ±45° on each leg, and up to
  // 45 s after the turn at 90 s for the track to swing north.
  const off = (h: number, want: number) => Math.abs(((h - want + 540) % 360) - 180);
  const east = headings.filter((x) => x.s >= 40 && x.s <= 88).map((x) => x.h);
  const north = headings.filter((x) => x.s >= 135).map((x) => x.h);
  assert.ok(east.every((h) => off(h, 90) < 45), `east headings ${east.map(Math.round)}`);
  assert.ok(north.every((h) => off(h, 0) < 45), `north headings ${north.map(Math.round)}`);
});

test("benign-only events never form tracks", () => {
  const w = new World();
  const r = rng(7);
  const t0 = 1_762_548_000_000;
  for (let s = 0; s < 300; s++) {
    const now = t0 + s * 1000;
    for (let k = 0; k < 3; k++) {
      const smsc = r() < 0.5 ? "yes" : "unknown";
      // real toll texts / handovers: no 2G blaster drop, low sms score
      w.report(now, 32.98 + r() * 0.01, -96.75 + r() * 0.01, "", { fusion: fusionScore(false, 0, r() * 0.3, smsc), smsc });
    }
    if (s % 3 === 0) w.tick(now);
  }
  assert.equal(w.tracks.size, 0);
});

test("active → dormant after 90 s silent → active again when the same campaign reappears elsewhere", () => {
  const w = new World();
  const t0 = 1_762_548_000_000;
  drive(w, { t0, seconds: 60 });
  const [tr] = w.byStatus("active");
  assert.ok(tr, "track should be active");
  // blaster off: nothing for 100 s
  for (let s = 63; s <= 160; s += 3) w.tick(t0 + s * 1000);
  assert.equal(w.tracks.get(tr.id)!.status, "dormant");
  // reappears 3 km north with the same link
  const t1 = t0 + 170_000;
  for (let i = 0; i < 6; i++) w.report(t1 + i * 500, 33.015 + i * 0.0003, -96.76, HASH_A);
  w.tick(t1 + 3000);
  assert.equal(w.tracks.get(tr.id)!.status, "active", "same track reactivated");
  assert.equal(w.tracks.size, 1);
  assert.ok(w.tracks.get(tr.id)!.lat > 33.01, "position jumped to the new cluster");
});

test("two campaigns in the same area stay separate tracks", () => {
  const w = new World();
  const t0 = 1_762_548_000_000;
  for (let s = 0; s <= 30; s++) {
    const now = t0 + s * 1000;
    w.report(now, 32.986 + (s % 3) * 0.001, -96.75, HASH_A);
    w.report(now, 32.987 + (s % 3) * 0.001, -96.751, HASH_B);
    if (s % 3 === 0) w.tick(now);
  }
  assert.equal(w.byStatus("active").length, 2);
});

test("unmatched candidate closes after 90 s; recluster never touches campaign_id", () => {
  const w = new World();
  const t0 = 1_762_548_000_000;
  w.report(t0, 32.986, -96.75, HASH_A);
  w.report(t0 + 1000, 32.986, -96.75, HASH_A);
  w.tick(t0 + 2000);
  const [cand] = w.byStatus("candidate");
  assert.ok(cand);
  w.tracks.get(cand.id)!.campaign_id = 42; // the agent linked a campaign
  w.tick(t0 + 50_000);
  assert.equal(w.tracks.get(cand.id)!.campaign_id, 42);
  w.tick(t0 + 95_000);
  assert.equal(w.tracks.get(cand.id)!.status, "closed");
});
