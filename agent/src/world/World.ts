import type { AgentTrace, Alert, AnomalyEvent, Campaign, Prediction, Track, TraceKind } from "../types.js";

/**
 * Everything the agent reads from / writes to Spacetime.
 *
 * The write side is exactly the agent reducers from INTERFACES.md §3. There is deliberately
 * no way to write `track.confidence` or `track.status` through this interface.
 */
export interface World {
  // ---- reads ----
  listTracks(): Promise<Track[]>;
  getTrack(trackId: number): Promise<Track | undefined>;
  recentEvents(trackId: number, limit: number): Promise<AnomalyEvent[]>;
  getCampaign(campaignId: number): Promise<Campaign | undefined>;
  getPrediction(trackId: number): Promise<Prediction | undefined>;
  listTraces(trackId?: number): Promise<AgentTrace[]>;

  // ---- agent reducers ----
  agentWriteTrace(trackId: number, kind: TraceKind, text: string): Promise<void>;
  agentSetPrediction(p: Prediction): Promise<void>;
  agentLinkCampaign(trackId: number, urlHash: string, brand: string, domainAgeDays: number): Promise<void>;
  agentRecordAlert(a: Omit<Alert, "id">): Promise<void>;
}
