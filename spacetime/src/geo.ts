// Small geodesy helpers. Distances in meters, angles in degrees (0 = north, clockwise).
// Accurate enough for a few-km city area; no external deps so the module bundle stays tiny.

export const EARTH_R = 6371008.8;
const toRad = Math.PI / 180;
const toDeg = 180 / Math.PI;

export interface LatLon {
  lat: number;
  lon: number;
}

export function haversine(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const dLat = (bLat - aLat) * toRad;
  const dLon = (bLon - aLon) * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(aLat * toRad) * Math.cos(bLat * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function dist(a: LatLon, b: LatLon): number {
  return haversine(a.lat, a.lon, b.lat, b.lon);
}

/** Meters per degree at a latitude (local flat-earth approximation). */
export function metersPerDeg(lat: number): { mLat: number; mLon: number } {
  const mLat = EARTH_R * toRad;
  return { mLat, mLon: mLat * Math.cos(lat * toRad) };
}

/** Offset a point by east/north meters. */
export function offset(p: LatLon, eastM: number, northM: number): LatLon {
  const { mLat, mLon } = metersPerDeg(p.lat);
  return { lat: p.lat + northM / mLat, lon: p.lon + eastM / mLon };
}

/** East/north meters from a to b (local tangent plane at a). */
export function enu(a: LatLon, b: LatLon): { e: number; n: number } {
  const { mLat, mLon } = metersPerDeg(a.lat);
  return { e: (b.lon - a.lon) * mLon, n: (b.lat - a.lat) * mLat };
}

export function bearing(a: LatLon, b: LatLon): number {
  const { e, n } = enu(a, b);
  return normDeg(Math.atan2(e, n) * toDeg);
}

export function normDeg(d: number): number {
  return ((d % 360) + 360) % 360;
}

/** Smallest signed difference b - a in degrees, in (-180, 180]. */
export function angleDiff(a: number, b: number): number {
  const d = normDeg(b - a);
  return d > 180 ? d - 360 : d;
}

/** Point reached from p after travelling distM meters along headingDeg. */
export function project(p: LatLon, headingDeg: number, distM: number): LatLon {
  const h = headingDeg * toRad;
  return offset(p, Math.sin(h) * distM, Math.cos(h) * distM);
}

/** Round to 3 decimals (~110 m lat, ~93 m lon here): the privacy coarsening from INTERFACES §2. */
export function coarsen(x: number): number {
  return Math.round(x * 1000) / 1000;
}
