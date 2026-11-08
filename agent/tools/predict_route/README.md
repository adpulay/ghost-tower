# predict_route (Role 1 → Role 2's agent)

```python
from agent.tools.predict_route.predict_route import predict_route
predict_route(lat, lon, heading_deg, speed_mps, horizon_s)
# -> {"path": [[lat, lon], ...], "intercept": [lat, lon], "eta_s": int, "source": "osrm" | "straight_line"}
```

Signature from INTERFACES.md §7. The extra `source` key tells the agent (and the trace) whether the path follows roads or is the fallback.

- Snaps to the road with OSRM and follows it along the heading. The path gets one point every 15 s of travel.
- Falls back to a straight-line projection if OSRM errors, times out (4 s), is rate-limited, or offers a route that starts with a U-turn.
- The intercept sits at 65% of the horizon, and `eta_s` is the time for the blaster to reach it.
- Env vars: `OSRM_URL` (self-hosted router), `PREDICT_ROUTE_OFFLINE=1` (always use the straight line; for the Wi-Fi drill).
- CLI: `python3 predict_route.py 32.97888 -96.792119 90 11 300`
- Tests: `python3 -m unittest discover -s agent/tools/predict_route -p 'test_*.py'`. Add `PREDICT_ROUTE_LIVE=1` to also query the public OSRM.
