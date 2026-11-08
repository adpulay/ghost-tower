# Ghost Tower

Detect and track SMS-blaster fake base stations from crowd-sourced phone reports. Phones report "dropped to 2G, then got a scam text". SpacetimeDB fuses the reports into moving tracks. A Nemotron agent predicts the route and warns phones ahead of it. An analyst map and a patrol tablet show it live.

Contract: [`INTERFACES.md`](INTERFACES.md) · test plan: [`TESTING.md`](TESTING.md) · latest numbers: [`eval/results.md`](eval/results.md)
Per-role plans: `A.zip` (Role 1), `C.zip` (Role 2), `J/J.md` (Role 3).

## Layout

| Path | Owner | What |
|---|---|---|
| `spacetime/src/` | Role 1 | Module. `schema.ts` + `columns.ts` define the tables, `index.ts` the reducers, `tracking.ts` the recluster math (pure, deterministic), `fusion.ts` §4. |
| `spacetime/bindings/` | Role 1 | TypeScript client bindings (same shape as `spacetime generate`). |
| `sim/` | Role 1 | Seeded simulator: `scenarios/*.json` (10 from TESTING.md §1), `routes/*.json` (real OSM roads via OSRM). |
| `eval/` | Role 1 | `run_eval.ts` → `results.md`: detection time, error, protected-before-hit, false alarms, ablation, load test. |
| `agent/tools/predict_route/` | Role 1 | Route prediction (OSRM road-following with a straight-line fallback), TypeScript, called by the agent. |
| `web/src/patrol/` | Role 1 | Patrol tablet view, mounted at `/patrol`. |
| `agent/` | Role 2 | Nemotron agent service and tools (`draft_report` is Role 3's, in TypeScript). |
| `classifier/` | Role 2 | SMS scam classifier and `/score` endpoint (port 8001). |
| `web/src/trace-panel/` | Role 2 | Live agent trace component, mounted in the shell. |
| `web/` | Role 3 | React app shell, analyst map (`/`), patrol (`/patrol`), trace panel slot. |
| `android/` | Role 3 | Phone sensor app. |
| `pitch/` | Role 3 | Demo script and slide outline. |

## Run it

Needs Node 22.23.4 or newer (pinned in `.nvmrc`; `agent/` refuses older versions) and Python 3.10+ for the classifier. For a live instance you also need the [SpacetimeDB CLI](https://spacetimedb.com/install).

```sh
npm install                                               # 1. deps (repo root: spacetime, sim, eval)
spacetime publish --project-path spacetime ghost-tower    # 2. module (add -s maincloud for the shared instance)
SPACETIME_DB=ghost-tower npm run sim -- run demo-01       # 3. drive the demo (add --speed 4x to go faster)
npm run eval                                              # 4. metrics + ablation + load test -> eval/results.md
npm test                                                  # 5. reducer, sim, eval and patrol tests (predict_route tests are in agent/)
```

No server handy? `npm run sim -- run --local demo-01` runs the **real module in-process** on the SpacetimeDB SDK's test datastore. The eval and tests use the same path.

Other commands: `npm run sim -- list`, `npm run sim -- reset` (`reset_world`), `npm run sim -- run --no-reset <id>`. Env: `SPACETIME_HOST` (default `ws://localhost:3000`), `SPACETIME_DB` (default `ghost-tower`), `CLASSIFIER_URL` (Role 2's `/score`; cached scores otherwise).

**Venue Wi-Fi dies:** `spacetime start` on a laptop, publish to it, and point every client at `ws://<laptop-ip>:3000`.

Other parts:

```sh
cd web && npm install && npm run dev                      # web app on simulated data: http://localhost:5173
cd agent && npm install && NEMOTRON_PROVIDER=mock npx tsx --test test/*.test.ts   # agent tests, offline
python -X utf8 -m unittest discover -s classifier/tests   # classifier tests (Windows needs -X utf8)
python classifier/server.py                               # /score on :8001 (rule-based until a model is trained)
```

Android: open `android/` in Android Studio (see `android/README.md`).

The web app uses a built-in simulated feed until it is pointed at Spacetime (`web/.env.example`). `?debug=1` shows simulator ground truth; leave it off on the big screen. Copy `.env.example` to `.env` for the agent (never commit it). Mocked parts are labelled "simulated" on screen.

## How tracking works

Every 3 s, `recluster` takes the last 120 s of events with fusion >= 0.3. It clusters them greedily (800 m, kept separate per `url_hash`) and matches each cluster to its existing track, using event continuity first and then distance within 1 km of the predicted position. It then smooths the position (0.6 x recency-weighted centroid + 0.4 x prediction), derives speed and heading from the last two positions, and computes confidence = min(1, n/10) x mean fusion (+0.1 if any SMSC mismatch). Status follows INTERFACES §5. Only `recluster` writes `confidence` and `status`.

## Simulator model (assumptions to know)

- Phones are stationary and spread uniformly over the scenario bbox. A phone within `range_m` of an on-air blaster is hit at most once per 60 s.
- A report carries the hit time as `ts_ms` but **arrives** only after the phone leaves 2G (5-10 s) plus 1-4 s upload. Position gets +-100 m noise, then is rounded to 3 decimals.
- Benign noise: handovers, short dropouts, parking garages (long 2G stays, ignored by fusion), a foreign 2G cell (`border-01`), and real TxTag texts (`smsc_match=yes`). Cached classifier scores: lures 0.93-0.99, real toll texts 0.55-0.95.
- Phishing domains are always `.example`, so nothing ever touches a real phishing site.

## Integration status

| Piece | State |
|---|---|
| Role 2 trace panel mounted in the web shell | done |
| `draft_report` called by the agent (TypeScript, LLM-backed with fallbacks) | done, untested against real Nemotron |
| Android `/score` URL matches the classifier port (8001) | done |
| Role 1 Spacetime module, simulator, eval | merged |
| Role 1 patrol view mounted at `/patrol` | mounted; renders in a browser ("Connecting…" with no host); live host only; not yet seen with data |
| Web `liveSource.ts` wired to Spacetime | done via Role 1's bindings; unit-tested with a fake connection, **never run against a real server** |
| Agent uses Role 1's `predict_route` | done (ported to TypeScript; tested offline, live OSRM path untested) |
| Android app compiled | **todo**, needs Android Studio |
