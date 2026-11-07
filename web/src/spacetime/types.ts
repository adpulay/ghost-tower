// Row types mirror INTERFACES.md §2. Do not add fields here without Role 1.

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
  smsc_match: "yes" | "no" | "unknown" | string;
  fusion_score: number;
  source: "phone" | "sim" | string;
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
  status: "candidate" | "active" | "dormant" | "closed" | string;
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
  kind: "plan" | "tool_call" | "tool_result" | "replan" | "summary" | string;
  text: string;
}

export interface Prediction {
  track_id: number;
  path_json: string; // [[lat, lon], ...]
  intercept_lat: number;
  intercept_lon: number;
  eta_s: number;
  updated_ms: number;
}

export interface Alert {
  id: number;
  track_id: number;
  zone_json: string; // [[lat, lon], ...]
  message: string;
  sent_ms: number;
  recipients: number;
}

// Simulator only. Never rendered unless ?debug=1.
export interface SimTruth {
  scenario: string;
  ts_ms: number;
  lat: number;
  lon: number;
  on_air: boolean;
}

// Not a Spacetime table. Only the mock source produces these, so the map can
// show the grey "phones (sim)" dots from the layout. They are always labelled simulated.
export interface MockPhone {
  id: number;
  lat: number;
  lon: number;
}

export interface Tables {
  anomaly_event: AnomalyEvent[];
  track: Track[];
  campaign: Campaign[];
  agent_trace: AgentTrace[];
  prediction: Prediction[];
  alert: Alert[];
  sim_truth: SimTruth[];
  mock_phones: MockPhone[];
}

export const emptyTables = (): Tables => ({
  anomaly_event: [],
  track: [],
  campaign: [],
  agent_trace: [],
  prediction: [],
  alert: [],
  sim_truth: [],
  mock_phones: [],
});

export type ConnectionStatus = "connecting" | "connected" | "error";

export interface DataSource {
  mode: "mock" | "live";
  /** Begin delivering table snapshots. Returns a stop function. */
  start(
    onTables: (t: Tables) => void,
    onStatus: (s: ConnectionStatus, detail?: string) => void,
  ): () => void;
}
