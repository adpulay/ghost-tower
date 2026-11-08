// Ghost Tower SpacetimeDB module. Tables and reducers match INTERFACES.md §2–§5 exactly
// (snake_case table, column and reducer names, so SQL and HTTP clients use the contract names).
// The tracking math lives in ./tracking.ts as pure functions.
//
// Hard rule: only `recluster` writes track.confidence and track.status. The agent_* reducers
// never touch them.

import { schema, table, t, SenderError, type InferSchema, type ReducerCtx } from "spacetimedb/server";
import { ScheduleAt } from "spacetimedb";
import { Range } from "spacetimedb/server";
import {
  clamp01,
  coarsen,
  fusionScore,
  recluster as reclusterPass,
  WINDOW_MS,
  type EventRow,
  type TrackRow,
  type TrackState,
} from "./tracking";

// ---- tables (INTERFACES.md §2) ----

const anomalyEvent = table(
  { name: "anomaly_event", public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    ts_ms: t.u64().index("btree"),
    lat: t.f64(),
    lon: t.f64(),
    rat_drop: t.bool(),
    rat_drop_secs: t.f32(),
    sms_score: t.f32(),
    url_hash: t.string(),
    brand: t.string(),
    smsc_match: t.string(),
    fusion_score: t.f32(),
    source: t.string(),
    track_id: t.u64().index("btree"),
  },
);

const track = table(
  { name: "track", public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    lat: t.f64(),
    lon: t.f64(),
    heading_deg: t.f32(),
    speed_mps: t.f32(),
    confidence: t.f32(),
    event_count: t.u32(),
    status: t.string(),
    campaign_id: t.u64(),
    updated_ms: t.u64(),
  },
);

const campaign = table(
  { name: "campaign", public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    url_hash: t.string().unique(),
    brand: t.string(),
    domain_age_days: t.i32(),
    first_seen_ms: t.u64(),
  },
);

const agentTrace = table(
  { name: "agent_trace", public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    track_id: t.u64().index("btree"),
    ts_ms: t.u64(),
    kind: t.string(),
    text: t.string(),
  },
);

const prediction = table(
  { name: "prediction", public: true },
  {
    track_id: t.u64().primaryKey(),
    path_json: t.string(),
    intercept_lat: t.f64(),
    intercept_lon: t.f64(),
    eta_s: t.u32(),
    updated_ms: t.u64(),
  },
);

const alert = table(
  { name: "alert", public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    track_id: t.u64().index("btree"),
    zone_json: t.string(),
    message: t.string(),
    sent_ms: t.u64(),
    recipients: t.u32(),
  },
);

/** Simulator ground truth. Public so eval scripts can read it; the demo UI must not show it. */
const simTruth = table(
  { name: "sim_truth", public: true },
  {
    scenario: t.string(),
    ts_ms: t.u64(),
    lat: t.f64(),
    lon: t.f64(),
    on_air: t.bool(),
  },
);

// ---- internal tables (not part of the contract, not public) ----

/** Per-track tracking state that the contract's `track` row has no room for. */
const trackState = table(
  { name: "track_state" },
  {
    track_id: t.u64().primaryKey(),
    last_event_ms: t.u64(),
    vel_n: t.f64(),
    vel_e: t.f64(),
    url_hash: t.string(),
  },
);

/** Identities (hex) allowed to call reset_world. The publisher is added at init. */
const admin = table(
  { name: "admin" },
  {
    identity_hex: t.string().primaryKey(),
  },
);

const reclusterSchedule = table(
  { name: "recluster_schedule" },
  {
    scheduled_id: t.u64().primaryKey().autoInc(),
    scheduled_at: t.scheduleAt(),
  },
);

const spacetimedb = schema({
  anomalyEvent,
  track,
  campaign,
  agentTrace,
  prediction,
  alert,
  simTruth,
  trackState,
  admin,
  reclusterSchedule,
});
export default spacetimedb;

type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;

const RECLUSTER_EVERY_MICROS = 3_000_000n;
const TRACE_KINDS = new Set(["plan", "tool_call", "tool_result", "replan", "summary"]);
const SMSC_VALUES = new Set(["yes", "no", "unknown"]);
const SOURCES = new Set(["phone", "sim"]);
const HASH_RE = /^[0-9a-f]{64}$/;

const nowMs = (ctx: Ctx): number => Number(ctx.timestamp.microsSinceUnixEpoch / 1000n);

function ensureSchedule(ctx: Ctx): void {
  if (ctx.db.reclusterSchedule.count() > 0n) return;
  ctx.db.reclusterSchedule.insert({ scheduled_id: 0n, scheduled_at: ScheduleAt.interval(RECLUSTER_EVERY_MICROS) });
}

function requireLatLon(lat: number, lon: number): void {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    throw new SenderError("lat/lon out of range");
  }
}

function requireText(name: string, s: string, max: number): void {
  if (s.length > max) throw new SenderError(`${name} longer than ${max} chars`);
}

function requireTrack(ctx: Ctx, trackId: bigint) {
  const row = ctx.db.track.id.find(trackId);
  if (!row) throw new SenderError(`no track ${trackId}`);
  return row;
}

// ---- lifecycle ----

export const init = spacetimedb.init((ctx) => {
  ensureSchedule(ctx);
  ctx.db.admin.insert({ identity_hex: ctx.sender.toHexString() });
});

export const onConnect = spacetimedb.clientConnected((ctx) => {
  // Republishing with existing data doesn't rerun init; make sure the scheduler exists.
  ensureSchedule(ctx);
});

// ---- phone / simulator (INTERFACES.md §3, §6) ----

export const report_anomaly = spacetimedb.reducer(
  {
    ts_ms: t.u64(),
    lat: t.f64(),
    lon: t.f64(),
    rat_drop: t.bool(),
    rat_drop_secs: t.f32(),
    sms_score: t.f32(),
    url_hash: t.string(),
    brand: t.string(),
    smsc_match: t.string(),
    source: t.string(),
  },
  (ctx, a) => {
    requireLatLon(a.lat, a.lon);
    if (!SMSC_VALUES.has(a.smsc_match)) throw new SenderError("smsc_match must be yes/no/unknown");
    if (!SOURCES.has(a.source)) throw new SenderError("source must be phone/sim");
    if (a.url_hash !== "" && !HASH_RE.test(a.url_hash)) throw new SenderError("url_hash must be empty or 64 hex chars");
    requireText("brand", a.brand, 40);
    const ratDropSecs = Number.isFinite(a.rat_drop_secs) ? Math.max(0, a.rat_drop_secs) : 0;
    const smsScore = clamp01(a.sms_score);
    ctx.db.anomalyEvent.insert({
      id: 0n,
      ts_ms: a.ts_ms,
      // Coarsen again server-side: exact GPS must never be stored, whatever the client sent.
      lat: coarsen(a.lat),
      lon: coarsen(a.lon),
      rat_drop: a.rat_drop,
      rat_drop_secs: ratDropSecs,
      sms_score: smsScore,
      url_hash: a.url_hash,
      brand: a.brand,
      smsc_match: a.smsc_match,
      fusion_score: fusionScore(a.rat_drop, ratDropSecs, smsScore, a.smsc_match),
      source: a.source,
      track_id: 0n,
    });
  },
);

export const sim_write_truth = spacetimedb.reducer(
  { scenario: t.string(), ts_ms: t.u64(), lat: t.f64(), lon: t.f64(), on_air: t.bool() },
  (ctx, a) => {
    requireLatLon(a.lat, a.lon);
    requireText("scenario", a.scenario, 64);
    ctx.db.simTruth.insert(a);
  },
);

// ---- tracking (scheduled every 3 s) ----

export const recluster = spacetimedb.reducer(
  { onSchedule: reclusterSchedule },
  { timer: reclusterSchedule.rowType },
  (ctx) => {
    const now = nowMs(ctx);
    const from = BigInt(Math.max(0, now - WINDOW_MS));
    const events: EventRow[] = [];
    for (const e of ctx.db.anomalyEvent.ts_ms.filter(new Range({ tag: "included", value: from }, { tag: "unbounded" }))) {
      events.push({
        id: Number(e.id),
        ts_ms: Number(e.ts_ms),
        lat: e.lat,
        lon: e.lon,
        fusion_score: e.fusion_score,
        url_hash: e.url_hash,
        smsc_match: e.smsc_match,
        track_id: Number(e.track_id),
      });
    }
    const tracks: TrackRow[] = [];
    for (const r of ctx.db.track.iter()) {
      if (r.status === "closed") continue;
      tracks.push({
        id: Number(r.id),
        lat: r.lat,
        lon: r.lon,
        heading_deg: r.heading_deg,
        speed_mps: r.speed_mps,
        confidence: r.confidence,
        event_count: r.event_count,
        status: r.status,
        campaign_id: Number(r.campaign_id),
        updated_ms: Number(r.updated_ms),
      });
    }
    if (events.length === 0 && tracks.length === 0) return;
    const states = new Map<number, TrackState>();
    for (const s of ctx.db.trackState.iter()) {
      states.set(Number(s.track_id), {
        track_id: Number(s.track_id),
        last_event_ms: Number(s.last_event_ms),
        vel_n: s.vel_n,
        vel_e: s.vel_e,
        url_hash: s.url_hash,
      });
    }

    for (const r of reclusterPass(now, events, tracks, states)) {
      const row = {
        lat: r.track.lat,
        lon: r.track.lon,
        heading_deg: r.track.heading_deg,
        speed_mps: r.track.speed_mps,
        confidence: r.track.confidence,
        event_count: r.track.event_count,
        status: r.track.status,
        updated_ms: BigInt(r.track.updated_ms),
      };
      let id: bigint;
      if (r.id === null) {
        id = ctx.db.track.insert({ id: 0n, campaign_id: 0n, ...row }).id;
      } else {
        id = BigInt(r.id);
        const existing = ctx.db.track.id.find(id);
        if (!existing) continue;
        // campaign_id comes from the stored row: the agent may have linked one this tick.
        ctx.db.track.id.update({ ...existing, ...row });
      }
      const st = {
        track_id: id,
        last_event_ms: BigInt(r.state.last_event_ms),
        vel_n: r.state.vel_n,
        vel_e: r.state.vel_e,
        url_hash: r.state.url_hash,
      };
      if (ctx.db.trackState.track_id.find(id)) ctx.db.trackState.track_id.update(st);
      else ctx.db.trackState.insert(st);
      for (const eid of r.eventIds) {
        const ev = ctx.db.anomalyEvent.id.find(BigInt(eid));
        if (ev && ev.track_id !== id) ctx.db.anomalyEvent.id.update({ ...ev, track_id: id });
      }
    }
  },
);

// ---- agent (INTERFACES.md §3, §7). None of these can write confidence or status. ----

export const agent_write_trace = spacetimedb.reducer(
  { track_id: t.u64(), kind: t.string(), text: t.string() },
  (ctx, a) => {
    if (!TRACE_KINDS.has(a.kind)) throw new SenderError("kind must be plan/tool_call/tool_result/replan/summary");
    requireTrack(ctx, a.track_id);
    const text = a.text.length > 140 ? `${a.text.slice(0, 139)}…` : a.text;
    ctx.db.agentTrace.insert({ id: 0n, track_id: a.track_id, ts_ms: BigInt(nowMs(ctx)), kind: a.kind, text });
  },
);

export const agent_set_prediction = spacetimedb.reducer(
  {
    track_id: t.u64(),
    path_json: t.string(),
    intercept_lat: t.f64(),
    intercept_lon: t.f64(),
    eta_s: t.u32(),
    updated_ms: t.u64(),
  },
  (ctx, a) => {
    requireTrack(ctx, a.track_id);
    requireLatLon(a.intercept_lat, a.intercept_lon);
    requireText("path_json", a.path_json, 20_000);
    if (ctx.db.prediction.track_id.find(a.track_id)) ctx.db.prediction.track_id.update(a);
    else ctx.db.prediction.insert(a);
  },
);

export const agent_link_campaign = spacetimedb.reducer(
  { track_id: t.u64(), url_hash: t.string(), brand: t.string(), domain_age_days: t.i32() },
  (ctx, a) => {
    const tr = requireTrack(ctx, a.track_id);
    if (!HASH_RE.test(a.url_hash)) throw new SenderError("url_hash must be 64 hex chars");
    requireText("brand", a.brand, 40);
    let camp = ctx.db.campaign.url_hash.find(a.url_hash);
    if (camp) {
      camp = ctx.db.campaign.id.update({
        ...camp,
        brand: a.brand || camp.brand,
        domain_age_days: a.domain_age_days >= 0 ? a.domain_age_days : camp.domain_age_days,
      });
    } else {
      camp = ctx.db.campaign.insert({
        id: 0n,
        url_hash: a.url_hash,
        brand: a.brand,
        domain_age_days: a.domain_age_days,
        first_seen_ms: BigInt(nowMs(ctx)),
      });
    }
    // Only campaign_id changes; confidence and status are left exactly as recluster wrote them.
    if (tr.campaign_id !== camp.id) ctx.db.track.id.update({ ...tr, campaign_id: camp.id });
  },
);

export const agent_record_alert = spacetimedb.reducer(
  { track_id: t.u64(), zone_json: t.string(), message: t.string(), sent_ms: t.u64(), recipients: t.u32() },
  (ctx, a) => {
    requireTrack(ctx, a.track_id);
    requireText("message", a.message, 160);
    requireText("zone_json", a.zone_json, 20_000);
    ctx.db.alert.insert({ id: 0n, ...a });
  },
);

// ---- dev ----

export const reset_world = spacetimedb.reducer((ctx) => {
  if (!ctx.db.admin.identity_hex.find(ctx.sender.toHexString())) throw new SenderError("reset_world: not an admin");
  for (const r of [...ctx.db.anomalyEvent.iter()]) ctx.db.anomalyEvent.id.delete(r.id);
  for (const r of [...ctx.db.track.iter()]) ctx.db.track.id.delete(r.id);
  for (const r of [...ctx.db.trackState.iter()]) ctx.db.trackState.track_id.delete(r.track_id);
  for (const r of [...ctx.db.campaign.iter()]) ctx.db.campaign.id.delete(r.id);
  for (const r of [...ctx.db.agentTrace.iter()]) ctx.db.agentTrace.id.delete(r.id);
  for (const r of [...ctx.db.prediction.iter()]) ctx.db.prediction.track_id.delete(r.track_id);
  for (const r of [...ctx.db.alert.iter()]) ctx.db.alert.id.delete(r.id);
  for (const r of [...ctx.db.simTruth.iter()]) ctx.db.simTruth.delete(r);
  ensureSchedule(ctx);
});

/**
 * Bootstrap for a database created on the dashboard before the module was published: an update
 * publish doesn't run init, so the admin list starts empty. The first caller becomes admin; after
 * that this always fails. Call it right after the first publish (`spacetime call <db> claim_admin`).
 */
export const claim_admin = spacetimedb.reducer((ctx) => {
  if (ctx.db.admin.count() > 0n) throw new SenderError("claim_admin: an admin already exists");
  ctx.db.admin.insert({ identity_hex: ctx.sender.toHexString() });
});

/** Lets an admin allow another identity (e.g. the simulator's) to call reset_world. */
export const add_admin = spacetimedb.reducer({ identity_hex: t.string() }, (ctx, a) => {
  if (!ctx.db.admin.identity_hex.find(ctx.sender.toHexString())) throw new SenderError("add_admin: not an admin");
  const hex = a.identity_hex.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new SenderError("identity_hex must be 64 hex chars");
  if (!ctx.db.admin.identity_hex.find(hex)) ctx.db.admin.insert({ identity_hex: hex });
});
