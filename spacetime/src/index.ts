// Ghost Tower SpacetimeDB module: reducers from INTERFACES.md §3-§5.
//
// Publish:  spacetime publish --module-path spacetime <db-name>
// The tracking math lives in tracking.ts (pure); reducers here only move rows in and out.

import { t, SenderError } from 'spacetimedb/server';
import spacetimedb, { recluster_schedule } from './schema.ts';
import { REDUCER_PARAMS as R, REPORT_KINDS, TRACE_KINDS } from './columns.ts';
import { clamp01, fusionScore, normalizeSmsc } from './fusion.ts';
import { coarsen } from './geo.ts';
import { config, ensureSchedule, nowMs, reclusterPass, requireOperator, weights } from './logic.ts';

export default spacetimedb;

/** How far ahead of the world clock a report may be stamped. A bad timestamp would otherwise skew every map client. */
const MAX_REPORT_FUTURE_MS = 60_000;
const MAX_REPORT_CHARS = 4000;

export const init = spacetimedb.init(ctx => {
  config(ctx);
  ensureSchedule(ctx);
  ctx.db.operator.insert({ identity: ctx.sender }); // the publisher
});

// ---------------------------------------------------------------- access

/** For a database that predates the operator table: the first caller becomes the operator. Run it right after publishing. */
export const claim_operator = spacetimedb.reducer(ctx => {
  if (ctx.db.operator.count() > 0n) throw new SenderError('this database already has an operator');
  ctx.db.operator.insert({ identity: ctx.sender });
});

/** Does nothing except fail for a non-operator, so `npm run preflight` can test a token. */
export const check_operator = spacetimedb.reducer(ctx => {
  requireOperator(ctx);
});

// ---------------------------------------------------------------- ingest (§3, §4, §6)

export const report_anomaly = spacetimedb.reducer(
  R.report_anomaly(t),
  (ctx, a) => {
    if (!Number.isFinite(a.lat) || !Number.isFinite(a.lon) || Math.abs(a.lat) > 90 || Math.abs(a.lon) > 180) {
      throw new SenderError('lat/lon out of range');
    }
    if (Number(a.ts_ms) > nowMs(ctx) + MAX_REPORT_FUTURE_MS) throw new SenderError('ts_ms is too far in the future');
    if (a.url_hash.length > 128 || a.brand.length > 64) throw new SenderError('url_hash or brand is too long');
    const ev = {
      rat_drop: a.rat_drop,
      rat_drop_secs: Number.isFinite(a.rat_drop_secs) ? Math.max(0, a.rat_drop_secs) : 0,
      sms_score: clamp01(a.sms_score),
      smsc_match: normalizeSmsc(a.smsc_match),
    };
    ctx.db.anomaly_event.insert({
      id: 0n,
      ts_ms: a.ts_ms,
      // Coarsen again server-side: phones must never land exact GPS in the table (§6).
      lat: coarsen(a.lat),
      lon: coarsen(a.lon),
      ...ev,
      url_hash: a.url_hash,
      brand: a.brand,
      source: a.source === 'phone' ? 'phone' : 'sim',
      fusion_score: fusionScore(ev, weights(ctx)),
      track_id: 0n,
    });
  },
);

// ---------------------------------------------------------------- recluster (scheduled, §5)

export const recluster = spacetimedb.reducer(
  { onSchedule: recluster_schedule },
  { arg: recluster_schedule.rowType },
  ctx => {
    if (!ctx.sender.isEqual(ctx.databaseIdentity)) throw new SenderError('recluster runs on its schedule only');
    reclusterPass(ctx);
  },
);

// ---------------------------------------------------------------- agent (§3)
// Hard rule: none of these touch track.confidence or track.status.

export const agent_write_trace = spacetimedb.reducer(
  R.agent_write_trace(t),
  (ctx, a) => {
    requireOperator(ctx);
    if (!(TRACE_KINDS as readonly string[]).includes(a.kind)) {
      throw new SenderError(`kind must be one of ${TRACE_KINDS.join(', ')}`);
    }
    const text = a.text.length > 140 ? a.text.slice(0, 139) + '…' : a.text;
    ctx.db.agent_trace.insert({ id: 0n, track_id: a.track_id, ts_ms: BigInt(nowMs(ctx)), kind: a.kind, text });
  },
);

export const agent_set_prediction = spacetimedb.reducer(
  R.agent_set_prediction(t),
  (ctx, a) => {
    requireOperator(ctx);
    let path: unknown;
    try {
      path = JSON.parse(a.path_json);
    } catch {
      throw new SenderError('path_json is not valid JSON');
    }
    if (!Array.isArray(path) || !path.every(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite))) {
      throw new SenderError('path_json must be an array of [lat, lon]');
    }
    const row = { ...a, updated_ms: a.updated_ms === 0n ? BigInt(nowMs(ctx)) : a.updated_ms };
    if (ctx.db.prediction.track_id.find(a.track_id)) ctx.db.prediction.track_id.update(row);
    else ctx.db.prediction.insert(row);
  },
);

export const agent_link_campaign = spacetimedb.reducer(
  R.agent_link_campaign(t),
  (ctx, a) => {
    requireOperator(ctx);
    const tr = ctx.db.track.id.find(a.track_id);
    if (!tr) throw new SenderError(`no track ${a.track_id}`);
    let first = BigInt(nowMs(ctx));
    for (const e of ctx.db.anomaly_event.url_hash.filter(a.url_hash)) if (e.ts_ms < first) first = e.ts_ms;
    const existing = ctx.db.campaign.url_hash.find(a.url_hash);
    const camp = existing
      ? ctx.db.campaign.id.update({
          ...existing,
          brand: a.brand || existing.brand,
          domain_age_days: a.domain_age_days,
          first_seen_ms: first < existing.first_seen_ms ? first : existing.first_seen_ms,
        })
      : ctx.db.campaign.insert({
          id: 0n, url_hash: a.url_hash, brand: a.brand, domain_age_days: a.domain_age_days, first_seen_ms: first,
        });
    ctx.db.track.id.update({ ...tr, campaign_id: camp.id });
  },
);

export const agent_record_alert = spacetimedb.reducer(
  R.agent_record_alert(t),
  (ctx, a) => {
    requireOperator(ctx);
    ctx.db.alert.insert({ id: 0n, ...a, sent_ms: a.sent_ms === 0n ? BigInt(nowMs(ctx)) : a.sent_ms });
  },
);

/** Saves the police brief or registrar report for a track, replacing any earlier one of that kind. */
export const agent_save_report = spacetimedb.reducer(
  R.agent_save_report(t),
  (ctx, a) => {
    requireOperator(ctx);
    if (!(REPORT_KINDS as readonly string[]).includes(a.kind)) {
      throw new SenderError(`kind must be one of ${REPORT_KINDS.join(', ')}`);
    }
    const row = { track_id: a.track_id, kind: a.kind, text: a.text.slice(0, MAX_REPORT_CHARS), generated: a.generated, updated_ms: BigInt(nowMs(ctx)) };
    const existing = [...ctx.db.case_report.track_id.filter(a.track_id)].find(r => r.kind === a.kind);
    if (existing) ctx.db.case_report.id.update({ ...existing, ...row });
    else ctx.db.case_report.insert({ id: 0n, ...row });
  },
);

// ---------------------------------------------------------------- simulator + dev

export const sim_write_truth = spacetimedb.reducer(
  R.sim_write_truth(t),
  (ctx, a) => {
    requireOperator(ctx);
    ctx.db.sim_truth.insert(a);
    const c = config(ctx);
    if (a.ts_ms > c.sim_now_ms) ctx.db.dev_config.id.update({ ...c, sim_now_ms: a.ts_ms });
  },
);

/** Ablation knob (TESTING.md §2c). Affects events ingested after the call. */
export const dev_set_fusion_weights = spacetimedb.reducer(
  R.dev_set_fusion_weights(t),
  (ctx, a) => {
    requireOperator(ctx);
    for (const v of Object.values(a)) if (!Number.isFinite(v) || v < 0 || v > 1) throw new SenderError('weights must be in [0, 1]');
    ctx.db.dev_config.id.update({ ...config(ctx), ...a });
  },
);

/** Clears all world tables for a rehearsal. Keeps fusion weights; resets the sim clock. */
export const reset_world = spacetimedb.reducer(ctx => {
  requireOperator(ctx);
  ctx.db.anomaly_event.clear();
  ctx.db.track.clear();
  ctx.db.campaign.clear();
  ctx.db.agent_trace.clear();
  ctx.db.prediction.clear();
  ctx.db.alert.clear();
  ctx.db.case_report.clear();
  ctx.db.sim_truth.clear();
  ctx.db.dev_config.id.update({ ...config(ctx), sim_now_ms: 0n });
  ensureSchedule(ctx);
});
