// Pure logic for the patrol tablet: which track to follow, what the status line says,
// and how much ETA is left. No React, no Leaflet, so it is unit-tested in Node.

export interface TrackRow {
  id: bigint;
  lat: number;
  lon: number;
  heading_deg: number;
  speed_mps: number;
  confidence: number;
  status: string;
  updated_ms: bigint;
}

export interface PredictionRow {
  track_id: bigint;
  path_json: string;
  intercept_lat: number;
  intercept_lon: number;
  eta_s: number;
  updated_ms: bigint;
}

export interface TraceRow {
  id: bigint;
  track_id: bigint;
  ts_ms: bigint;
  kind: string;
  text: string;
}

/** Active tracks, most confident first (ties: newest update, then lowest id). */
export function activeTracks(tracks: readonly TrackRow[]): TrackRow[] {
  return tracks
    .filter(t => t.status === 'active')
    .sort((a, b) => b.confidence - a.confidence || Number(b.updated_ms - a.updated_ms) || Number(a.id - b.id));
}

/** The track to follow: the officer's pick if it is still active, else the best active one. */
export function pickTarget(tracks: readonly TrackRow[], chosen: bigint | null): TrackRow | undefined {
  const act = activeTracks(tracks);
  return act.find(t => t.id === chosen) ?? act[0];
}

export function parsePath(json: string): [number, number][] {
  try {
    const p = JSON.parse(json);
    return Array.isArray(p) ? p.filter(x => Array.isArray(x) && x.length === 2 && x.every(Number.isFinite)) : [];
  } catch {
    return [];
  }
}

/** Seconds until the blaster reaches the intercept, counted down from the prediction's write. */
export function etaRemaining(p: PredictionRow, nowMs: number): number {
  return Math.max(0, Math.round(p.eta_s - (nowMs - Number(p.updated_ms)) / 1000));
}

export function formatEta(s: number): string {
  if (s <= 0) return 'now';
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m ? `${m}:${String(r).padStart(2, '0')}` : `${r}s`;
}

const COMPASS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
export function compass(deg: number): string {
  return COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

/**
 * The one status line at the top. The agent's latest `replan` row wins (e.g. "Target turned
 * north on Coit Rd. Intercept at Coit & Arapaho, ~3 min."); before any replan, a plain
 * description from the track + prediction.
 */
export function statusLine(
  target: TrackRow | undefined,
  traces: readonly TraceRow[],
  prediction: PredictionRow | undefined,
  nowMs: number,
): string {
  if (!target) return 'No active target. Stand by.';
  const replan = latestReplan(traces, target.id);
  if (replan) return replan.text;
  const kmh = Math.round(target.speed_mps * 3.6);
  const moving = target.speed_mps >= 1 ? `heading ${compass(target.heading_deg)} at ~${kmh} km/h` : 'stationary';
  if (!prediction) return `Target ${moving}. Waiting for intercept point…`;
  const eta = etaRemaining(prediction, nowMs);
  return `Target ${moving}. Intercept in ~${Math.max(1, Math.round(eta / 60))} min.`;
}

export function latestReplan(traces: readonly TraceRow[], trackId: bigint): TraceRow | undefined {
  let best: TraceRow | undefined;
  for (const t of traces) {
    if (t.track_id !== trackId || t.kind !== 'replan') continue;
    if (!best || t.ts_ms > best.ts_ms || (t.ts_ms === best.ts_ms && t.id > best.id)) best = t;
  }
  return best;
}
