export type LatLon = [number, number];

const R = 6371000;
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

export function haversineM(a: LatLon, b: LatLon): number {
  const dLat = rad(b[0] - a[0]);
  const dLon = rad(b[1] - a[1]);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Initial bearing in degrees, 0 = north, clockwise. */
export function bearingDeg(a: LatLon, b: LatLon): number {
  const y = Math.sin(rad(b[1] - a[1])) * Math.cos(rad(b[0]));
  const x =
    Math.cos(rad(a[0])) * Math.sin(rad(b[0])) -
    Math.sin(rad(a[0])) * Math.cos(rad(b[0])) * Math.cos(rad(b[1] - a[1]));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

export function lerp(a: LatLon, b: LatLon, t: number): LatLon {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/** Offset a point by metres north / east (flat-earth, fine at city scale). */
export function offsetM(p: LatLon, northM: number, eastM: number): LatLon {
  return [
    p[0] + deg(northM / R),
    p[1] + deg(eastM / (R * Math.cos(rad(p[0])))),
  ];
}

export function parseLatLonList(json: string): LatLon[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v)
      ? v.filter((p) => Array.isArray(p) && p.length >= 2).map((p) => [p[0], p[1]] as LatLon)
      : [];
  } catch {
    return [];
  }
}

/** Ray-casting point-in-polygon on [lat, lon] pairs. */
export function pointInPolygon(p: LatLon, poly: LatLon[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i];
    const [yj, xj] = poly[j];
    if (yi > p[0] !== yj > p[0] && p[1] < ((xj - xi) * (p[0] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
