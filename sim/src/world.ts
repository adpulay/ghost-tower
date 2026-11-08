// The simulated world: phones, blasters and benign noise. Pure + seeded; it only produces
// the reducer calls for each tick. Sinks (sinks.ts) deliver them to a server or to the
// in-process module. Labels (which phone, which blaster) stay here for the eval and are
// never sent to Spacetime.
import { createHash } from 'node:crypto';
import { coarsen, haversine, offset, type LatLon } from '../../spacetime/src/geo.ts';
import { Rng } from './rng.ts';
import { Mover } from './route.ts';
import { durationS, loadRoute, type Scenario, type Zone } from './scenario.ts';

export const DEFAULT_T0_MS = 1_762_548_000_000;
/** a phone that was just hit is left alone for this long (A.md Phase 2 step 3) */
const REHIT_MS = 60_000;
const NOISE_M = 100;
/** upload latency once the phone is back on LTE (s) */
const UPLOAD_S: [number, number] = [1, 4];

export interface ReportArgs {
  ts_ms: bigint;
  lat: number;
  lon: number;
  rat_drop: boolean;
  rat_drop_secs: number;
  sms_score: number;
  url_hash: string;
  brand: string;
  smsc_match: string;
  source: string;
}

export interface TruthArgs {
  scenario: string;
  ts_ms: bigint;
  lat: number;
  lon: number;
  on_air: boolean;
}

export type EventKind = 'blaster' | 'handover' | 'dropout' | 'garage' | 'foreign_cell' | 'real_toll';

export interface SimEvent {
  args: ReportArgs;
  kind: EventKind;
  phone: number;
  blaster?: number;
}

export interface TickOutput {
  tS: number;
  tsMs: number;
  truth: TruthArgs[];
  /** reports delivered during this tick (generated earlier; see the outbox in step()) */
  events: SimEvent[];
}

/** SHA-256 of the normalized link domain (INTERFACES §2 url_hash). */
export function urlHash(urlOrDomain: string): string {
  const d = urlOrDomain
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/:\d+$/, '')
    .replace(/^www\./, '')
    .replace(/\.$/, '');
  return createHash('sha256').update(d).digest('hex');
}

export interface Scores {
  /** per-blaster lure score range */
  lure: [number, number][];
  realToll: [number, number];
}

export function defaultScores(s: Scenario): Scores {
  return {
    lure: s.blasters.map(b => b.lure_score ?? [0.93, 0.99]),
    realToll: s.benign.real_toll_score ?? [0.55, 0.95],
  };
}

export class SimWorld {
  readonly s: Scenario;
  readonly t0Ms: number;
  readonly phones: LatLon[];
  readonly durationS: number;
  readonly movers: Mover[];
  readonly hashes: string[];
  readonly realTollHash: string;
  #lastHit: Map<number, number>[];
  #hits: Rng;
  #benign: Rng;
  #noise: Rng;
  #scores: Scores;
  #tollSchedule: number[];
  /** reports waiting to be delivered: a phone can only upload once it's off the 2G cell */
  #outbox: { dueMs: number; ev: SimEvent }[] = [];
  #upload: Rng;

  constructor(s: Scenario, opts: { t0Ms?: number; seedSuffix?: string; scores?: Scores } = {}) {
    this.s = s;
    this.t0Ms = opts.t0Ms ?? DEFAULT_T0_MS;
    const seed = s.seed + (opts.seedSuffix ?? '');
    const place = new Rng(`${seed}/phones`);
    const [la0, lo0, la1, lo1] = s.area_bbox;
    this.phones = Array.from({ length: s.phones }, () => ({ lat: place.range(la0, la1), lon: place.range(lo0, lo1) }));
    this.#hits = new Rng(`${seed}/hits`);
    this.#benign = new Rng(`${seed}/benign`);
    this.#noise = new Rng(`${seed}/noise`);
    this.#upload = new Rng(`${seed}/upload`);
    this.durationS = durationS(s);
    this.movers = s.blasters.map(b => new Mover(loadRoute(b.route), b.speed_mps, b.stops));
    this.hashes = s.blasters.map(b => urlHash(b.domain));
    this.realTollHash = urlHash(s.benign.real_toll_domain ?? 'txtag.org');
    this.#lastHit = s.blasters.map(() => new Map());
    this.#scores = opts.scores ?? defaultScores(s);
    const [w0, w1] = s.benign.real_toll_window_s ?? [0, this.durationS];
    const tr = new Rng(`${seed}/tolls`);
    this.#tollSchedule = Array.from({ length: s.benign.real_toll_texts }, () => tr.range(w0, w1)).sort((a, b) => a - b);
  }

  onAir(b: number, tS: number): boolean {
    return this.s.blasters[b].on_air.some(([a, z]) => tS >= a && tS < z);
  }

  truthKey(b: number): string {
    return `${this.s.id}#${b}`;
  }

  /** All ticks from t=0 to the end of the run. */
  *ticks(): Generator<TickOutput> {
    const dt = this.s.tick_ms / 1000;
    for (let tS = 0; tS <= this.durationS + 1e-9; tS += dt) yield this.step(+tS.toFixed(3));
  }

  step(tS: number): TickOutput {
    const tsMs = this.t0Ms + Math.round(tS * 1000);
    const truth: TruthArgs[] = [];
    const generated: SimEvent[] = [];
    const events = generated;

    this.s.blasters.forEach((b, bi) => {
      const pos = this.movers[bi].at(tS);
      const on = this.onAir(bi, tS);
      truth.push({ scenario: this.truthKey(bi), ts_ms: BigInt(tsMs), lat: pos.lat, lon: pos.lon, on_air: on });
      if (!on) return;
      const last = this.#lastHit[bi];
      const [lo, hi] = this.#scores.lure[bi];
      this.phones.forEach((p, pi) => {
        if (haversine(p.lat, p.lon, pos.lat, pos.lon) > b.range_m) return;
        if (tsMs - (last.get(pi) ?? -Infinity) < REHIT_MS) return;
        last.set(pi, tsMs);
        events.push({
          kind: 'blaster', phone: pi, blaster: bi,
          args: this.#report(p, tsMs, {
            rat_drop: true, rat_drop_secs: this.#hits.range(5, 10), sms_score: this.#hits.range(lo, hi),
            url_hash: this.hashes[bi], brand: b.brand, smsc_match: 'no',
          }),
        });
      });
    });

    this.#benignTick(tS, tsMs, generated);
    // Event time (ts_ms) is when it happened; delivery is after the 2G stay + upload latency.
    for (const ev of generated) {
      const stay = ev.args.rat_drop ? Math.min(ev.args.rat_drop_secs, 30) : 0;
      this.#outbox.push({ dueMs: tsMs + Math.round((stay + this.#upload.range(...UPLOAD_S)) * 1000), ev });
    }
    const due = this.#outbox.filter(o => o.dueMs <= tsMs);
    this.#outbox = this.#outbox.filter(o => o.dueMs > tsMs);
    due.sort((a, b) => a.dueMs - b.dueMs);
    return { tS, tsMs, truth, events: due.map(o => o.ev) };
  }

  #benignTick(tS: number, tsMs: number, out: SimEvent[]) {
    const b = this.s.benign;
    const r = this.#benign;
    const dtH = this.s.tick_ms / 3_600_000;
    const n = this.phones.length;
    const randomPhones = (rate: number, fn: (pi: number) => void) => {
      for (let k = r.poisson(rate * n * dtH); k > 0; k--) fn(r.int(n));
    };
    randomPhones(b.handover_rate_per_phone_hr, pi =>
      out.push({ kind: 'handover', phone: pi, args: this.#report(this.phones[pi], tsMs, {}) }),
    );
    randomPhones(b.dropout_rate_per_phone_hr ?? 0, pi =>
      out.push({
        kind: 'dropout', phone: pi,
        args: this.#report(this.phones[pi], tsMs, { rat_drop: true, rat_drop_secs: r.range(2, 20) }),
      }),
    );
    const zone = (zones: Zone[] | undefined, kind: EventKind, secs: [number, number]) => {
      for (const z of zones ?? []) {
        const inside = this.phones.flatMap((p, pi) => (haversine(p.lat, p.lon, z.lat, z.lon) <= z.radius_m ? [pi] : []));
        for (let k = r.poisson(z.rate_per_phone_hr * inside.length * dtH); k > 0; k--) {
          const pi = inside[r.int(inside.length)];
          out.push({
            kind, phone: pi,
            args: this.#report(this.phones[pi], tsMs, { rat_drop: true, rat_drop_secs: r.range(...secs) }),
          });
        }
      }
    };
    zone(b.garages, 'garage', [40, 300]);
    zone(b.foreign_cells, 'foreign_cell', [5, 25]);
    const dt = this.s.tick_ms / 1000;
    while (this.#tollSchedule.length && this.#tollSchedule[0] < tS + dt) {
      this.#tollSchedule.shift();
      const pi = r.int(n);
      out.push({
        kind: 'real_toll', phone: pi,
        args: this.#report(this.phones[pi], tsMs, {
          sms_score: r.range(...this.#scores.realToll), url_hash: this.realTollHash, brand: 'TxTag', smsc_match: 'yes',
        }),
      });
    }
  }

  /** A phone report: true position + ±100 m noise, then coarsened (A.md step 3). */
  #report(p: LatLon, tsMs: number, o: Partial<ReportArgs>): ReportArgs {
    const { e, n } = this.#noise.disc(NOISE_M);
    const q = offset(p, e, n);
    return {
      ts_ms: BigInt(tsMs), lat: coarsen(q.lat), lon: coarsen(q.lon),
      rat_drop: false, rat_drop_secs: 0, sms_score: 0, url_hash: '', brand: '', smsc_match: 'unknown', source: 'sim',
      ...o,
    };
  }
}

/** Optional: fetch lure / real-toll scores once from Role 2's classifier (POST /score). */
export async function classifierScores(s: Scenario, url: string): Promise<Scores> {
  const score = async (text: string) => {
    const res = await fetch(new URL('/score', url), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error(`classifier ${res.status}`);
    const { score } = (await res.json()) as { score: number };
    return [Math.max(0, score - 0.02), Math.min(1, score + 0.02)] as [number, number];
  };
  const base = defaultScores(s);
  const lure = await Promise.all(
    s.blasters.map(b =>
      score(b.lure_text ?? `${b.brand}: You have an unpaid toll of $4.35. Pay now at https://${b.domain} to avoid a $50 late fee.`),
    ),
  );
  const realToll = s.benign.real_toll_texts
    ? await score('TxTag: Your monthly statement is ready. View it at txtag.org or in the TxTag app.')
    : base.realToll;
  return { lure, realToll };
}
