// Where the simulator's reducer calls go.
//   LiveSink:  a real SpacetimeDB (Maincloud or local `spacetime start`) via the client SDK.
//   LocalSink: the module running in-process (spacetime/test/harness.ts); recluster is
//              driven on sim time every 3 s. No server needed; used by the eval.
import type { FusionWeights } from '../../spacetime/src/fusion.ts';
import type { ReportArgs, TruthArgs } from './world.ts';

export interface Sink {
  readonly local: boolean;
  reset(): Promise<void>;
  setWeights(w: FusionWeights): Promise<void>;
  /** deliver one tick worth of calls; `nowMs` is the sim clock */
  tick(nowMs: number, truth: TruthArgs[], reports: ReportArgs[]): Promise<void>;
  close(): Promise<void>;
}

export const RECLUSTER_EVERY_MS = 3000;

export async function localSink(t0Ms: number, onRecluster?: (nowMs: number, ms: number) => void): Promise<Sink & { world: import('../../spacetime/test/harness.ts').LocalWorld }> {
  // The stub must be registered before the harness module graph is even linked.
  await import('../../spacetime/test/sys_stub.ts');
  const { LocalWorld } = await import('../../spacetime/test/harness.ts');
  const world = new LocalWorld(t0Ms);
  let nextRecluster = t0Ms;
  return {
    local: true,
    world,
    async reset() {
      world.call('reset_world', {});
    },
    async setWeights(w) {
      world.call('dev_set_fusion_weights', w);
    },
    async tick(nowMs, truth, reports) {
      world.setNow(nowMs);
      for (const t of truth) world.call('sim_write_truth', t);
      for (const r of reports) world.call('report_anomaly', r);
      while (nowMs >= nextRecluster) {
        const start = performance.now();
        world.recluster();
        onRecluster?.(nowMs, performance.now() - start);
        nextRecluster += RECLUSTER_EVERY_MS;
      }
    },
    async close() {},
  };
}

export async function liveSink(opts: { host?: string; db?: string } = {}): Promise<Sink> {
  const { connect } = await import('../../spacetime/bindings/index.ts');
  const conn = await connect(opts);
  const r = conn.reducers;
  return {
    local: false,
    async reset() {
      await r.resetWorld({});
    },
    async setWeights(w) {
      await r.devSetFusionWeights(w);
    },
    async tick(_nowMs, truth, reports) {
      await Promise.all([...truth.map(t => r.simWriteTruth(t)), ...reports.map(a => r.reportAnomaly(a))]);
    },
    async close() {
      conn.disconnect();
    },
  };
}
