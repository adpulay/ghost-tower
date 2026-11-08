// Blaster motion: interpolate along a route polyline at speed_mps, with optional stops.
import { haversine, type LatLon } from '../../spacetime/src/geo.ts';
import type { Route, Stop } from './scenario.ts';

export class Polyline {
  readonly pts: LatLon[];
  readonly cum: number[];

  constructor(points: [number, number][]) {
    this.pts = points.map(([lat, lon]) => ({ lat, lon }));
    this.cum = [0];
    for (let i = 1; i < this.pts.length; i++) {
      const a = this.pts[i - 1], b = this.pts[i];
      this.cum.push(this.cum[i - 1] + haversine(a.lat, a.lon, b.lat, b.lon));
    }
  }

  get length(): number {
    return this.cum[this.cum.length - 1];
  }

  /** Position at distance d along the line (clamped to the ends). */
  at(d: number): LatLon {
    if (d <= 0) return this.pts[0];
    if (d >= this.length) return this.pts[this.pts.length - 1];
    let lo = 0, hi = this.cum.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.cum[mid] <= d) lo = mid;
      else hi = mid;
    }
    const f = (d - this.cum[lo]) / (this.cum[hi] - this.cum[lo] || 1);
    const a = this.pts[lo], b = this.pts[hi];
    return { lat: a.lat + f * (b.lat - a.lat), lon: a.lon + f * (b.lon - a.lon) };
  }
}

/** Distance travelled after t seconds at `speed`, pausing at each stop. */
export function distanceAt(t: number, speed: number, stops: Stop[] = []): number {
  let d = 0;
  let clock = 0;
  for (const s of [...stops].sort((a, b) => a.at_m - b.at_m)) {
    const reach = clock + (s.at_m - d) / speed;
    if (t <= reach) return d + (t - clock) * speed;
    d = s.at_m;
    clock = reach + s.dur_s;
    if (t <= clock) return d;
  }
  return d + (t - clock) * speed;
}

export class Mover {
  readonly line: Polyline;
  readonly speed: number;
  readonly stops: Stop[];

  constructor(route: Route, speed: number, stops: Stop[] = []) {
    this.line = new Polyline(route.points);
    this.speed = speed;
    this.stops = stops;
  }

  at(tS: number): LatLon {
    return this.line.at(this.speed > 0 ? distanceAt(tS, this.speed, this.stops) : 0);
  }
}
