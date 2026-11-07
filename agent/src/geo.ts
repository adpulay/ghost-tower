import type { LatLon } from "./types.js";

const R = 6_371_000;
const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

export function haversineM(a: LatLon, b: LatLon): number {
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Move `distM` metres from `p` along compass bearing `headingDeg` (0 = north, clockwise). */
export function destination(p: LatLon, headingDeg: number, distM: number): LatLon {
  const d = distM / R;
  const th = toRad(headingDeg);
  const lat1 = toRad(p[0]);
  const lon1 = toRad(p[1]);
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(th));
  const lon2 = lon1 + Math.atan2(Math.sin(th) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return [toDeg(lat2), toDeg(lon2)];
}

export function bearingDeg(a: LatLon, b: LatLon): number {
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const dLon = toRad(b[1] - a[1]);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Smallest absolute difference between two headings, 0–180. */
export function headingDelta(a: number, b: number): number {
  const d = Math.abs(((a - b) % 360) + 360) % 360;
  return d > 180 ? 360 - d : d;
}

export function compass(headingDeg: number): string {
  const names = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];
  return names[Math.round((((headingDeg % 360) + 360) % 360) / 45) % 8];
}

/** Ray-casting point-in-polygon on [lat, lon] pairs. */
export function pointInPolygon(p: LatLon, poly: LatLon[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i];
    const [yj, xj] = poly[j];
    const intersect = yi > p[0] !== yj > p[0] && p[1] < ((xj - xi) * (p[0] - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Corridor polygon of half-width `halfWidthM` around a polyline. Built as left offsets
 * forward + right offsets backward, with a cap on each end. Good enough for a warning zone.
 */
export function corridorPolygon(path: LatLon[], halfWidthM = 300): LatLon[] {
  if (path.length === 0) return [];
  if (path.length === 1) {
    return [0, 60, 120, 180, 240, 300].map((h) => destination(path[0], h, halfWidthM));
  }
  const left: LatLon[] = [];
  const right: LatLon[] = [];
  for (let i = 0; i < path.length; i++) {
    const a = path[Math.max(0, i - 1)];
    const b = path[Math.min(path.length - 1, i + 1)];
    const h = bearingDeg(a, b);
    left.push(destination(path[i], h - 90, halfWidthM));
    right.push(destination(path[i], h + 90, halfWidthM));
  }
  const startCap = destination(path[0], bearingDeg(path[0], path[1]) + 180, halfWidthM);
  const endCap = destination(path[path.length - 1], bearingDeg(path[path.length - 2], path[path.length - 1]), halfWidthM);
  return [startCap, ...left, endCap, ...right.reverse()];
}

/** Deterministic PRNG (mulberry32) seeded from a string, for simulated phone placement. */
export function seededRandom(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function isLatLonArray(v: unknown): v is LatLon[] {
  return (
    Array.isArray(v) &&
    v.length >= 3 &&
    v.every((p) => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === "number" && Number.isFinite(n)))
  );
}
