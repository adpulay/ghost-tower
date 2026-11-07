// Mirrors INTERFACES.md §2 (agent_trace, track). Read-only in this component.

export type TraceKind = "plan" | "tool_call" | "tool_result" | "replan" | "summary";

export interface AgentTraceRow {
  id: number;
  track_id: number;
  ts_ms: number;
  kind: TraceKind | string;
  text: string;
}

/** The track fields the header shows. Status and confidence are read from `track`, never computed here. */
export interface TrackHeaderRow {
  id: number;
  status: string;
  confidence: number;
  event_count?: number;
}

export interface TraceData {
  track: TrackHeaderRow | null | undefined;
  traces: AgentTraceRow[];
}
