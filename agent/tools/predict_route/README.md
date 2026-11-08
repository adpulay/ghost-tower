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
- **Trail.** The agent service also passes the track's last 60 s of positions (`trail`, never from the model). The trail only overrules the heading it is given when that heading is clearly wrong: more than 90° from where the track has actually gone, or no speed (seen live: 312° for a car driving east). It uses only the stretch since the last turn: a fit across a turn averages two roads into a diagonal (seen live after the Coit Rd turn, when the track updated only every 12 s at 4x). `basis` in the output says what was used: `track`, `trail` or `snapped`.
- **Measured** on simulator ground truth (`npm run eval:routes`, demo-01 + turns-01 + straight-01). Distance from the predicted position to the true blaster position, median / p90:

  | Track updates every | | +30 s | +60 s | +120 s |
  |---|---|---|---|---|
  | 12 sim-s (live at 4x) | before | 341 / 585 m | 469 / 867 m | 882 / 1,683 m |
  | | now | 334 / 579 m | 438 / 841 m | 825 / 1,683 m |
  | 3 sim-s (real time) | before | 410 / 848 m | 572 / 1,410 m | 1,326 / 2,730 m |
  | | now | 313 / 688 m | 516 / 1,120 m | 1,101 / 2,502 m |

  `ROUTE_EVAL_RECLUSTER_S=12` replays the live 4x rate. Using the trail whenever it merely differed looked better at 3 s but was worse live, so the 90° rule is deliberately narrow (`PREDICT_ROUTE_OVERRULE_DEG`). Most of what is left is the track itself: it trails the blaster by ~24 s (~250 m), since phones report after their time on 2G. Shifting the start forward by that lag helped at +30 s but hurt at +60/+120 s, so it is off (`PREDICT_ROUTE_LAG_S`).
- **Road snapping** (`PREDICT_ROUTE_SNAP=1`): OSRM map matching of the trail. Off by default: the public server caps the search radius at 40 m and ~10 points, so it matched about a third of trails and did not beat the plain fit. Worth retrying with a self-hosted OSRM and a larger `OSRM_MATCH_RADIUS_M`.
- Env vars: `OSRM_URL` (self-hosted router), `PREDICT_ROUTE_OFFLINE=1` (always use the straight line; for the Wi-Fi drill), plus the four above.
- Tests: `agent/test/predict_route.test.ts` (offline, uses `fixtures/osrm_campbell_east.json`). Add `PREDICT_ROUTE_LIVE=1` to also query the public OSRM. Accuracy: `npm run eval:routes` (queries the public OSRM; responses cached in `eval/.osrm-cache.json`).

Ported from Role 1's original Python version, which has been removed.
