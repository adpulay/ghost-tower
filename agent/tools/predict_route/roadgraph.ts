// A small offline road map for route prediction.
//
// The old predictor asked a public routing server (OSRM) for a road route to a point "straight ahead", which is
// usually in a block of houses. The server snapped that point to whichever road was nearest, so paths ended in a
// hook toward an arbitrary spot, and whenever the server was slow or rate-limited the tool fell back to a plain
// straight line. Here the path is built by walking the roads themselves: snap to the road the vehicle is on
// (the one that runs the way it is heading), then at every junction take the exit that goes most nearly straight on.
//
// The data is OpenStreetMap, fetched once by fetch_roads.mts into roads_richardson.json. Directed edges mean
// one-way streets and divided roads (one carriageway per direction) are respected.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type LatLon = [number, number];

export interface RoadData {
  bbox: [number, number, number, number];
  nodes: [number, number][];
  /** [class, oneway, node indices]; class 0 = motorway ... 5 = residential; oneway 1 / -1 / 0 */
  ways: [number, number, number[]][];
}

interface Edge {
  a: number;
  b: number;
  cls: number;
  len: number;
  brg: number;
}

export interface RoadSnap {
  edge: number;
  point: LatLon;
  /** metres from the query point to the road */
  dist: number;
}

const M_LAT = 111_194.93;
const mLon = (lat: number) => M_LAT * Math.cos((lat * Math.PI) / 180);
const mod = (a: number, n: number) => ((a % n) + n) % n;
const angleDiff = (a: number, b: number) => Math.abs(mod(b - a + 180, 360) - 180);

function metres(a: LatLon, b: LatLon): number {
  return Math.hypot((b[1] - a[1]) * mLon(a[0]), (b[0] - a[0]) * M_LAT);
}

function bearingDeg(a: LatLon, b: LatLon): number {
  return mod((Math.atan2((b[1] - a[1]) * mLon(a[0]), (b[0] - a[0]) * M_LAT) * 180) / Math.PI, 360);
}

const CELL_DEG = 0.002; // about 220 m of latitude
const cellKey = (lat: number, lon: number) => Math.floor((lat + 90) / CELL_DEG) * 100_000 + Math.floor((lon + 180) / CELL_DEG);

/** Larger = a smaller road is preferred less. Metres-per-degree weight of heading disagreement when snapping. */
const SNAP_HEADING_WEIGHT = 0.4;
/** Prefer bigger roads a little when snapping (metres per road class). */
const SNAP_CLASS_WEIGHT = 2.5;
/** Roads of this class or bigger (0 to 3: motorway to tertiary) are arterials; the rest are local streets. */
const ARTERIAL_CLASS = 3;
/** Local streets count as candidates only this close to the fix. */
const LOCAL_RADIUS_M = 90;
/** For this far along a walk, junction exits are also judged against the vehicle's travel direction. */
const TRAVEL_BIAS_M = 300;
/** A candidate road is dropped if its path ahead (after this far) points more than this far off the travel direction. */
const LOOKAHEAD_M = 150;
const MAX_LOOKAHEAD_DEV_DEG = 100;
/** How far behind and ahead of a candidate road segment the recent trail is compared against. */
const TRAIL_STRETCH_M = 250;
/**
 * Trail-evidence cost: metres per degree of heading disagreement, per metre from the newest fix to the road
 * (so a branch road that leaves just ahead does not win over the road the vehicle is on), and per road class.
 */
const TRAIL_HEADING_WEIGHT = 0.15;
/** The steadier long-window heading also counts: a noisy short fit alone can point a vehicle down a cross street. */
const TRAIL_LONG_HEADING_WEIGHT = 0.25;
const TRAIL_DIST_WEIGHT = 0.2;
const TRAIL_CLASS_WEIGHT = 45;
/** At a fork, a bigger road is worth this many degrees of straightness per class step. */
const FORK_CLASS_WEIGHT = 4;

export class RoadGraph {
  /** Test/diagnostic hook: called with one line per candidate road's cost. */
  static debug?: (line: string) => void;
  private readonly nodes: [number, number][];
  private readonly edges: Edge[] = [];
  private readonly out: number[][];
  private readonly into: number[][];
  private readonly grid = new Map<number, number[]>();

  constructor(data: RoadData) {
    this.nodes = data.nodes;
    this.out = Array.from({ length: data.nodes.length }, () => []);
    this.into = Array.from({ length: data.nodes.length }, () => []);
    const add = (a: number, b: number, cls: number) => {
      const A = this.nodes[a]!, B = this.nodes[b]!;
      const idx = this.edges.length;
      this.edges.push({ a, b, cls, len: metres(A, B), brg: bearingDeg(A, B) });
      this.out[a]!.push(idx);
      this.into[b]!.push(idx);
      // Index the edge in every grid cell it passes through (sampled every ~60 m).
      const n = Math.max(1, Math.ceil(metres(A, B) / 60));
      const seen = new Set<number>();
      for (let k = 0; k <= n; k++) {
        const key = cellKey(A[0] + ((B[0] - A[0]) * k) / n, A[1] + ((B[1] - A[1]) * k) / n);
        if (seen.has(key)) continue;
        seen.add(key);
        let cell = this.grid.get(key);
        if (!cell) this.grid.set(key, (cell = []));
        cell.push(idx);
      }
    };
    for (const [cls, oneway, ids] of data.ways) {
      for (let i = 0; i < ids.length - 1; i++) {
        const a = ids[i]!, b = ids[i + 1]!;
        if (a === b) continue;
        if (oneway !== -1) add(a, b, cls);
        if (oneway !== 1) add(b, a, cls);
      }
    }
  }

  /**
   * Directed road segments near the point that run roughly the way `heading` points: within `radiusM` and at most
   * `maxDevDeg` off the heading, best first. Distance counts most, then heading, then road size.
   */
  candidates(p: LatLon, heading: number, radiusM = 80, maxDevDeg = 60, limit = 12): (RoadSnap & { dev: number; score: number })[] {
    // Arterial roads (class <= ARTERIAL_CLASS) are searched out to `radiusM`; local streets only out to LOCAL_RADIUS_M.
    // The live track can sit 100 m or more off the road it is really on, and local streets are denser than that.
    const mlon = mLon(p[0]);
    const reach = Math.ceil(radiusM / 200);
    const ci = Math.floor((p[0] + 90) / CELL_DEG), cj = Math.floor((p[1] + 180) / CELL_DEG);
    const found: (RoadSnap & { dev: number; score: number })[] = [];
    const checked = new Set<number>();
    for (let di = -reach; di <= reach; di++) {
      for (let dj = -reach; dj <= reach; dj++) {
        for (const idx of this.grid.get((ci + di) * 100_000 + (cj + dj)) ?? []) {
          if (checked.has(idx)) continue;
          checked.add(idx);
          const e = this.edges[idx]!;
          const dev = angleDiff(e.brg, heading);
          if (dev > maxDevDeg) continue;
          const A = this.nodes[e.a]!, B = this.nodes[e.b]!;
          const ax = (A[1] - p[1]) * mlon, ay = (A[0] - p[0]) * M_LAT;
          const bx = (B[1] - p[1]) * mlon, by = (B[0] - p[0]) * M_LAT;
          const dx = bx - ax, dy = by - ay;
          const l2 = dx * dx + dy * dy;
          const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2));
          const d = Math.hypot(ax + t * dx, ay + t * dy);
          if (d > radiusM || (e.cls > ARTERIAL_CLASS && d > LOCAL_RADIUS_M)) continue;
          found.push({
            edge: idx, point: [A[0] + t * (B[0] - A[0]), A[1] + t * (B[1] - A[1])], dist: d, dev,
            score: d + SNAP_HEADING_WEIGHT * dev + SNAP_CLASS_WEIGHT * e.cls,
          });
        }
      }
    }
    // Keep the best few of each kind, so a crowd of nearby local streets cannot push the arterial out of the list.
    found.sort((x, y) => x.score - y.score);
    const arterial = found.filter((c) => this.edges[c.edge]!.cls <= ARTERIAL_CLASS).slice(0, Math.ceil(limit / 2));
    const local = found.filter((c) => this.edges[c.edge]!.cls > ARTERIAL_CLASS).slice(0, limit);
    return [...arterial, ...local].sort((x, y) => x.score - y.score).slice(0, limit);
  }

  /** The single best candidate for one point (no trail evidence). */
  snap(p: LatLon, heading: number, radiusM = 80, maxDevDeg = 60): RoadSnap | null {
    return this.candidates(p, heading, radiusM, maxDevDeg, 1)[0] ?? null;
  }

  /** The road segments behind an edge: walk backwards from its start, taking the straightest predecessor. */
  private behind(edgeIdx: number, distM: number): LatLon[] {
    const pts: LatLon[] = [];
    let cur = this.edges[edgeIdx]!;
    let left = distM;
    const seen = new Set<number>([edgeIdx]);
    while (left > 0) {
      let best = -1;
      let bestScore = Infinity;
      for (const i of this.into[cur.a]!) {
        const e = this.edges[i]!;
        if (e.a === cur.b) continue; // that is the road we came from in the other direction
        const score = angleDiff(e.brg, cur.brg) + FORK_CLASS_WEIGHT * e.cls;
        if (score < bestScore) {
          bestScore = score;
          best = i;
        }
      }
      if (best < 0 || seen.has(best)) break;
      seen.add(best);
      pts.push(this.nodes[this.edges[best]!.a]!);
      left -= this.edges[best]!.len;
      cur = this.edges[best]!;
    }
    return pts.reverse();
  }

  /** The stretch of road around an edge: ~distM behind it, the edge itself, and ~distM ahead. */
  private stretch(edgeIdx: number, distM: number): LatLon[] {
    const e = this.edges[edgeIdx]!;
    const A = this.nodes[e.a]!;
    const ahead = this.walk({ edge: edgeIdx, point: A, dist: 0 }, distM);
    return [...this.behind(edgeIdx, distM), ...ahead];
  }

  /**
   * Walk the roads from a snapped point for `distM` metres: along the snapped road, then at each junction onto the
   * exit that goes most nearly straight on (a bigger road wins a close call). No U-turns. Ends early at a dead end.
   * `travel` is the direction the vehicle is known to be moving: for the first ~300 m it also counts, so a short
   * connector road that leaves at an angle does not send the walk back the way the vehicle came.
   */
  walk(from: RoadSnap, distM: number, travel?: number): LatLon[] {
    const first = this.edges[from.edge]!;
    const line: LatLon[] = [from.point];
    let remaining = distM;
    let curIdx = from.edge;
    const end = this.nodes[first.b]!;
    line.push(end);
    remaining -= metres(from.point, end);
    let walked = metres(from.point, end);
    const visited = new Set<number>([curIdx]);
    while (remaining > 0) {
      const cur = this.edges[curIdx]!;
      let best = -1;
      let bestScore = Infinity;
      for (const i of this.out[cur.b]!) {
        const e = this.edges[i]!;
        if (e.b === cur.a) continue; // no U-turn
        let score = angleDiff(e.brg, cur.brg) + FORK_CLASS_WEIGHT * e.cls;
        if (travel !== undefined && walked < TRAVEL_BIAS_M) score += angleDiff(e.brg, travel);
        if (score < bestScore) {
          bestScore = score;
          best = i;
        }
      }
      if (best < 0 || visited.has(best)) break;
      visited.add(best);
      line.push(this.nodes[this.edges[best]!.b]!);
      remaining -= this.edges[best]!.len;
      walked += this.edges[best]!.len;
      curIdx = best;
    }
    return line;
  }

  /**
   * The road path ahead of a vehicle at `p` heading `heading`, at least `distM` long when the roads allow.
   * `longHeading` is the steadier ~60 s heading, as a second opinion on which way the road runs.
   * `recent` (oldest first, weight in 0..1 with the newest highest) are the vehicle's last few positions: with
   * them the road is the one that best explains the whole recent trail, not just the newest, noisy point, so a
   * fix that drifts next to a parallel side street does not swap roads. Null when no road near the point runs
   * that way (the caller falls back to another method).
   */
  line(p: LatLon, heading: number, distM: number, recent?: { p: LatLon; w: number }[], longHeading?: number): LatLon[] | null {
    let cands = this.candidates(p, heading, 200, 100, 14);
    if (!cands.length) cands = this.candidates(p, heading, 250, 120, 14);
    if (!cands.length) return null;
    let ranked = cands;
    if (recent && recent.length >= 3) {
      const cost = new Map<number, number>();
      for (const c of cands) {
        const poly = this.stretch(c.edge, TRAIL_STRETCH_M);
        let sum = 0, wsum = 0;
        for (const r of recent) {
          sum += r.w * distToPolyline(r.p, poly);
          wsum += r.w;
        }
        const devLong = longHeading === undefined ? 0 : angleDiff(this.edges[c.edge]!.brg, longHeading);
        const total = sum / wsum + TRAIL_HEADING_WEIGHT * c.dev + TRAIL_LONG_HEADING_WEIGHT * devLong + TRAIL_DIST_WEIGHT * c.dist + TRAIL_CLASS_WEIGHT * this.edges[c.edge]!.cls;
        RoadGraph.debug?.(`edge${c.edge} cls${this.edges[c.edge]!.cls} brg${Math.round(this.edges[c.edge]!.brg)} d${Math.round(c.dist)} evidence ${(sum / wsum).toFixed(0)} devShort ${Math.round(c.dev)} devLong ${Math.round(devLong)} => ${total.toFixed(0)}`);
        cost.set(c.edge, total);
      }
      ranked = [...cands].sort((x, y) => cost.get(x.edge)! - cost.get(y.edge)!);
    }
    // Best candidate whose path ahead really goes the way the vehicle is moving.
    for (const c of ranked) {
      const line = this.walk(c, distM, heading);
      if (line.length < 2) continue;
      const ahead = walkAlong(line, Math.min(LOOKAHEAD_M, lineLengthM(line)));
      if (metres(line[0]!, ahead) < 20 || angleDiff(bearingDeg(line[0]!, ahead), heading) <= MAX_LOOKAHEAD_DEV_DEG) return line;
    }
    return null;
  }
}

function lineLengthM(line: LatLon[]): number {
  let t = 0;
  for (let i = 0; i < line.length - 1; i++) t += metres(line[i]!, line[i + 1]!);
  return t;
}

/** The point `d` metres along a polyline (clamped to its end). */
function walkAlong(line: LatLon[], d: number): LatLon {
  let left = d;
  for (let i = 0; i < line.length - 1; i++) {
    const seg = metres(line[i]!, line[i + 1]!);
    if (seg >= left && seg > 0) {
      const f = left / seg;
      return [line[i]![0] + f * (line[i + 1]![0] - line[i]![0]), line[i]![1] + f * (line[i + 1]![1] - line[i]![1])];
    }
    left -= seg;
  }
  return line[line.length - 1]!;
}


/** Metres from a point to a polyline (flat-earth). */
function distToPolyline(p: LatLon, poly: LatLon[]): number {
  const mlon = mLon(p[0]);
  let best = Infinity;
  for (let i = 0; i < poly.length - 1; i++) {
    const ax = (poly[i]![1] - p[1]) * mlon, ay = (poly[i]![0] - p[0]) * M_LAT;
    const bx = (poly[i + 1]![1] - p[1]) * mlon, by = (poly[i + 1]![0] - p[0]) * M_LAT;
    const dx = bx - ax, dy = by - ay;
    const l2 = dx * dx + dy * dy;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2));
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

// ---- default map ----

const here = dirname(fileURLToPath(import.meta.url));
const ROADS_FILE = resolve(here, "roads_richardson.json");
let cached: { graph: RoadGraph; data: RoadData } | null | undefined;

export function loadRoadData(path = ROADS_FILE): RoadData | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as RoadData;
}

/** The committed Richardson map, or null if the file is missing or PREDICT_ROUTE_ROADMAP=0. Loaded once. */
export function defaultRoadGraph(): RoadGraph | null {
  if (process.env.PREDICT_ROUTE_ROADMAP === "0") return null;
  if (cached === undefined) {
    const data = loadRoadData();
    cached = data ? { graph: new RoadGraph(data), data } : null;
  }
  return cached?.graph ?? null;
}
