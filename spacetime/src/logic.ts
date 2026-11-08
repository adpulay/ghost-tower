// Shared reducer helpers: config row, world clock, schedule, and the recluster pass.
// Kept out of index.ts because a module entry may only export reducers/tables.

import { ScheduleAt, type InferSchema, type ReducerCtx } from 'spacetimedb/server';
import type spacetimedb from './schema.ts';
import { DEFAULT_WEIGHTS, type FusionWeights } from './fusion.ts';
import { P, recluster as runRecluster, type EventIn, type TrackIn, type TrackStatus } from './tracking.ts';

export const RECLUSTER_INTERVAL_MS = 3000;

export type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;

export function config(ctx: Ctx) {
  return ctx.db.dev_config.id.find(0) ?? ctx.db.dev_config.insert({ id: 0, ...DEFAULT_WEIGHTS, sim_now_ms: 0n });
}

/** World clock: server time, or the simulator's clock if a sped-up sim is ahead of it. */
export function nowMs(ctx: Ctx): number {
  const server = Number(ctx.timestamp.toMillis());
  const sim = Number(ctx.db.dev_config.id.find(0)?.sim_now_ms ?? 0n);
  return Math.max(server, sim);
}

export function weights(ctx: Ctx): FusionWeights {
  const c = config(ctx);
  return { w_rat: c.w_rat, w_sms: c.w_sms, w_smsc: c.w_smsc, smsc_bonus: c.smsc_bonus };
}

export function ensureSchedule(ctx: Ctx) {
  if (ctx.db.recluster_schedule.count() === 0n) {
    ctx.db.recluster_schedule.insert({
      scheduled_id: 0n,
      scheduled_at: ScheduleAt.interval(BigInt(RECLUSTER_INTERVAL_MS) * 1000n),
    });
  }
}

/**
 * One recluster pass. Exported separately so the local simulator/eval can drive it on sim
 * time; on a real server only the scheduled reducer below calls it.
 */
export function reclusterPass(ctx: Ctx): { events: number; tracks: number } {
  const now = nowMs(ctx);
  const w = weights(ctx);

  // Full scan filtered by time. (A btree range scan on ts_ms would be cheaper, but the SDK's
  // local test harness can't evaluate Range objects built by module code, and we want the
  // exact same code path in eval as in production. See eval/results.md for timings.)
  const recent: EventIn[] = [];
  for (const e of ctx.db.anomaly_event.iter()) {
    const ts = Number(e.ts_ms);
    if (now - ts <= P.windowMs && ts <= now + 5_000) {
      recent.push({
        id: e.id, ts_ms: ts, lat: e.lat, lon: e.lon, fusion_score: e.fusion_score,
        url_hash: e.url_hash, smsc_match: e.smsc_match, track_id: e.track_id,
      });
    }
  }

  const tracks: TrackIn[] = [];
  for (const tr of ctx.db.track.iter()) {
    if (tr.status === 'closed') continue;
    let lastMs = -Infinity;
    let hash = '';
    for (const e of ctx.db.anomaly_event.track_id.filter(tr.id)) {
      const ts = Number(e.ts_ms);
      if (ts > lastMs) {
        lastMs = ts;
        hash = e.url_hash;
      }
    }
    tracks.push({
      ...tr,
      status: tr.status as TrackStatus,
      updated_ms: Number(tr.updated_ms),
      url_hash: hash,
      last_event_ms: Number.isFinite(lastMs) ? lastMs : Number(tr.updated_ms),
    });
  }

  const res = runRecluster(recent, tracks, now, w);

  const idMap = new Map<bigint, bigint>();
  for (const c of res.created) {
    const row = ctx.db.track.insert({ ...c, id: 0n, updated_ms: BigInt(Math.round(c.updated_ms)) });
    idMap.set(c.id, row.id);
  }
  for (const u of res.updated) {
    ctx.db.track.id.update({ ...u, updated_ms: BigInt(Math.round(u.updated_ms)) });
  }
  for (const e of recent) {
    const raw = res.assign.get(e.id);
    if (raw === undefined) continue;
    const tid = raw < 0n ? idMap.get(raw) : raw;
    if (tid === undefined || tid === e.track_id) continue;
    const row = ctx.db.anomaly_event.id.find(e.id);
    if (row) ctx.db.anomaly_event.id.update({ ...row, track_id: tid });
  }
  return { events: recent.length, tracks: tracks.length + res.created.length };
}
