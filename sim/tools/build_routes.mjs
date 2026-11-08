#!/usr/bin/env node
// Builds sim/routes/*.json from real OpenStreetMap road geometry via the public OSRM router.
// Run once (needs network); the generated JSON is committed so sims never need the network.
//   node sim/tools/build_routes.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'routes');
const OSRM = process.env.OSRM_URL ?? 'https://router.project-osrm.org';

// Waypoints are [lat, lon, travel_bearing_deg]. OSRM snaps them to the road network; the bearing
// pins which carriageway of a divided road is used, which avoids U-turn detours.
const ROUTES = {
  demo: {
    desc: 'Campbell Rd eastbound, left (north) onto Coit Rd, up past Frankford Rd',
    via: [[32.97888, -96.792119, 90], [32.978341, -96.770059, 90], [32.983964, -96.768097, 0], [32.991847, -96.767969, 0], [33.005988, -96.76765, 0]],
  },
  straight: {
    desc: 'W Campbell Rd eastbound, one straight road',
    via: [[32.978137, -96.766003, 90], [32.978136, -96.759999, 90], [32.978125, -96.749912, 90], [32.978037, -96.739969, 90]],
  },
  turns: {
    desc: 'Campbell Rd E -> Coit Rd N -> Frankford Rd E -> Waterview Pkwy S (three turns)',
    via: [[32.97888, -96.792119, 90], [32.978341, -96.770059, 90], [32.983964, -96.768097, 0], [32.991847, -96.767969, 0],
          [32.997527, -96.76434, 90], [32.997639, -96.758687, 90], [32.9920, -96.7570, 180]],
  },
  campbell_long: {
    desc: 'Campbell Rd eastbound, ~5 km, used by stop-go and off/on',
    via: [[32.97888, -96.792119, 90], [32.978274, -96.779876, 90], [32.978137, -96.766003, 90], [32.978136, -96.759999, 90],
          [32.978125, -96.749912, 90], [32.978037, -96.739969, 90]],
  },
  arapaho_west: {
    desc: 'Arapaho Rd westbound, ~1.6 km south of Campbell (twin-01 second blaster)',
    via: [[32.963014, -96.739682, 270], [32.962305, -96.755137, 270], [32.962069, -96.775697, 270]],
  },
};

function haversine(a, b) {
  const R = 6371008.8, toR = Math.PI / 180;
  const dLat = (b[0] - a[0]) * toR, dLon = (b[1] - a[1]) * toR;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * toR) * Math.cos(b[0] * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

for (const [name, r] of Object.entries(ROUTES)) {
  const coords = r.via.map(([lat, lon]) => `${lon},${lat}`).join(';');
  const bearings = r.via.map(([, , b]) => `${b},45`).join(';');
  const url = `${OSRM}/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=true&bearings=${bearings}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'ghost-tower-sim/0.1' } });
  const j = await res.json();
  if (j.code !== 'Ok') throw new Error(`${name}: OSRM ${j.code} ${j.message ?? ''}`);
  const route = j.routes[0];
  // Thin the polyline: keep points at least 25 m apart (plus the last one).
  const raw = route.geometry.coordinates.map(([lon, lat]) => [+lat.toFixed(6), +lon.toFixed(6)]);
  const points = [raw[0]];
  for (const p of raw.slice(1)) if (haversine(points.at(-1), p) >= 25) points.push(p);
  if (points.at(-1) !== raw.at(-1)) points.push(raw.at(-1));
  const roads = [...new Set(route.legs.flatMap(l => l.steps.map(s => s.name)).filter(Boolean))];
  const out = {
    name, description: r.desc, source: 'OpenStreetMap via OSRM (driving profile)',
    length_m: Math.round(route.distance), roads, points,
  };
  writeFileSync(join(OUT, `${name}.json`), JSON.stringify(out, null, 1) + '\n');
  console.log(`${name}: ${out.length_m} m, ${points.length} pts, roads: ${roads.join(' > ')}`);
}

// walker-01: hand-carried device on foot across the UTD campus. Public OSRM only serves the car
// profile, so this is a hand-placed footpath (straight segments between campus waypoints).
const walk = [[32.9846, -96.7518], [32.9858, -96.7508], [32.9872, -96.7497], [32.9884, -96.7493], [32.9893, -96.7480]];
let len = 0; for (let i = 1; i < walk.length; i++) len += haversine(walk[i - 1], walk[i]);
writeFileSync(join(OUT, 'walker.json'), JSON.stringify({
  name: 'walker', description: 'On foot across UTD campus (hand-placed waypoints)', source: 'manual',
  length_m: Math.round(len), roads: ['UTD campus walkways'], points: walk,
}, null, 1) + '\n');
console.log(`walker: ${Math.round(len)} m (manual)`);
