import { useEffect, useState } from "react";
import type { AgentTraceRow, TraceData, TrackHeaderRow } from "./types";

export interface PollOptions {
  /** e.g. "https://maincloud.spacetimedb.com" or "http://localhost:3000" */
  host: string;
  database: string;
  token?: string;
  intervalMs?: number;
}

interface SqlResult {
  schema: { elements: { name: { some?: string } | string | null }[] };
  rows: unknown[][];
}

function decode<T>(results: SqlResult[]): T[] {
  return results.flatMap((r) => {
    const names = r.schema.elements.map((e, i) => (typeof e.name === "string" ? e.name : e.name?.some ?? `col${i}`));
    return r.rows.map((row) => Object.fromEntries(names.map((n, i) => [n, row[i]])) as T);
  });
}

async function sql<T>(o: PollOptions, q: string): Promise<T[]> {
  const res = await fetch(`${o.host}/v1/database/${encodeURIComponent(o.database)}/sql`, {
    method: "POST",
    headers: { "Content-Type": "text/plain", ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}) },
    body: q,
  });
  if (!res.ok) throw new Error(`sql ${res.status}`);
  return decode<T>(await res.json());
}

/**
 * Standalone fallback data source: polls Spacetime's HTTP SQL endpoint for the selected
 * track's row and agent_trace rows. Prefer passing rows from Role 3's shared Spacetime
 * subscription hook straight into <TracePanel>; use this only when that isn't available.
 */
export function usePolledTraceData(trackId: number | null | undefined, opts: PollOptions): TraceData & { error?: string } {
  const [data, setData] = useState<TraceData & { error?: string }>({ track: null, traces: [] });
  useEffect(() => {
    if (trackId == null || !Number.isInteger(trackId)) {
      setData({ track: null, traces: [] });
      return;
    }
    let alive = true;
    const load = async () => {
      try {
        const [tracks, traces] = await Promise.all([
          sql<TrackHeaderRow>(opts, `SELECT * FROM track WHERE id = ${trackId}`),
          sql<AgentTraceRow>(opts, `SELECT * FROM agent_trace WHERE track_id = ${trackId}`),
        ]);
        if (alive) setData({ track: tracks[0] ?? null, traces });
      } catch (e) {
        if (alive) setData((d) => ({ ...d, error: String(e) }));
      }
    };
    void load();
    const t = setInterval(load, opts.intervalMs ?? 1000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [trackId, opts.host, opts.database, opts.token, opts.intervalMs]);
  return data;
}
