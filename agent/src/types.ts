// Row shapes from INTERFACES.md §2. Keep in sync with the contract; do not add fields.

export type TrackStatus = "candidate" | "active" | "dormant" | "closed";
export type TraceKind = "plan" | "tool_call" | "tool_result" | "replan" | "summary";
export type SmscMatch = "yes" | "no" | "unknown";

export interface AnomalyEvent {
  id: number;
  ts_ms: number;
  lat: number;
  lon: number;
  rat_drop: boolean;
  rat_drop_secs: number;
  sms_score: number;
  url_hash: string;
  brand: string;
  smsc_match: SmscMatch | string;
  fusion_score: number;
  source: string;
  track_id: number;
}

export interface Track {
  id: number;
  lat: number;
  lon: number;
  heading_deg: number;
  speed_mps: number;
  confidence: number;
  event_count: number;
  status: TrackStatus | string;
  campaign_id: number;
  updated_ms: number;
}

export interface Campaign {
  id: number;
  url_hash: string;
  brand: string;
  domain_age_days: number;
  first_seen_ms: number;
}

export interface AgentTrace {
  id: number;
  track_id: number;
  ts_ms: number;
  kind: TraceKind;
  text: string;
}

export interface Prediction {
  track_id: number;
  path_json: string;
  intercept_lat: number;
  intercept_lon: number;
  eta_s: number;
  updated_ms: number;
}

export interface Alert {
  id: number;
  track_id: number;
  zone_json: string;
  message: string;
  sent_ms: number;
  recipients: number;
}

export type LatLon = [number, number];
