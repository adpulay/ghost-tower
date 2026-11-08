// Rows for the patrol view, from the app's one shared connection, so the tablet also works on simulated data.
// No anomaly_event and no sim_truth here: the officer only needs where to go.
import { useMemo } from 'react';
import { useTables } from '../spacetime/SpacetimeContext';
import type { PredictionRow, TraceRow, TrackRow } from './patrolModel.ts';

export function usePatrolData() {
  const { tables, status } = useTables();
  return useMemo(() => {
    const tracks: TrackRow[] = tables.track.map(t => ({ ...t, id: BigInt(t.id), updated_ms: BigInt(t.updated_ms) }));
    const predictions: PredictionRow[] = tables.prediction.map(p => ({
      ...p, track_id: BigInt(p.track_id), updated_ms: BigInt(p.updated_ms),
    }));
    const traces: TraceRow[] = tables.agent_trace
      .filter(r => r.kind === 'replan')
      .map(r => ({ ...r, id: BigInt(r.id), track_id: BigInt(r.track_id), ts_ms: BigInt(r.ts_ms) }));
    return { tracks, predictions, traces, ready: status === 'connected', lost: status === 'error' };
  }, [tables, status]);
}
