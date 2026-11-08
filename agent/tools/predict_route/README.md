# predict_route (Role 1's tool, called by Role 2's agent)

TypeScript, called in-process by the agent. Signature from INTERFACES.md §7:

```ts
predictRoute({ lat, lon, heading_deg, speed_mps, horizon_s })
// -> { path: [lat, lon][], intercept: [lat, lon], eta_s: number, source: "roadmap" | "osrm" | "straight_line" }
```

`source` tells the agent (and the trace) how the path was built: `roadmap` walks the offline road map, `osrm` follows a route from the public router, `straight_line` is the last-resort projection.

- **Road map (default).** The path is built by walking an offline OpenStreetMap road graph (`roadgraph.ts`, data in `roads_richardson.json`, fetched once by `fetch_roads.mts`). The vehicle is snapped to the road that best explains its last ~20 s of positions (newest weighted most, and it must run the way the vehicle is heading), then the path follows that road, taking the straightest exit at each junction, with one point every 15 s of travel. Directed edges respect one-way streets and divided roads. No network, no rate limits.
  *Why not the router:* the old method asked OSRM for a road route to a point "straight ahead", which is usually off-road. The server snapped that point to whatever road was nearest, so paths ended in a hook toward an arbitrary spot, and when the server was slow or throttled the tool silently fell back to a straight line, so the drawn path flipped between the two. A mis-snap onto a parallel side street used to send the path down the wrong street for a step.
- If the position is off the map (or no road near it runs that way), it tries OSRM (unless offline), then the straight line. OSRM also rejects a route that starts with a U-turn.
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
- **Road map accuracy** (same eval, added as method `roadmap`; median / p90 over the same 90 predictions): +30 s 326 / 711 m, +60 s 442 / 1,099 m, +120 s 746 / 1,982 m, against 346 / 599, 442 / 970 and 804 / 1,877 m for the trail fit routed by OSRM. Distance error is about the same (it is dominated by the track trailing the blaster); the gain is in the shape of the path. In a replay of demo-01 with a track that trails the car by 24 s and has 25 m of position noise (`test/roadgraph.test.ts`, six noise seeds, 264 predictions), the road map had 0 glitches (a prediction that left the map or jumped more than 700 m outside the one real turn) and no end-of-path hooks, where the router-based path hooked 50 to 90 degrees in about a quarter of predictions and fell back to a straight line about 1 in 15 even at one request per second. With 40 to 60 m of noise it glitches in 3 to 7% of predictions.
- **Known limit:** the track trails the blaster by about 24 s, so a turn can only be predicted once the track has rounded the corner. On demo-01 the path flips from Campbell Rd east to Coit Rd north about 13 s after the track reaches the corner.
- **Service hold:** in the agent service, a refresh whose intercept jumps more than 1 km from the one already published, at a steady heading, is held for one refresh and published only if the next refresh agrees; a turn the service already sees (heading swung more than 45 degrees) is never held (`shouldHoldRefresh` in `src/service.ts`).
- Env vars: `PREDICT_ROUTE_ROADMAP=0` (don't use the road map), `OSRM_URL` (self-hosted router), `PREDICT_ROUTE_OFFLINE=1` (no network: the road map still works, only the OSRM step is skipped), plus the four above (`PREDICT_ROUTE_OVERRULE_DEG` among them). To refresh the map data: `npx tsx tools/predict_route/fetch_roads.mts` from `agent/`.
- Tests: `agent/test/predict_route.test.ts` (offline, uses `fixtures/osrm_campbell_east.json`), `agent/test/roadgraph.test.ts` (road map). Add `PREDICT_ROUTE_LIVE=1` to also query the public OSRM. Accuracy: `npm run eval:routes` (queries the public OSRM; responses cached in `eval/.osrm-cache.json`).

Ported from Role 1's original Python version, which has been removed.
