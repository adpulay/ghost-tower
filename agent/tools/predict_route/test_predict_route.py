"""Unit tests for predict_route (TESTING.md §2h). Offline by default.

    python3 -m unittest discover -s agent/tools/predict_route -p 'test_*.py'
    PREDICT_ROUTE_LIVE=1 ...   also hits the public OSRM router
"""

import json
import os
import pathlib
import sys
import unittest
import urllib.error

HERE = pathlib.Path(__file__).parent
sys.path.insert(0, str(HERE))
import predict_route as pr  # noqa: E402

ROOT = HERE.parents[2]
# Real Campbell Rd geometry (OpenStreetMap via OSRM), the same road the demo blaster drives.
CAMPBELL = [tuple(p) for p in json.loads((ROOT / "sim/routes/campbell_long.json").read_text())["points"]]
FIXTURE = json.loads((HERE / "fixtures/osrm_campbell_east.json").read_text())

START = (32.97888, -96.792119)  # Campbell Rd, west of Coit, heading east


def dist_to_road(p):
    """Distance from p to the Campbell Rd polyline (sampled every ~10 m)."""
    best = float("inf")
    for a, b in zip(CAMPBELL, CAMPBELL[1:]):
        n = max(1, int(pr.haversine(a, b) // 10))
        for i in range(n + 1):
            q = (a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n)
            best = min(best, pr.haversine(p, q))
    return best


class PredictRouteTest(unittest.TestCase):
    def setUp(self):
        os.environ.pop("PREDICT_ROUTE_OFFLINE", None)

    def test_campbell_east_stays_on_road(self):
        out = pr.predict_route(*START, 90, 11, 240, fetch=lambda url: FIXTURE)
        self.assertEqual(out["source"], "osrm")
        self.assertEqual(len(out["path"]), 240 // 15 + 1)  # one point per 15 s, incl. now
        for p in out["path"]:
            self.assertLess(dist_to_road(p), 60, f"{p} is off Campbell Rd")
        # Moving east, not west.
        self.assertGreater(out["path"][-1][1], START[1] + 0.02)

    def test_intercept_and_eta(self):
        out = pr.predict_route(*START, 90, 11, 300, fetch=lambda url: FIXTURE)
        self.assertEqual(out["eta_s"], 195)  # 65% of the horizon
        travelled = pr.line_length([tuple(p) for p in out["path"][: 195 // 15 + 1]])
        self.assertAlmostEqual(travelled, 11 * 195, delta=60)
        self.assertLess(pr.haversine(tuple(out["intercept"]), tuple(out["path"][13])), 5)

    def test_straight_line_fallback_when_api_down(self):
        def down(url):
            raise urllib.error.URLError("rate limited")

        out = pr.predict_route(*START, 90, 11, 300, fetch=down)
        self.assertEqual(out["source"], "straight_line")
        end = tuple(out["path"][-1])
        self.assertAlmostEqual(pr.haversine(START, end), 3300, delta=5)
        self.assertAlmostEqual(pr.bearing(START, end), 90, delta=0.5)
        self.assertEqual(out["eta_s"], 195)

    def test_offline_env_skips_network(self):
        os.environ["PREDICT_ROUTE_OFFLINE"] = "1"

        def boom(url):
            raise AssertionError("network used")

        self.assertEqual(pr.predict_route(*START, 0, 10, 60, fetch=boom)["source"], "straight_line")

    def test_rejects_route_that_starts_with_a_u_turn(self):
        # Same geometry, but we claim to be heading west: the road goes east, so fall back.
        out = pr.predict_route(*START, 270, 11, 120, fetch=lambda url: FIXTURE)
        self.assertEqual(out["source"], "straight_line")
        self.assertLess(out["path"][-1][1], START[1])

    def test_parked_target(self):
        out = pr.predict_route(*START, 90, 0, 300, fetch=lambda url: FIXTURE)
        self.assertTrue(all(pr.haversine(START, tuple(p)) < 1 for p in out["path"]))
        self.assertEqual(out["intercept"], [round(START[0], 6), round(START[1], 6)])

    @unittest.skipUnless(os.environ.get("PREDICT_ROUTE_LIVE") == "1", "set PREDICT_ROUTE_LIVE=1 to hit OSRM")
    def test_live_osrm(self):
        out = pr.predict_route(*START, 90, 11, 240)
        self.assertEqual(out["source"], "osrm")
        for p in out["path"]:
            self.assertLess(dist_to_road(p), 60)


if __name__ == "__main__":
    unittest.main()
