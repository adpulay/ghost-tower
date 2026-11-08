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
| `agent/tools/predict_route/` | Route prediction, called by the agent: walks an offline road map, then tries OSRM, then a straight line. |
| `web/src/patrol/` | Patrol tablet view, mounted at `/patrol`. |
| `agent/` | Nemotron agent service and tools (including `draft_report`), plus an optional ntfy push relay. |
| `classifier/` | SMS scam classifier and `/score` endpoint (port 8001). |
| `web/src/trace-panel/` | Live agent trace component, shown in the sidebar under "Show technical steps". |
| `web/` | React app behind a demo login: analyst map and sidebar (`/`), patrol (`/patrol`), evidence packet. |
| `android/` | Phone sensor app. |
| `scripts/preflight.mjs` | Pre-demo check of every live dependency. |
| `deploy/brev/` | One-command start for the GPU box: Nemotron, classifier, tunnel and agent. |
| `pitch/` | Demo script and slide outline. |

## Run it

Needs Node 22.23.4 or newer (pinned in `.nvmrc`; `agent/` refuses older versions) and Python 3.10+ for the classifier. For a live instance you also need the [SpacetimeDB CLI](https://spacetimedb.com/install).

```sh
npm install                                               # 1. deps (repo root: spacetime, sim, eval)
spacetime publish --module-path spacetime ghost-tower    # 2. module (add -s maincloud for the shared instance)
SPACETIME_DB=ghost-tower npm run sim -- run demo-01       # 3. drive the demo (add --speed 4x to go faster)
npm run eval                                              # 4. metrics + ablation + load test -> eval/results.md
npm test                                                  # 5. reducer, sim, eval, patrol and web data tests (predict_route tests are in agent/)
```

No server handy? `npm run sim -- run --local demo-01` runs the **real module in-process** on the SpacetimeDB SDK's test datastore. The eval and tests use the same path.

**A sim run starts by calling `reset_world`, which wipes the database it points at.** Add `--no-reset` on a shared instance.

Other commands: `npm run sim -- list`, `npm run sim -- reset` (`reset_world`), `npm run sim -- run --no-reset <id>`, `npm run eval:routes` (route accuracy; needs `agent/` installed). Env: `SPACETIME_HOST` (default `ws://localhost:3000`), `SPACETIME_DB` (default `ghost-tower`), `CLASSIFIER_URL` (the `/score` endpoint; cached scores otherwise), `SPACETIME_TOKEN` (see below; live runs need it, and it falls back to `.env`).

**Before a live demo:** `npm run preflight` checks the database, token, classifier, Nemotron, road router and text warnings without changing anything.

### Database access

Phones report anonymously. Everything else (agent, simulator, `reset_world`, the dev knobs) is limited to the database's operator, so nobody else can wipe or skew a shared instance.

- **New database:** the identity that publishes it is the operator.
- **A database published before this change:** run `spacetime call <db> claim_operator -s maincloud` straight after publishing. The first caller wins, so don't leave a gap.
- Put that identity's token in `.env` as `SPACETIME_TOKEN` (`spacetime login show --token`). The agent and simulator both use it.

The web app also connects to a database that has no `case_report` table yet. The evidence packet stays hidden until the module is published.

**Venue Wi-Fi dies:** `spacetime start` on a laptop, publish to it, and point every client at `ws://<laptop-ip>:3000`.

### Full local run

Runs the whole demo on one machine, with no shared database, model or real texts. Each command needs its own terminal, except the two setup lines at the start of the second.

```sh
spacetime start                                           # local server on :3000

spacetime publish --server http://127.0.0.1:3000 --module-path spacetime ghost-tower -y
export SPACETIME_TOKEN=<output of: spacetime login show --token>
npm run sim -- run --host ws://127.0.0.1:3000 --db ghost-tower demo-01

cd agent && SPACETIME_TOKEN=<same token> NEMOTRON_PROVIDER=mock TWILIO_DRY_RUN=1 PREDICT_ROUTE_OFFLINE=1 \
  SPACETIME_HOST=http://127.0.0.1:3000 SPACETIME_DB=ghost-tower npm start

cd web && VITE_SPACETIME_URI=http://127.0.0.1:3000 VITE_SPACETIME_DB=ghost-tower npm run dev
```

### Other parts

```sh
cd web && npm install && npm run dev                      # web app on simulated data: http://localhost:5173
cd agent && npm install && NEMOTRON_PROVIDER=mock npx tsx --test test/*.test.ts   # agent tests, offline
cd agent && NTFY_TOPIC=<long-random-topic> npm run ntfy   # push warnings to a phone through ntfy, next to the agent
python -X utf8 -m unittest discover -s classifier/tests   # classifier tests (Windows needs -X utf8)
python classifier/server.py                               # /score on :8001 (rule-based until a model is trained)
```

Android: open `android/` in Android Studio (see `android/README.md`).

The web app uses a built-in simulated feed until it is pointed at Spacetime (`web/.env.example`). `?debug=1` shows simulator ground truth; leave it off on the big screen. Copy `.env.example` to `.env` for the agent (never commit it). Mocked parts are labelled "simulated" on screen.

The console opens with a demo login. Its credentials are hardcoded in `web/src/auth/AuthContext.tsx`, so it only keeps out casual visitors and is not real security.

### Deploying the site

Vercel builds `web/` using `vercel.json`. `.env` files are not uploaded, so set these in the Vercel project:

```
VITE_SPACETIME_URI=https://maincloud.spacetimedb.com
VITE_SPACETIME_DB=ghost-tower-94144
```

They are read at build time, so redeploy after changing them. Without `VITE_SPACETIME_URI` the site runs on the simulated feed and shows no error.

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
| Maincloud `ghost-tower-94144` | still on the older module: no `operator` or `case_report` table, so access rules are off and the evidence packet is hidden. To update it, publish, run `claim_operator`, and give the agent and simulator the token (see Database access) |
| Evidence packet (police and registrar reports) | done; template path tested offline, not yet seen with Nemotron text |
| Android demo app | builds (`./gradlew assembleDebug`) |
| Classifier | rule-based until `train.py --final` runs on the real dataset |
| `agent/results.md` | mock numbers only; re-run with `NEMOTRON_PROVIDER=brev` before quoting |
| Real 2G and SMS detection on phones | not built: the phone's inputs are simulated |
