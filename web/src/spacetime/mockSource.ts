import { bearingDeg, haversineM, lerp, offsetM, type LatLon } from "./geo";
import {
  emptyTables,
  type AnomalyEvent,
  type ConnectionStatus,
  type DataSource,
} from "./types";

/**
 * Simulated world for building the map before Role 1's schema is live.
 * Everything here is fake and the UI tags it "simulated". The real route and
 * scenario live in sim/ (Role 1); this one only exercises the same table shapes.
 */

// East along a Campbell Rd-ish line, then a turn north. Illustrative, not surveyed.
const ROUTE: LatLon[] = [
  [32.9856, -96.768],
  [32.9856, -96.756],
  [32.9856, -96.744],
  [32.9925, -96.744],
  [32.9995, -96.744],
];
const SPEED_MPS = 22;
const RANGE_M = 350;
const WINDOW_MS = 120_000;
const TICK_MS = 1000;
const PHONE_COUNT = 90;
const BRAND = "TxTag";
const URL_HASH = "3f9a5c1e0d7b";
const RESTART_AFTER_MS = 15_000;

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const segLens = ROUTE.slice(1).map((p, i) => haversineM(ROUTE[i], p));
const ROUTE_LEN = segLens.reduce((a, b) => a + b, 0);

function routeAt(dist: number): { pos: LatLon; heading: number } {
  let d = Math.max(0, Math.min(dist, ROUTE_LEN));
  for (let i = 0; i < segLens.length; i++) {
    if (d <= segLens[i] || i === segLens.length - 1) {
      const t = segLens[i] === 0 ? 0 : d / segLens[i];
      return {
        pos: lerp(ROUTE[i], ROUTE[i + 1], t),
        heading: bearingDeg(ROUTE[i], ROUTE[i + 1]),
      };
    }
    d -= segLens[i];
  }
  return { pos: ROUTE[ROUTE.length - 1], heading: 0 };
}

/** Points along the route ahead of `from`. Stands in for the predict_route tool. */
function routeAhead(from: LatLon, horizonM: number): LatLon[] {
  let bestD = 0;
  let best = Infinity;
  for (let d = 0; d <= ROUTE_LEN; d += 25) {
    const h = haversineM(from, routeAt(d).pos);
    if (h < best) {
      best = h;
      bestD = d;
    }
  }
  const out: LatLon[] = [];
  for (let d = bestD; d <= Math.min(ROUTE_LEN, bestD + horizonM); d += 100) {
    out.push(routeAt(d).pos);
  }
  return out;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

// INTERFACES.md §4
function fusion(
  e: Pick<AnomalyEvent, "rat_drop" | "rat_drop_secs" | "sms_score" | "smsc_match">,
) {
  const rat = e.rat_drop && e.rat_drop_secs <= 30 ? 1 : 0;
  const smsc = e.smsc_match === "no" ? 1 : e.smsc_match === "unknown" ? 0.5 : 0;
  return 0.45 * rat + 0.35 * e.sms_score + 0.2 * smsc;
}

export function createMockSource(): DataSource {
  return {
    mode: "mock",
    start(onTables, onStatus: (s: ConnectionStatus, d?: string) => void) {
      let rand = mulberry32(1);
      let tables = emptyTables();
      let startMs = Date.now();
      let nextId = 1;
      let lastEventMs = 0;
      let alerted = false;
      let traced = new Set<string>();
      let reportedPhones = new Set<number>();
      let phoneCooldown = new Map<number, number>();
      let endedAt = 0;

      const reset = () => {
        rand = mulberry32(1);
        tables = emptyTables();
        startMs = Date.now();
        nextId = 1;
        lastEventMs = 0;
        alerted = false;
        traced = new Set();
        reportedPhones = new Set();
        phoneCooldown = new Map();
        endedAt = 0;
        for (let i = 0; i < PHONE_COUNT; i++) {
          const { pos } = routeAt(rand() * ROUTE_LEN);
          const p = offsetM(pos, (rand() - 0.5) * 700, (rand() - 0.5) * 700);
          tables.mock_phones.push({ id: i + 1, lat: p[0], lon: p[1] });
        }
      };

      const trace = (kind: string, text: string, now: number) => {
        tables.agent_trace.push({ id: nextId++, track_id: 1, ts_ms: now, kind, text });
      };
      const once = (key: string, fn: () => void) => {
        if (!traced.has(key)) {
          traced.add(key);
          fn();
        }
      };

      // Stub of the recluster reducer + agent, so every map layer has data.
      const recluster = (now: number) => {
        const live = tables.anomaly_event.filter(
          (e) => now - e.ts_ms <= WINDOW_MS && e.fusion_score >= 0.3,
        );
        if (live.length === 0) {
          const t = tables.track[0];
          if (t && now - lastEventMs > 90_000 && t.status === "active") {
            t.status = "dormant";
            t.updated_ms = now;
          }
          return;
        }
        const recent = live.slice(-6);
        const lat = recent.reduce((s, e) => s + e.lat, 0) / recent.length;
        const lon = recent.reduce((s, e) => s + e.lon, 0) / recent.length;
        const prev = tables.track[0];
        const dt = prev ? Math.max(1, (now - prev.updated_ms) / 1000) : 1;
        const moved = prev ? haversineM([prev.lat, prev.lon], [lat, lon]) : 0;
        const speed = Math.min(40, moved / dt);
        const confidence = Math.min(1, live.length / 8);
        const status =
          (live.length >= 5 && confidence >= 0.8) || prev?.status === "active"
            ? "active"
            : "candidate";
        const track = {
          id: 1,
          lat,
          lon,
          heading_deg: prev && moved > 20 ? bearingDeg([prev.lat, prev.lon], [lat, lon]) : (prev?.heading_deg ?? 90),
          speed_mps: prev ? prev.speed_mps * 0.6 + speed * 0.4 : 0,
          confidence,
          event_count: live.length,
          status,
          campaign_id: prev?.campaign_id ?? 0,
          updated_ms: now,
        };
        for (const e of live) e.track_id = 1;

        if (status === "active") {
          once("plan", () =>
            trace("plan", "Track 1 active. Plan: link campaign, predict route, warn, brief patrol.", now),
          );
          once("campaign", () => {
            trace("tool_call", `rdap_domain_age(domain for ${BRAND} lure)`, now);
            tables.campaign = [
              { id: 1, url_hash: URL_HASH, brand: BRAND, domain_age_days: 3, first_seen_ms: now },
            ];
            track.campaign_id = 1;
            trace("tool_result", `Domain registered 3 days ago. Brand: ${BRAND}.`, now);
          });

          const path = routeAhead([lat, lon], 1800);
          if (path.length > 1) {
            const mps = track.speed_mps || SPEED_MPS;
            const iIdx = Math.min(path.length - 1, Math.max(1, Math.round((60 * mps) / 100)));
            const intercept = path[iIdx];
            const prevPred = tables.prediction[0];
            if (prevPred && Math.abs(prevPred.intercept_lat - intercept[0]) > 0.004) {
              trace("replan", "Heading changed. Re-predicting route and intercept point.", now);
            }
            tables.prediction = [
              {
                track_id: 1,
                path_json: JSON.stringify(path),
                intercept_lat: intercept[0],
                intercept_lon: intercept[1],
                eta_s: Math.round((iIdx * 100) / mps),
                updated_ms: now,
              },
            ];
            once("route", () => trace("tool_call", "predict_route(horizon_s=300)", now));
          }

          if (!alerted && path.length > 1) {
            alerted = true;
            const lead = path.slice(1, 14);
            const zone: LatLon[] = [
              ...lead.map((p) => offsetM(p, 350, 0)),
              ...[...lead].reverse().map((p) => offsetM(p, -350, 0)),
            ];
            const lats = zone.map((z) => z[0]);
            const lons = zone.map((z) => z[1]);
            const inZone = tables.mock_phones.filter(
              (ph) =>
                ph.lat >= Math.min(...lats) &&
                ph.lat <= Math.max(...lats) &&
                ph.lon >= Math.min(...lons) &&
                ph.lon <= Math.max(...lons) &&
                !reportedPhones.has(ph.id),
            );
            tables.alert = [
              {
                id: nextId++,
                track_id: 1,
                zone_json: JSON.stringify(zone),
                message: `Fake cell tower near your route. Texts claiming to be ${BRAND} are scams. Do not tap links.`,
                sent_ms: now,
                recipients: inZone.length,
              },
            ];
            trace("summary", `Warning sent to ${inZone.length} phones ahead of the blaster.`, now);
          }
        }
        tables.track = [track];
      };

      const tick = () => {
        const now = Date.now();
        const dist = ((now - startMs) / 1000) * SPEED_MPS;
        const done = dist >= ROUTE_LEN;
        const { pos } = routeAt(dist);

        if (!done) {
          tables.sim_truth.push({ scenario: "mock-demo", ts_ms: now, lat: pos[0], lon: pos[1], on_air: true });
          if (tables.sim_truth.length > 400) tables.sim_truth.shift();

          for (const ph of tables.mock_phones) {
            if (haversineM(pos, [ph.lat, ph.lon]) > RANGE_M) continue;
            if ((phoneCooldown.get(ph.id) ?? 0) > now) continue;
            if (rand() > 0.55) continue;
            phoneCooldown.set(ph.id, now + 25_000);
            reportedPhones.add(ph.id);
            const ev = {
              ts_ms: now,
              lat: round3(ph.lat),
              lon: round3(ph.lon),
              rat_drop: true,
              rat_drop_secs: 5 + rand() * 8,
              sms_score: 0.88 + rand() * 0.11,
              url_hash: URL_HASH,
              brand: BRAND,
              smsc_match: "no",
              source: "sim",
            };
            tables.anomaly_event.push({ ...ev, id: nextId++, fusion_score: fusion(ev), track_id: 0 });
            lastEventMs = now;
          }
        } else if (!endedAt) {
          endedAt = now;
        }

        tables.anomaly_event = tables.anomaly_event.filter((e) => now - e.ts_ms <= WINDOW_MS * 2);

        if (Math.floor((now - startMs) / TICK_MS) % 3 === 0) recluster(now);

        onTables({ ...tables });

        if (endedAt && now - endedAt > RESTART_AFTER_MS) reset();
      };

      reset();
      onStatus("connected", "Simulated data (mock source)");
      onTables({ ...tables });
      const id = setInterval(tick, TICK_MS);
      return () => clearInterval(id);
    },
  };
}
