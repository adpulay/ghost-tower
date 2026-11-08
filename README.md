# ghost-tower

Detect and track SMS-blaster fake base stations from crowd-sourced phone reports. Phones report "dropped to 2G, then got a scam text". SpacetimeDB fuses the reports into moving tracks. An agent predicts the route and warns phones ahead of it.

Contract: [`INTERFACES.md`](INTERFACES.md) · test plan: [`TESTING.md`](TESTING.md) · latest numbers: [`eval/results.md`](eval/results.md)

## Run it (Role 1 parts)

Needs Node ≥ 22.18 and Python 3.10+. For a live instance you also need the [SpacetimeDB CLI](https://spacetimedb.com/install).

```sh
npm install                                               # 1. deps
spacetime publish --project-path spacetime ghost-tower    # 2. module (add -s maincloud for the shared instance)
SPACETIME_DB=ghost-tower npm run sim -- run demo-01       # 3. drive the demo (add --speed 4x to go faster)
npm run eval                                              # 4. metrics + ablation + load test -> eval/results.md
npm test                                                  # 5. reducer, sim, eval, patrol and predict_route tests
```

No server handy? `npm run sim -- run --local demo-01` runs the **real module in-process** on the SpacetimeDB SDK's test datastore, and prints the tracks as they form. The eval and tests use the same path.

Other commands: `npm run sim -- list`, `npm run sim -- reset` (`reset_world`), `npm run sim -- run --no-reset <id>`. Env: `SPACETIME_HOST` (default `ws://localhost:3000`), `SPACETIME_DB` (default `ghost-tower`), `CLASSIFIER_URL` (Role 2's `/score`; cached scores otherwise).

**Venue Wi-Fi dies:** `spacetime start` on a laptop, publish to it, and point every client at `ws://<laptop-ip>:3000`.

## Layout

| Path | What |
|---|---|
| `spacetime/src/` | Module. `schema.ts` + `columns.ts` define the tables, `index.ts` the reducers, `tracking.ts` the recluster math (pure, deterministic), `fusion.ts` §4. |
| `spacetime/bindings/` | TypeScript client bindings (same shape as `spacetime generate`). |
| `spacetime/test/` | Reducer tests + `harness.ts` (module in-process) + `sys_stub.ts`. |
| `sim/` | Seeded simulator: `scenarios/*.json` (10 from TESTING.md §1), `routes/*.json` (real OSM roads via OSRM, rebuilt with `npm run routes`). |
| `eval/` | `run_eval.ts` → `results.md`: detection time, error, protected-before-hit, false alarms, precision/recall, fusion ablation, load test. |
| `agent/tools/predict_route/` | Role 1's agent tool (Python, stdlib only). OSRM road-following with a straight-line fallback. |
| `web/src/patrol/` | Patrol tablet view (React + Leaflet), mounted in Role 3's shell at `/patrol`. |

## How tracking works

Every 3 s, `recluster` takes the last 120 s of events with fusion ≥ 0.3. It clusters them greedily (800 m, kept separate per `url_hash`) and matches each cluster to its existing track, using event continuity first and then distance within 1 km of the predicted position. It then smooths the position (0.6 × recency-weighted centroid + 0.4 × prediction), derives speed and heading from the last two positions, and computes confidence = min(1, n/10) × mean fusion (+0.1 if any SMSC mismatch). Status follows INTERFACES §5. Only `recluster` writes `confidence` and `status`.

## Simulator model (assumptions to know)

- Phones are stationary and spread uniformly over the scenario bbox. A phone within `range_m` of an on-air blaster is hit at most once per 60 s.
- A report carries the hit time as `ts_ms` but **arrives** only after the phone leaves 2G (5–10 s) plus 1–4 s upload. Position gets ±100 m noise, then is rounded to 3 decimals.
- Benign noise: handovers, short dropouts, parking garages (long 2G stays, ignored by fusion), a foreign 2G cell (`border-01`), and real TxTag texts (`smsc_match=yes`). Cached classifier scores: lures 0.93–0.99, real toll texts 0.55–0.95.
- Phishing domains are always `.example`, so nothing ever touches a real phishing site.
