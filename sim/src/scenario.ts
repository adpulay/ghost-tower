// Scenario files: sim/scenarios/<id>.json. Format extends the example in A.md Phase 2.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SIM_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

export interface Stop {
  /** distance along the route where the blaster stops (m) */
  at_m: number;
  dur_s: number;
}

export interface BlasterSpec {
  /** route file relative to sim/, e.g. "routes/demo.json" */
  route: string;
  speed_mps: number;
  range_m: number;
  /** transmit windows in seconds since scenario start: [[start, end], ...] */
  on_air: [number, number][];
  brand: string;
  /** phishing domain in the lure (always a .example demo domain) */
  domain: string;
  stops?: Stop[];
  /** cached classifier score range for this lure, used when no classifier endpoint is set */
  lure_score?: [number, number];
  /** lure text, sent to the classifier /score endpoint when CLASSIFIER_URL is set */
  lure_text?: string;
}

export interface Zone {
  lat: number;
  lon: number;
  radius_m: number;
  /** reports per phone-hour for phones inside the zone */
  rate_per_phone_hr: number;
}

export interface BenignSpec {
  /** rat_drop=false network handovers, per phone-hour */
  handover_rate_per_phone_hr: number;
  /** short LTE->2G->LTE dropouts with no SMS, per phone-hour */
  dropout_rate_per_phone_hr?: number;
  /** total real toll texts (smsc_match="yes") delivered during the run */
  real_toll_texts: number;
  /** window (s) the real toll texts go out in; defaults to the whole run */
  real_toll_window_s?: [number, number];
  real_toll_score?: [number, number];
  real_toll_domain?: string;
  /** parking garages: long 2G stays (> 30 s, ignored by fusion) */
  garages?: Zone[];
  /** a "foreign" 2G cell near a border: short 2G drops, never any SMS */
  foreign_cells?: Zone[];
}

export interface Scenario {
  id: string;
  description?: string;
  /** "attack" scenarios have blasters; "benign" ones must produce zero active tracks */
  kind: 'attack' | 'benign';
  seed: string;
  phones: number;
  /** [min_lat, min_lon, max_lat, max_lon] */
  area_bbox: [number, number, number, number];
  blasters: BlasterSpec[];
  benign: BenignSpec;
  tick_ms: number;
  /** run length (s); defaults to last on_air end + 150 s so tracks can go dormant */
  duration_s?: number;
}

export interface Route {
  name: string;
  points: [number, number][];
  length_m: number;
  roads: string[];
}

export function scenarioPath(id: string): string {
  return id.endsWith('.json') ? id : join(SIM_DIR, 'scenarios', `${id}.json`);
}

export function loadScenario(id: string): Scenario {
  const s = JSON.parse(readFileSync(scenarioPath(id), 'utf8')) as Scenario;
  s.id ??= id;
  s.blasters ??= [];
  s.kind ??= s.blasters.length ? 'attack' : 'benign';
  s.tick_ms ??= 1000;
  validate(s);
  return s;
}

export function listScenarios(): string[] {
  return readdirSync(join(SIM_DIR, 'scenarios'))
    .filter(f => f.endsWith('.json'))
    .map(f => f.slice(0, -5))
    .sort();
}

export function loadRoute(rel: string): Route {
  return JSON.parse(readFileSync(join(SIM_DIR, rel), 'utf8')) as Route;
}

export function durationS(s: Scenario): number {
  if (s.duration_s) return s.duration_s;
  const ends = s.blasters.flatMap(b => b.on_air.map(w => w[1]));
  return (ends.length ? Math.max(...ends) : 450) + 150;
}

function validate(s: Scenario) {
  const fail = (m: string) => {
    throw new Error(`scenario ${s.id}: ${m}`);
  };
  if (!s.seed) fail('seed is required');
  if (!(s.phones > 0)) fail('phones must be > 0');
  if (s.area_bbox?.length !== 4 || s.area_bbox[0] >= s.area_bbox[2] || s.area_bbox[1] >= s.area_bbox[3]) {
    fail('area_bbox must be [min_lat, min_lon, max_lat, max_lon]');
  }
  for (const b of s.blasters) {
    if (!(b.speed_mps >= 0) || !(b.range_m > 0)) fail('blaster needs speed_mps >= 0 and range_m > 0');
    if (!b.domain.endsWith('.example')) fail(`blaster domain ${b.domain} must be a .example demo domain`);
    for (const [a, z] of b.on_air) if (!(z > a)) fail('on_air windows must be [start, end] with end > start');
  }
}
