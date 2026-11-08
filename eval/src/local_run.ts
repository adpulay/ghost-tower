// Run one scenario in-process (real module on the SDK's test datastore) and record it.
import { offset, project } from '../../spacetime/src/geo.ts';
import type { FusionWeights } from '../../spacetime/src/fusion.ts';
import { localSink } from '../../sim/src/sinks.ts';
import type { Scenario } from '../../sim/src/scenario.ts';
import { SimWorld, type SimEvent } from '../../sim/src/world.ts';
import type { AlertRec, RunRecord, Snapshot } from './metrics.ts';

export interface LocalRunOpts {
  seedSuffix?: string;
  weights?: FusionWeights;
  /**
   * Stand-in for Role 2's agent so "protected before hit" can be scored without it: when a
   * track is active, every 30 s "send" a warning to a corridor 600 m either side of a
   * straight-line 5 min projection. Recorded only in the eval, never written to Spacetime.
   */
  mockAlerts?: boolean;
  /** override phone count (load test) */
  phones?: number;
}

const ALERT_EVERY_MS = 30_000;
const ALERT_HORIZON_S = 300;
const ALERT_HALF_WIDTH_M = 600;

export function corridor(lat: number, lon: number, heading: number, speed: number): [number, number][] {
  const start = { lat, lon };
  const end = project(start, heading, Math.max(300, speed * ALERT_HORIZON_S));
  const h = (heading * Math.PI) / 180;
  const side = (p: { lat: number; lon: number }, s: number) =>
    offset(p, Math.cos(h) * ALERT_HALF_WIDTH_M * s, -Math.sin(h) * ALERT_HALF_WIDTH_M * s);
  const back = project(start, heading, -ALERT_HALF_WIDTH_M);
  return [side(back, 1), side(end, 1), side(end, -1), side(back, -1)].map(p => [p.lat, p.lon]);
}

export async function runLocal(scenario: Scenario, opts: LocalRunOpts = {}): Promise<RunRecord> {
  const s = opts.phones ? { ...scenario, phones: opts.phones } : scenario;
  const world = new SimWorld(s, { seedSuffix: opts.seedSuffix });
  const snapshots: Snapshot[] = [];
  const reclusterMs: number[] = [];
  const alerts: AlertRec[] = [];
  const lastAlert = new Map<bigint, number>();
  let currentTruth: Snapshot['truth'] = [];

  const sink = await localSink(world.t0Ms, (nowMs, ms) => {
    reclusterMs.push(ms);
    const tracks = sink.world.rows('track').filter(t => t.status !== 'closed');
    snapshots.push({
      tMs: nowMs,
      truth: currentTruth,
      tracks: tracks.map(t => ({ id: t.id, lat: t.lat, lon: t.lon, status: t.status })),
    });
    if (opts.mockAlerts) {
      for (const t of tracks) {
        if (t.status !== 'active' || nowMs - (lastAlert.get(t.id) ?? -Infinity) < ALERT_EVERY_MS) continue;
        lastAlert.set(t.id, nowMs);
        alerts.push({ sentMs: nowMs, zone: corridor(t.lat, t.lon, t.heading_deg, t.speed_mps) });
      }
    }
  });
  if (opts.weights) await sink.setWeights(opts.weights);

  const labels: SimEvent[] = [];
  const firstOnAirMs: number[] = s.blasters.map(() => Infinity);
  for (const tick of world.ticks()) {
    currentTruth = tick.truth.map(t => ({ lat: t.lat, lon: t.lon, onAir: t.on_air }));
    tick.truth.forEach((t, b) => {
      if (t.on_air) firstOnAirMs[b] = Math.min(firstOnAirMs[b], tick.tsMs);
    });
    labels.push(...tick.events);
    await sink.tick(tick.tsMs, tick.truth, tick.events.map(e => e.args));
  }

  // Event ids are assigned in insertion order, so sorted rows line up with the labels.
  const rows = sink.world.rows('anomaly_event').sort((a, b) => (a.id < b.id ? -1 : 1));
  if (rows.length !== labels.length) throw new Error(`event count mismatch ${rows.length} vs ${labels.length}`);
  const events = rows.map((e, i) => ({
    id: e.id, tsMs: Number(e.ts_ms), lat: e.lat, lon: e.lon, trackId: e.track_id,
    isTrue: labels[i].kind === 'blaster', phone: labels[i].phone,
  }));

  return {
    scenario: s.id,
    kind: s.kind,
    blasters: s.blasters.length,
    phoneHours: (s.phones * world.durationS) / 3600,
    firstOnAirMs,
    snapshots,
    events,
    alerts,
    phones: world.phones,
    reclusterMs,
  };
}
