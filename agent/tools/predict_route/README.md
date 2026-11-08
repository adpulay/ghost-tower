# predict_route (Role 1's tool, called by Role 2's agent)

TypeScript, called in-process by the agent. Signature from INTERFACES.md §7:

```ts
predictRoute({ lat, lon, heading_deg, speed_mps, horizon_s })
// -> { path: [lat, lon][], intercept: [lat, lon], eta_s: number, source: "osrm" | "straight_line" }
```

`source` tells the agent (and the trace) whether the path follows roads or is the fallback.

- Snaps to the road with OSRM and follows it along the heading. The path gets one point every 15 s of travel.
- Falls back to a straight-line projection if OSRM errors, times out (4 s), is rate-limited, or offers a route that starts with a U-turn.
- The intercept sits at 65% of the horizon, and `eta_s` is the time for the blaster to reach it.
- Speed is capped at 40 m/s and the horizon at 900 s (the model supplies these arguments).
- Env vars: `OSRM_URL` (self-hosted router), `PREDICT_ROUTE_OFFLINE=1` (always use the straight line; for the Wi-Fi drill).
- Tests: `agent/test/predict_route.test.ts` (offline, uses `fixtures/osrm_campbell_east.json`). Add `PREDICT_ROUTE_LIVE=1` to also query the public OSRM.

Ported from Role 1's original Python version, which has been removed.
