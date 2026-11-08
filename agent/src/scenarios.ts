// Synthetic track timelines for agent evals and offline demos. These stand in for Role 1's
// simulator + recluster output (they drive the `track` table directly), so the agent can be
// evaluated before / independently of the full pipeline. Scenario IDs match TESTING.md §1.

import { destination, seededRandom } from "./geo.js";
import { urlHash } from "./knownDomains.js";
import type { LatLon, Track } from "./types.js";
import type { MemoryWorld } from "./world/memory.js";

export interface Leg {
  /** Seconds from scenario start when this leg begins. */
  t: number;
  heading_deg: number;
  speed_mps: number;
}

export interface StatusChange {
  t: number;
  status: Track["status"];
  /** Teleport the track (e.g. blaster back on air 2 km away). */
  jumpTo?: LatLon;
}

export interface ScriptedTrack {
  id: number;
  start: LatLon;
  domain: string;
  brand: string;
  legs: Leg[];
  statuses: StatusChange[];
}

export interface Scenario {
  id: string;
  durationS: number;
  tracks: ScriptedTrack[];
  /** Times (s) at which a track makes a real turn; the agent should replan after each. */
  turns: { trackId: number; t: number }[];
}

// recluster fits heading over a 90 s window, so a 90° turn swings the track heading over ~25 s
// (measured against the real module with spacetime/scripts/smoke.ts).
const TURN_RAMP_S = 25;

export const SCENARIOS: Record<string, Scenario> = {
  "demo-01": {
    id: "demo-01",
    durationS: 170,
    tracks: [
      {
        id: 1,
        start: [32.9858, -96.7745],
        domain: "txtag-pay-demo.example",
        brand: "TxTag",
        legs: [
          { t: 0, heading_deg: 90, speed_mps: 11 }, // Campbell Rd east
          { t: 90, heading_deg: 0, speed_mps: 10 }, // turn north onto Coit Rd
        ],
        statuses: [
          { t: 0, status: "candidate" },
          { t: 20, status: "active" },
        ],
      },
    ],
    turns: [{ trackId: 1, t: 90 }],
  },
  "turns-01": {
    id: "turns-01",
    durationS: 240,
    tracks: [
      {
        id: 1,
        start: [32.975, -96.77],
        domain: "ntta-tolls-demo.example",
        brand: "NTTA",
        legs: [
          { t: 0, heading_deg: 90, speed_mps: 12 },
          { t: 70, heading_deg: 0, speed_mps: 10 },
          { t: 130, heading_deg: 90, speed_mps: 12 },
          { t: 190, heading_deg: 180, speed_mps: 10 },
        ],
        statuses: [
          { t: 0, status: "candidate" },
          { t: 20, status: "active" },
        ],
      },
    ],
    turns: [
      { trackId: 1, t: 70 },
      { trackId: 1, t: 130 },
      { trackId: 1, t: 190 },
    ],
  },
  "offon-01": {
    id: "offon-01",
    durationS: 330,
    tracks: [
      {
        id: 1,
        start: [32.98, -96.765],
        domain: "usps-redelivery-demo.example",
        brand: "USPS",
        legs: [{ t: 0, heading_deg: 90, speed_mps: 11 }],
        statuses: [
          { t: 0, status: "candidate" },
          { t: 20, status: "active" },
          { t: 80, status: "dormant" }, // blaster off ~3 min
          { t: 260, status: "active", jumpTo: [32.995, -96.75] }, // back on air ~2 km away
        ],
      },
    ],
    turns: [],
  },
  "twin-01": {
    id: "twin-01",
    durationS: 180,
    tracks: [
      {
        id: 1,
        start: [32.98, -96.77],
        domain: "txtag-pay-demo.example",
        brand: "TxTag",
        legs: [{ t: 0, heading_deg: 90, speed_mps: 11 }],
        statuses: [
          { t: 0, status: "candidate" },
          { t: 20, status: "active" },
        ],
      },
      {
        id: 2,
        start: [32.9935, -96.77],
        domain: "chase-verify-demo.example",
        brand: "Chase",
        legs: [
          { t: 0, heading_deg: 90, speed_mps: 9 },
          { t: 100, heading_deg: 180, speed_mps: 9 },
        ],
        statuses: [
          { t: 0, status: "candidate" },
          { t: 25, status: "active" },
        ],
      },
    ],
    turns: [{ trackId: 2, t: 100 }],
  },
};

/** Advances scripted tracks second-by-second and writes them (and events) into a MemoryWorld. */
export class ScenarioDriver {
  private pos = new Map<number, LatLon>();
  private rnd: () => number;

  constructor(private sc: Scenario, private world: MemoryWorld, private startMs: number, seed = sc.id) {
    for (const t of sc.tracks) this.pos.set(t.id, t.start);
    this.rnd = seededRandom(seed);
  }

  /** Apply the world state at scenario second `s` (call once per second, in order). */
  step(s: number): void {
    const nowMs = this.startMs + s * 1000;
    for (const st of this.sc.tracks) {
      const status = [...st.statuses].reverse().find((x) => x.t <= s)!;
      if (status.jumpTo && status.t === s) this.pos.set(st.id, status.jumpTo);
      const { heading, speed } = headingAt(st, s);
      const onAir = status.status !== "dormant" && status.status !== "closed";
      let p = this.pos.get(st.id)!;
      if (onAir && s > 0) p = destination(p, heading, speed);
      this.pos.set(st.id, p);

      const prev = this.world.tracks.get(st.id);
      const conf = status.status === "active" ? 0.85 + 0.1 * this.rnd() : status.status === "candidate" ? 0.5 : prev?.confidence ?? 0.5;
      this.world.driverUpsertTrack({
        id: st.id,
        lat: p[0],
        lon: p[1],
        heading_deg: heading,
        speed_mps: onAir ? speed : 0,
        confidence: conf,
        event_count: onAir ? Math.min(40, 5 + s) : 0,
        status: status.status,
        campaign_id: prev?.campaign_id ?? 0,
        updated_ms: nowMs,
      });
      if (onAir) {
        const jitter = () => (this.rnd() - 0.5) * 0.002;
        this.world.driverAddEvent({
          ts_ms: nowMs,
          lat: round3(p[0] + jitter()),
          lon: round3(p[1] + jitter()),
          rat_drop: true,
          rat_drop_secs: 5 + 5 * this.rnd(),
          sms_score: 0.9 + 0.09 * this.rnd(),
          url_hash: urlHash(st.domain),
          brand: st.brand,
          smsc_match: "no",
          fusion_score: 0.95,
          source: "sim",
          track_id: st.id,
        });
      }
    }
  }
}

function headingAt(st: ScriptedTrack, s: number): { heading: number; speed: number } {
  let i = 0;
  while (i + 1 < st.legs.length && st.legs[i + 1].t <= s) i++;
  const leg = st.legs[i];
  const prev = st.legs[i - 1];
  if (prev && s - leg.t < TURN_RAMP_S) {
    const f = (s - leg.t + 1) / TURN_RAMP_S;
    let d = leg.heading_deg - prev.heading_deg;
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    return { heading: (prev.heading_deg + d * f + 360) % 360, speed: leg.speed_mps };
  }
  return { heading: leg.heading_deg, speed: leg.speed_mps };
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;
