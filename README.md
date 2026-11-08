# Ghost Tower

Detect and track SMS-blaster fake base stations from crowd-sourced phone reports. Phones report "dropped to 2G, then got a scam text". SpacetimeDB fuses the reports into moving tracks. A Nemotron agent predicts the route and warns phones ahead of it. An analyst map and a patrol tablet show it live.

Contract: [`INTERFACES.md`](INTERFACES.md) · test plan: [`TESTING.md`](TESTING.md) · latest numbers: [`eval/results.md`](eval/results.md)

## Layout

| Path | What |
|---|---|
| `spacetime/src/` | Module. `schema.ts` + `columns.ts` define the tables, `index.ts` the reducers, `tracking.ts` the recluster math (pure, deterministic), `fusion.ts` §4. |
| `spacetime/bindings/` | TypeScript client bindings (same shape as `spacetime generate`). |
| `sim/` | Seeded simulator: `scenarios/*.json` (10 from TESTING.md §1), `routes/*.json` (real OSM roads via OSRM). |
| `eval/` | `run_eval.ts` → `results.md`: detection time, error, protected-before-hit, false alarms, ablation, load test. |
| `agent/tools/predict_route/` | Route prediction (OSRM road-following with a straight-line fallback), TypeScript, called by the agent. |
| `web/src/patrol/` | Patrol tablet view, mounted at `/patrol`. |
| `agent/` | Nemotron agent service and tools (including `draft_report`). |
| `classifier/` | SMS scam classifier and `/score` endpoint (port 8001). |
| `web/src/trace-panel/` | Live agent trace component, mounted in the shell. |
| `web/` | React app shell, analyst map (`/`), patrol (`/patrol`), trace panel slot. |
| `android/` | Phone sensor app. |
| `pitch/` | Demo script and slide outline. |

## Run it

Needs Node 22.23.4 or newer (pinned in `.nvmrc`; `agent/` refuses older versions) and Python 3.10+ for the classifier. For a live instance you also need the [SpacetimeDB CLI](https://spacetimedb.com/install).

```sh
npm install                                               # 1. deps (repo root: spacetime, sim, eval)
spacetime publish --module-path spacetime ghost-tower    # 2. module (add -s maincloud for the shared instance)
SPACETIME_DB=ghost-tower npm run sim -- run demo-01       # 3. drive the demo (add --speed 4x to go faster)
npm run eval                                              # 4. metrics + ablation + load test -> eval/results.md
npm test                                                  # 5. reducer, sim, eval and patrol tests (predict_route tests are in agent/)
```

No server handy? `npm run sim -- run --local demo-01` runs the **real module in-process** on the SpacetimeDB SDK's test datastore. The eval and tests use the same path.

Other commands: `npm run sim -- list`, `npm run sim -- reset` (`reset_world`), `npm run sim -- run --no-reset <id>`. Env: `SPACETIME_HOST` (default `ws://localhost:3000`), `SPACETIME_DB` (default `ghost-tower`), `CLASSIFIER_URL` (the `/score` endpoint; cached scores otherwise), `SPACETIME_TOKEN` (see below; live runs need it, and it falls back to `.env`).

**Before a live demo:** `npm run preflight` checks the database, token, classifier, Nemotron, road router and text warnings without changing anything.

### Database access

Phones report anonymously. Everything else (agent, simulator, `reset_world`, the dev knobs) is limited to the database's operator, so nobody else can wipe or skew a shared instance.

- **New database:** the identity that publishes it is the operator.
- **A database published before this change:** run `spacetime call <db> claim_operator -s maincloud` straight after publishing. The first caller wins, so don't leave a gap.
- Put that identity's token in `.env` as `SPACETIME_TOKEN` (`spacetime login show --token`). The agent and simulator both use it.

Publish the module **before** deploying the web app: the site subscribes to the new `case_report` table and its connection fails without it.

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

## Status

| Piece | State |
|---|---|
| Spacetime module, simulator, eval | done; access rules tested on a real server |
| Web console and patrol tablet, live or simulated | done; rehearsed against Maincloud |
| Agent on Nemotron, warning relay | done |
| Evidence packet (police and registrar reports) | done; template path tested offline, not yet seen with Nemotron text |
| Android demo app | builds (`./gradlew assembleDebug`) |
| Classifier | rule-based until `train.py --final` runs on the real dataset |
| `agent/results.md` | mock numbers only; re-run with `NEMOTRON_PROVIDER=brev` before quoting |
| Real 2G and SMS detection on phones | not built: the phone's inputs are simulated |
