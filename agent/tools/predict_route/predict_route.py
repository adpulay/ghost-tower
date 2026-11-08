"""predict_route: Role 1's agent tool (INTERFACES.md §7, A.md Phase 4).

    predict_route(lat, lon, heading_deg, speed_mps, horizon_s)
        -> {"path": [[lat, lon], ...], "intercept": [lat, lon], "eta_s": int}

1. Road-following: snap to the nearest road with OSRM, route toward a point straight ahead
   along heading_deg, and walk that road geometry for speed_mps * horizon_s meters,
   sampling a point every 15 s of travel.
2. If OSRM fails, times out, is rate-limited, or wanders off the heading (e.g. the only route
   starts with a U-turn), fall back to a straight-line projection along heading_deg.
3. Intercept: the path point at ~65% of the horizon, so a patrol has time to get there;
   eta_s is when the blaster reaches it.

Standard library only. Set OSRM_URL to use a self-hosted router, or PREDICT_ROUTE_OFFLINE=1
to always use the straight-line projection (venue Wi-Fi drill).

CLI:  python3 predict_route.py 32.9784 -96.7800 90 11 300
"""

from __future__ import annotations

import json
import math
import os
import sys
import urllib.error
import urllib.request

EARTH_R = 6371008.8
SAMPLE_S = 15
INTERCEPT_FRAC = 0.65
OSRM_URL = os.environ.get("OSRM_URL", "https://router.project-osrm.org")
TIMEOUT_S = 4.0
# OSRM geometry whose first ~150 m points further than this from heading_deg is rejected.
MAX_HEADING_DEV_DEG = 75
USER_AGENT = "ghost-tower-predict-route/0.1"


# ----------------------------------------------------------------------------- geometry

def haversine(a: tuple[float, float], b: tuple[float, float]) -> float:
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * EARTH_R * math.asin(min(1.0, math.sqrt(h)))


def bearing(a: tuple[float, float], b: tuple[float, float]) -> float:
    mlat = math.radians(1) * EARTH_R
    mlon = mlat * math.cos(math.radians(a[0]))
    e, n = (b[1] - a[1]) * mlon, (b[0] - a[0]) * mlat
    return math.degrees(math.atan2(e, n)) % 360


def project(p: tuple[float, float], heading_deg: float, dist_m: float) -> tuple[float, float]:
    mlat = math.radians(1) * EARTH_R
    mlon = mlat * math.cos(math.radians(p[0]))
    h = math.radians(heading_deg)
    return (p[0] + math.cos(h) * dist_m / mlat, p[1] + math.sin(h) * dist_m / mlon)


def angle_diff(a: float, b: float) -> float:
    return abs((b - a + 180) % 360 - 180)


def walk(line: list[tuple[float, float]], dist_m: float) -> tuple[float, float]:
    """Point dist_m along a polyline (clamped to its end)."""
    left = dist_m
    for a, b in zip(line, line[1:]):
        seg = haversine(a, b)
        if seg >= left and seg > 0:
            f = left / seg
            return (a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1]))
        left -= seg
    return line[-1]


def line_length(line: list[tuple[float, float]]) -> float:
    return sum(haversine(a, b) for a, b in zip(line, line[1:]))


# ----------------------------------------------------------------------------- OSRM

def _get(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as r:
        return json.load(r)


def osrm_road_line(lat: float, lon: float, heading_deg: float, dist_m: float, fetch=_get) -> list[tuple[float, float]] | None:
    """Road geometry from the snapped start, heading roughly along heading_deg, >= dist_m long."""
    target = project((lat, lon), heading_deg, dist_m)
    url = (
        f"{OSRM_URL}/route/v1/driving/{lon:.6f},{lat:.6f};{target[1]:.6f},{target[0]:.6f}"
        f"?overview=full&geometries=geojson&bearings={round(heading_deg) % 360},60;&continue_straight=true"
    )
    data = fetch(url)
    if data.get("code") != "Ok" or not data.get("routes"):
        return None
    line = [(c[1], c[0]) for c in data["routes"][0]["geometry"]["coordinates"]]
    if len(line) < 2:
        return None
    # Reject routes that start by going the wrong way (U-turn to reach the target).
    if angle_diff(bearing(line[0], walk(line, 150)), heading_deg) > MAX_HEADING_DEV_DEG:
        return None
    # If the road ends early, continue straight along the last segment's direction.
    length = line_length(line)
    if length < dist_m:
        last_b = bearing(line[-2], line[-1])
        line.append(project(line[-1], last_b, dist_m - length))
    return line


# ----------------------------------------------------------------------------- tool

def _straight_line(lat: float, lon: float, heading_deg: float, dist_m: float) -> list[tuple[float, float]]:
    return [(lat, lon), project((lat, lon), heading_deg, dist_m)]


def predict_route(lat: float, lon: float, heading_deg: float, speed_mps: float, horizon_s: float, *, fetch=None) -> dict:
    """See module docstring. `fetch` is injectable for tests (url -> parsed JSON)."""
    speed = max(0.0, float(speed_mps))
    horizon = max(SAMPLE_S, float(horizon_s))
    dist_m = speed * horizon
    source = "straight_line"
    line = None
    if dist_m >= 1 and os.environ.get("PREDICT_ROUTE_OFFLINE") != "1":
        try:
            line = osrm_road_line(lat, lon, heading_deg, dist_m, fetch or _get)
            if line:
                source = "osrm"
        except (urllib.error.URLError, TimeoutError, OSError, ValueError, KeyError):
            line = None
    if not line:
        line = _straight_line(lat, lon, heading_deg, dist_m)

    steps = int(horizon // SAMPLE_S)
    path = [walk(line, speed * SAMPLE_S * i) for i in range(steps + 1)]
    if horizon % SAMPLE_S:
        path.append(walk(line, dist_m))
    eta = round(horizon * INTERCEPT_FRAC)
    intercept = walk(line, speed * eta)
    r6 = lambda p: [round(p[0], 6), round(p[1], 6)]
    return {"path": [r6(p) for p in path], "intercept": r6(intercept), "eta_s": int(eta), "source": source}


if __name__ == "__main__":
    if len(sys.argv) != 6:
        print(__doc__.split("CLI:")[1].strip(), file=sys.stderr)
        sys.exit(2)
    print(json.dumps(predict_route(*map(float, sys.argv[1:]))))
