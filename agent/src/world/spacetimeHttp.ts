import type { SpacetimeConfig } from "../config.js";
import type { AgentTrace, Alert, AnomalyEvent, Campaign, Prediction, Track, TraceKind } from "../types.js";
import type { World } from "./World.js";

/**
 * Spacetime client over the SpacetimeDB HTTP API:
 *   POST /v1/database/:db/sql            (body: SQL text)    -> reads
 *   POST /v1/database/:db/call/:reducer  (body: JSON array)  -> reducer calls
 *
 * No generated bindings needed. The service turns it into a "subscription" by polling the
 * `track` table every SPACETIME_POLL_MS (default 1 s). A WebSocket-SDK World could implement
 * the same interface later.
 *
 * Reducer argument order is the order the module declares (spacetime/src/index.ts), which is
 * the field order in INTERFACES.md §2/§3. If the module changes, change it here only.
 */
export class SpacetimeHttpWorld implements World {
  private token: string;
  constructor(private cfg: SpacetimeConfig) {
    this.token = cfg.token;
  }

  private headers(json: boolean): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": json ? "application/json" : "text/plain" };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  /** Obtain an anonymous identity token if none was configured. */
  async ensureIdentity(): Promise<void> {
    if (this.token) return;
    const res = await fetch(`${this.cfg.host}/v1/identity`, { method: "POST" });
    if (!res.ok) throw new Error(`spacetime identity: HTTP ${res.status}`);
    const body = (await res.json()) as { token?: string };
    this.token = body.token ?? "";
  }

  async sql<T>(query: string): Promise<T[]> {
    const res = await fetch(`${this.cfg.host}/v1/database/${encodeURIComponent(this.cfg.database)}/sql`, {
      method: "POST",
      headers: this.headers(false),
      body: query,
    });
    if (!res.ok) throw new Error(`spacetime sql ${res.status}: ${await res.text()}`);
    const results = (await res.json()) as SqlResult[];
    return results.flatMap((r) => decodeRows<T>(r));
  }

  async call(reducer: string, args: unknown[]): Promise<void> {
    const res = await fetch(
      `${this.cfg.host}/v1/database/${encodeURIComponent(this.cfg.database)}/call/${reducer}`,
      { method: "POST", headers: this.headers(true), body: JSON.stringify(args) },
    );
    if (!res.ok) throw new Error(`spacetime call ${reducer} ${res.status}: ${await res.text()}`);
  }

  // ---- reads ----
  listTracks() {
    return this.sql<Track>("SELECT * FROM track");
  }
  async getTrack(id: number) {
    return (await this.sql<Track>(`SELECT * FROM track WHERE id = ${int(id)}`))[0];
  }
  async recentEvents(trackId: number, limit: number) {
    const rows = await this.sql<AnomalyEvent>(`SELECT * FROM anomaly_event WHERE track_id = ${int(trackId)}`);
    return rows.sort((a, b) => b.ts_ms - a.ts_ms).slice(0, limit);
  }
  async getCampaign(id: number) {
    return (await this.sql<Campaign>(`SELECT * FROM campaign WHERE id = ${int(id)}`))[0];
  }
  async getPrediction(trackId: number) {
    return (await this.sql<Prediction>(`SELECT * FROM prediction WHERE track_id = ${int(trackId)}`))[0];
  }
  listTraces(trackId?: number) {
    return this.sql<AgentTrace>(
      trackId === undefined ? "SELECT * FROM agent_trace" : `SELECT * FROM agent_trace WHERE track_id = ${int(trackId)}`,
    );
  }

  // ---- agent reducers (INTERFACES.md §3) ----
  agentWriteTrace(trackId: number, kind: TraceKind, text: string) {
    return this.call("agent_write_trace", [trackId, kind, text]);
  }
  agentSetPrediction(p: Prediction) {
    return this.call("agent_set_prediction", [p.track_id, p.path_json, p.intercept_lat, p.intercept_lon, p.eta_s, p.updated_ms]);
  }
  agentLinkCampaign(trackId: number, urlHash: string, brand: string, domainAgeDays: number) {
    return this.call("agent_link_campaign", [trackId, urlHash, brand, domainAgeDays]);
  }
  agentRecordAlert(a: Omit<Alert, "id">) {
    return this.call("agent_record_alert", [a.track_id, a.zone_json, a.message, a.sent_ms, a.recipients]);
  }
}

function int(n: number): string {
  if (!Number.isInteger(n) || n < 0) throw new Error(`invalid id ${n}`);
  return String(n);
}

// ---- SATS JSON decoding (SpacetimeDB SQL HTTP response) ----

interface SqlResult {
  schema: { elements: { name: { some?: string } | string | null }[] };
  rows: unknown[][];
}

export function decodeRows<T>(r: SqlResult): T[] {
  const names = r.schema.elements.map((e, i) =>
    typeof e.name === "string" ? e.name : e.name && "some" in e.name && e.name.some ? e.name.some : `col${i}`,
  );
  return r.rows.map((row) => {
    const o: Record<string, unknown> = {};
    names.forEach((n, i) => (o[n] = normalizeValue(row[i])));
    return o as T;
  });
}

function normalizeValue(v: unknown): unknown {
  // u64 can arrive as a JSON number or a decimal string; ids/timestamps fit in a double.
  if (typeof v === "string" && /^\d{16,}$/.test(v)) return Number(v);
  return v;
}
