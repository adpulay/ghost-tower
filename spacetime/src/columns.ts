// Column definitions for every table in INTERFACES.md §2, written once and shared by the
// module (spacetimedb/server) and the hand-written client bindings (spacetimedb). Both
// entry points export the same `t` builder type, so the caller passes in its own copy.

import type { t as T } from 'spacetimedb/server';
type TB = typeof T;

export const TABLE_COLUMNS = {
  anomaly_event: (t: TB) => ({
    id: t.u64().primaryKey().autoInc(),
    ts_ms: t.u64(),
    lat: t.f64(),
    lon: t.f64(),
    rat_drop: t.bool(),
    rat_drop_secs: t.f32(),
    sms_score: t.f32(),
    url_hash: t.string().index('btree'),
    brand: t.string(),
    smsc_match: t.string(),
    fusion_score: t.f32(),
    source: t.string(),
    track_id: t.u64().index('btree'),
  }),
  track: (t: TB) => ({
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
  }),
  campaign: (t: TB) => ({
    id: t.u64().primaryKey().autoInc(),
    url_hash: t.string().unique(),
    brand: t.string(),
    domain_age_days: t.i32(),
    first_seen_ms: t.u64(),
  }),
  agent_trace: (t: TB) => ({
    id: t.u64().primaryKey().autoInc(),
    track_id: t.u64().index('btree'),
    ts_ms: t.u64(),
    kind: t.string(),
    text: t.string(),
  }),
  prediction: (t: TB) => ({
    track_id: t.u64().primaryKey(),
    path_json: t.string(),
    intercept_lat: t.f64(),
    intercept_lon: t.f64(),
    eta_s: t.u32(),
    updated_ms: t.u64(),
  }),
  alert: (t: TB) => ({
    id: t.u64().primaryKey().autoInc(),
    track_id: t.u64(),
    zone_json: t.string(),
    message: t.string(),
    sent_ms: t.u64(),
    recipients: t.u32(),
  }),
  // Simulator ground truth. `scenario` is "<scenario-id>#<blaster-index>" so multi-blaster
  // runs (twin-01) can be scored per blaster.
  sim_truth: (t: TB) => ({
    scenario: t.string(),
    ts_ms: t.u64(),
    lat: t.f64(),
    lon: t.f64(),
    on_air: t.bool(),
  }),
  // Evidence packet for a track: the police brief and the registrar abuse report (one row per track + kind).
  // `generated` is false when the fixed template was used instead of model text, so the UI can say which it is.
  case_report: (t: TB) => ({
    id: t.u64().primaryKey().autoInc(),
    track_id: t.u64().index('btree'),
    kind: t.string(),
    text: t.string(),
    generated: t.bool(),
    updated_ms: t.u64(),
  }),
  // Role 1 dev knobs (single row, id = 0): fusion weights for the ablation, and the
  // simulator clock so `--speed 4x` runs age events on sim time, not wall time.
  dev_config: (t: TB) => ({
    id: t.u32().primaryKey(),
    w_rat: t.f32(),
    w_sms: t.f32(),
    w_smsc: t.f32(),
    smsc_bonus: t.f32(),
    sim_now_ms: t.u64(),
  }),
} as const;

/** Argument lists of the client-callable reducers (INTERFACES.md §3). */
export const REDUCER_PARAMS = {
  report_anomaly: (t: TB) => ({
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
  }),
  agent_write_trace: (t: TB) => ({ track_id: t.u64(), kind: t.string(), text: t.string() }),
  agent_set_prediction: (t: TB) => ({
    track_id: t.u64(),
    path_json: t.string(),
    intercept_lat: t.f64(),
    intercept_lon: t.f64(),
    eta_s: t.u32(),
    updated_ms: t.u64(),
  }),
  agent_link_campaign: (t: TB) => ({ track_id: t.u64(), url_hash: t.string(), brand: t.string(), domain_age_days: t.i32() }),
  agent_record_alert: (t: TB) => ({ track_id: t.u64(), zone_json: t.string(), message: t.string(), sent_ms: t.u64(), recipients: t.u32() }),
  agent_save_report: (t: TB) => ({ track_id: t.u64(), kind: t.string(), text: t.string(), generated: t.bool() }),
  sim_write_truth: (t: TB) => ({ scenario: t.string(), ts_ms: t.u64(), lat: t.f64(), lon: t.f64(), on_air: t.bool() }),
  dev_set_fusion_weights: (t: TB) => ({ w_rat: t.f32(), w_sms: t.f32(), w_smsc: t.f32(), smsc_bonus: t.f32() }),
} as const;

/** Tables every client may subscribe to. */
export const PUBLIC_TABLES = [
  'anomaly_event', 'track', 'campaign', 'agent_trace', 'prediction', 'alert', 'sim_truth', 'dev_config', 'case_report',
] as const;

export const TRACE_KINDS = ['plan', 'tool_call', 'tool_result', 'replan', 'summary'] as const;
export const REPORT_KINDS = ['police', 'registrar'] as const;
