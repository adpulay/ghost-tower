# Spacetime module

The shared world state for Ghost Tower: every table and reducer from `INTERFACES.md` §2–§5, in a
SpacetimeDB 2.x TypeScript module. Tables, columns and reducers use the contract's snake_case
names exactly, so SQL and HTTP clients (the agent, the trace panel, the sim) need no mapping.

- **Maincloud database:** `ghost-tower-94144` on `https://maincloud.spacetimedb.com`
- **Local fallback:** any `spacetime start` server, database `ghost-tower`

Requires Node.js ≥ 22.23.4 (`nvm use` at the repo root) and the Spacetime CLI
(`curl -sSf https://install.spacetimedb.com | sh`).

```bash
cd spacetime && npm install
npm test                      # tracking math unit tests (fusion, demo drive + turn, benign, dormant, twin)
npm run build                 # compile the module

# Maincloud (once: `spacetime login`, as the account that owns ghost-tower-94144)
npm run publish:maincloud

# Local fallback (venue Wi-Fi dies): port 3000 is often taken, so use 3010
spacetime start --listen-addr 127.0.0.1:3010 --in-memory &
spacetime server add --url http://127.0.0.1:3010 local3010 --no-fingerprint
spacetime publish ghost-tower --module-path . -s local3010 -y

# Watch it work end to end (fake blaster, real time, prints the track table every 3 s)
npm run smoke -- --host http://127.0.0.1:3010 --db ghost-tower
npm run smoke -- --host https://maincloud.spacetimedb.com --db ghost-tower-94144

# Rehearsal reset (admins only, see below)
spacetime call ghost-tower-94144 reset_world -s maincloud
```

## What's in it (`src/index.ts`, `src/tracking.ts`)

| Reducer | Who calls it | What it does |
|---|---|---|
| `report_anomaly` | phone app, sim | validates, rounds lat/lon to 3 decimals again server-side, computes `fusion_score` (§4), inserts |
| `recluster` | **scheduled every 3 s** | clusters events (800 m / 120 s, separated by `url_hash`), matches tracks (< 1 km of predicted position), smooths position, fits velocity, sets `confidence` and `status` (§5) |
| `agent_write_trace` | agent | inserts a trace row (kind checked, text clipped to 140 chars) |
| `agent_set_prediction` | agent | upserts the track's prediction |
| `agent_link_campaign` | agent | upserts the campaign by `url_hash`, sets `track.campaign_id` only |
| `agent_record_alert` | agent | inserts an alert (message ≤ 160 chars) |
| `sim_write_truth` | sim | inserts a truth row |
| `reset_world` | dev | clears every table; **admins only** |
| `add_admin` | dev | lets an admin add another identity (hex) that may call `reset_world` |
| `claim_admin` | dev, once | makes the caller admin only while no admin exists (bootstrap for dashboard-created databases) |

**Hard rule enforced:** only `recluster` writes `track.confidence` and `track.status`. The
`agent_*` reducers never touch them; `agent_link_campaign` changes `campaign_id` and nothing else.

Reducer arguments go in the field order of `INTERFACES.md` §2/§3. The HTTP API takes them as a
JSON array (positional, what `agent/src/world/spacetimeHttp.ts` sends) or as an object keyed by
name. Example:

```bash
curl -X POST "$HOST/v1/database/ghost-tower-94144/call/report_anomaly" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '[1762548000000, 32.986, -96.750, true, 8.2, 0.97, "<64-hex url_hash>", "TxTag", "no", "phone"]'
```

Get a `$TOKEN` with `curl -X POST $HOST/v1/identity`. Each client gets its own identity.

### Tracking details and deviations from A.md Phase 3

- **Velocity** is a recency-weighted least-squares fit of event position against time over the
  last 90 s, then smoothed (EMA α = 0.4). It is not taken from the last two smoothed positions
  as Phase 3 suggests: phones report in bursts as the blaster passes, so the two-position
  velocity stalls between bursts and the heading swings wildly at low speed. Over 12 seeded
  `demo-01`-density drives, the worst heading error is 41° on the straight legs, and the track
  swings north a median 21 s after the turn. Heading only updates above 2 m/s, the same cutoff
  the agent uses for re-plans. A new track reports speed 0 until its events span 30 s, instead of
  guessing a direction from the first burst of phones. A real 90° turn swings the heading over
  roughly 25 s, and the agent waits for it to settle before re-planning.
- **Position:** `0.6 × weighted centroid + 0.4 × predicted`, weight = fusion × exp(−age / 30 s).
- **Trail clusters:** a moving blaster's 120 s trail can split into several clusters. Clusters
  that match the same track are merged. A cluster whose newest event is > 30 s old can't
  start a new track.
- **Status:** `candidate → active` at ≥ 5 events and confidence ≥ 0.8; `active → dormant` after
  90 s with no new event; `dormant → active` when a cluster with the same `url_hash` and newer
  events appears (anywhere), or, for link-less events, within 1 km. Candidates with no event for
  90 s become `closed`.
- **Internal tables** (private, not in the contract): `track_state` (velocity, last event time,
  campaign hash per track), `admin`, `recluster_schedule`.

All constants are at the top of `src/tracking.ts`. Change them together with `INTERFACES.md`.

## Security notes

- `reset_world` is limited to admins. On a fresh database `init` makes the publisher the
  first admin. `ghost-tower-94144` was created on the dashboard first, so `init` never ran there
  and the owner claimed admin with `claim_admin`, which only works while the admin list is empty.
  It's already claimed, so later calls are refused. Add the sim's identity with
  `spacetime call ghost-tower-94144 add_admin '"<identity hex>"' -s maincloud`.
- Every other reducer is callable by any client that knows the database name, as on any public
  Maincloud database. Inputs are validated (enums, hash format, lengths, lat/lon range), but
  anyone could still write fake events or traces. That's acceptable for the demo; don't reuse
  this module for real data without adding caller checks.
- Raw message text, phone numbers and exact GPS never reach the module: there are no columns
  for them, and lat/lon are rounded again on insert.
