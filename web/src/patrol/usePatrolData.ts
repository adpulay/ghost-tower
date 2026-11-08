// Live rows for the patrol view. Uses `spacetimedb/react` under the SpacetimeDBProvider from
// Role 3's app shell, and the bindings at web/src/module_bindings (generated with
// `spacetime generate`, or copied from spacetime/bindings). Note: no anomaly_event and no
// sim_truth here; the officer only needs where to go.
import { useTable } from 'spacetimedb/react';
import { tables } from '../module_bindings';
import type { PredictionRow, TraceRow, TrackRow } from './patrolModel.ts';

export function usePatrolData() {
  const [tracks, t1] = useTable(tables.track);
  const [predictions, t2] = useTable(tables.prediction);
  const [traces, t3] = useTable(tables.agent_trace.where(r => r.kind.eq('replan')));
  return {
    tracks: tracks as readonly TrackRow[],
    predictions: predictions as readonly PredictionRow[],
    traces: traces as readonly TraceRow[],
    ready: t1 && t2 && t3,
  };
}
