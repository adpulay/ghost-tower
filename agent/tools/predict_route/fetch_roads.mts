// Downloads the drivable road network around the demo area from OpenStreetMap (Overpass API) and writes the
// compact file the road-map predictor reads (roads_richardson.json). Run once; the result is committed, so the
// demo needs no network for roads:
//
//   npx tsx tools/predict_route/fetch_roads.mts            (from agent/)
//
// Format: { bbox, nodes: [[lat, lon], ...], ways: [[class, oneway, [nodeIndex, ...]], ...] }
//   class   0 motorway/trunk, 1 primary, 2 secondary, 3 tertiary, 4 unclassified, 5 residential (links = parent)
//   oneway  1 = drivable in the listed order only, -1 = reverse order only, 0 = both ways
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// south, west, north, east: the demo route plus room for a 5-minute prediction beyond it.
const BBOX: [number, number, number, number] = [32.96, -96.81, 33.05, -96.73];
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "roads_richardson.json");

const CLASS: Record<string, number> = {
  motorway: 0, motorway_link: 0, trunk: 0, trunk_link: 0,
  primary: 1, primary_link: 1,
  secondary: 2, secondary_link: 2,
  tertiary: 3, tertiary_link: 3,
  unclassified: 4,
  residential: 5,
};

const query =
  `[out:json][timeout:90];way["highway"~"^(${Object.keys(CLASS).join("|")})$"](${BBOX.join(",")});(._;>;);out body;`;

const res = await fetch("https://overpass-api.de/api/interpreter", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "ghost-tower-hackathon/0.1 (road graph for demo)", accept: "application/json" },
  body: "data=" + encodeURIComponent(query),
});
if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
const data = (await res.json()) as { elements: any[] };

const coords = new Map<number, [number, number]>();
for (const e of data.elements) if (e.type === "node") coords.set(e.id, [e.lat, e.lon]);

const index = new Map<number, number>();
const nodes: [number, number][] = [];
const ways: [number, number, number[]][] = [];
for (const e of data.elements) {
  if (e.type !== "way") continue;
  const t = e.tags ?? {};
  const cls = CLASS[t.highway];
  if (cls === undefined) continue;
  let oneway = 0;
  if (t.oneway === "yes" || t.oneway === "true" || t.oneway === "1") oneway = 1;
  else if (t.oneway === "-1") oneway = -1;
  else if (t.junction === "roundabout" || t.junction === "circular") oneway = 1;
  else if ((t.highway === "motorway" || t.highway === "motorway_link") && t.oneway !== "no") oneway = 1;
  const ids: number[] = [];
  for (const n of e.nodes as number[]) {
    const c = coords.get(n);
    if (!c) continue;
    let i = index.get(n);
    if (i === undefined) {
      i = nodes.length;
      index.set(n, i);
      nodes.push([Math.round(c[0] * 1e6) / 1e6, Math.round(c[1] * 1e6) / 1e6]);
    }
    ids.push(i);
  }
  if (ids.length >= 2) ways.push([cls, oneway, ids]);
}

writeFileSync(OUT, JSON.stringify({ bbox: BBOX, nodes, ways }));
console.log(`wrote ${OUT}: ${ways.length} ways, ${nodes.length} nodes`);
