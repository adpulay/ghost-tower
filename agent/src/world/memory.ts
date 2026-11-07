import type { AgentTrace, Alert, AnomalyEvent, Campaign, Prediction, Track, TraceKind } from "../types.js";
import type { World } from "./World.js";

/**
 * In-process world used by unit tests, evals and offline demos. Mirrors the reducer
 * semantics in INTERFACES.md §3. Drivers (tests / eval scenarios) mutate tracks via
 * `driverUpsertTrack`, playing the role of Role 1's `recluster`.
 */
export class MemoryWorld implements World {
  tracks = new Map<number, Track>();
  events: AnomalyEvent[] = [];
  campaigns: Campaign[] = [];
  predictions = new Map<number, Prediction>();
  traces: AgentTrace[] = [];
  alerts: Alert[] = [];
  now: () => number;
  private nextId = 1;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  // ---- driver-only (stands in for recluster / report_anomaly) ----
  driverUpsertTrack(t: Track): void {
    const prev = this.tracks.get(t.id);
    // campaign_id is owned by agent_link_campaign; keep it if the driver doesn't set one.
    this.tracks.set(t.id, { ...t, campaign_id: t.campaign_id || prev?.campaign_id || 0 });
  }
  driverAddEvent(e: Omit<AnomalyEvent, "id">): void {
    this.events.push({ ...e, id: this.nextId++ });
  }

  // ---- reads ----
  async listTracks() {
    return [...this.tracks.values()];
  }
  async getTrack(id: number) {
    return this.tracks.get(id);
  }
  async recentEvents(trackId: number, limit: number) {
    return this.events
      .filter((e) => e.track_id === trackId)
      .sort((a, b) => b.ts_ms - a.ts_ms)
      .slice(0, limit);
  }
  async getCampaign(id: number) {
    return this.campaigns.find((c) => c.id === id);
  }
  async getPrediction(trackId: number) {
    return this.predictions.get(trackId);
  }
  async listTraces(trackId?: number) {
    return trackId === undefined ? [...this.traces] : this.traces.filter((t) => t.track_id === trackId);
  }

  // ---- agent reducers ----
  async agentWriteTrace(trackId: number, kind: TraceKind, text: string) {
    this.traces.push({ id: this.nextId++, track_id: trackId, ts_ms: this.now(), kind, text });
  }
  async agentSetPrediction(p: Prediction) {
    this.predictions.set(p.track_id, { ...p });
  }
  async agentLinkCampaign(trackId: number, urlHash: string, brand: string, domainAgeDays: number) {
    let c = this.campaigns.find((x) => x.url_hash === urlHash);
    if (!c) {
      c = { id: this.nextId++, url_hash: urlHash, brand, domain_age_days: domainAgeDays, first_seen_ms: this.now() };
      this.campaigns.push(c);
    } else {
      c.brand = brand || c.brand;
      c.domain_age_days = domainAgeDays;
    }
    const t = this.tracks.get(trackId);
    if (t) t.campaign_id = c.id;
  }
  async agentRecordAlert(a: Omit<Alert, "id">) {
    this.alerts.push({ ...a, id: this.nextId++ });
  }
}
