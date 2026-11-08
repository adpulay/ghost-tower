# Ghost Tower: Shared Interface Contract

**Read this first. All three roles build against this file.**
Agree on it together in the first 30–45 minutes. After that, changing anything here requires telling the other two people in chat *before* you push.

---

## 1. Repo layout and ownership

```
ghost-tower/                 (public GitHub repo, required for Spacetime track)
├── INTERFACES.md            (all: change only with team agreement)
├── spacetime/               (Role 1 owns)
│   └── src/                 module: tables + reducers
├── sim/                     (Role 1 owns)  drive simulator + scenarios
├── eval/                    (Role 1 owns)  metrics scripts
├── agent/                   (Role 2 owns)  Nemotron agent service + most tools
│   └── tools/predict_route  (Role 1 owns)  route prediction math
│   └── tools/draft_report   (Role 3 owns)  report + warning text generation
├── classifier/              (Role 2 owns)  SMS classifier + /score endpoint
├── web/                     (Role 3 owns the app shell + analyst map)
│   ├── src/patrol/          (Role 1 owns)  patrol tablet view
│   └── src/trace-panel/     (Role 2 owns)  live agent trace component
├── android/                 (Role 3 owns)  phone sensor app
└── pitch/                   (Role 3 owns slides + script; each role writes its own track panel)
```

**Rule:** never edit a folder you don't own without asking its owner.

### Who learns what
| Role | AI / ML | Backend / data | Frontend / mobile | Demo |
|---|---|---|---|---|
| 1 | Fusion ablation + eval design | Spacetime module, tracking math | Patrol tablet | Spacetime panel + runs the sim |
| 2 | Model serving, classifier, agent | Tools, Twilio | Trace panel component | Nemotron panel + narrates agent |
| 3 | LLM prompting (report + warning tool) | Reports into Spacetime | Android app, analyst map | Slides, script, phone moment |

### Branches
- `role1/*`, `role2/*`, `role3/*` for work in progress
- Merge into `main` at every checkpoint (see bottom). `main` must always run.

---

## 2. Spacetime tables

Names and fields are fixed once agreed. Types are written generically; Role 1 maps them to the module language.

### `anomaly_event`: one row per phone report
| Field | Type | Notes |
|---|---|---|
| `id` | u64, auto | primary key |
| `ts_ms` | u64 | event time, Unix ms |
| `lat` | f64 | **coarsened** to ~150 m (round to 3 decimals) |
| `lon` | f64 | coarsened the same way |
| `rat_drop` | bool | true if LTE/5G → 2G → back seen |
| `rat_drop_secs` | f32 | how long the phone sat on 2G |
| `sms_score` | f32 | classifier scam probability 0–1 (0 if no SMS) |
| `url_hash` | string | SHA-256 of normalized link domain, "" if none |
| `brand` | string | impersonated brand guess, e.g. "TxTag", "" if none |
| `smsc_match` | string | "yes" / "no" / "unknown" from carrier mock |
| `fusion_score` | f32 | computed by the ingest reducer (see §4) |
| `source` | string | "phone" / "sim" |
| `track_id` | u64 | 0 until assigned by recluster reducer |

### `track`: one row per suspected blaster
| Field | Type | Notes |
|---|---|---|
| `id` | u64 | primary key |
| `lat`, `lon` | f64 | current estimated position |
| `heading_deg` | f32 | 0 = north, clockwise |
| `speed_mps` | f32 | |
| `confidence` | f32 | 0–1, computed by reducer only |
| `event_count` | u32 | events in the last 120 s |
| `status` | string | "candidate" / "active" / "dormant" / "closed" |
| `campaign_id` | u64 | 0 until agent links one |
| `updated_ms` | u64 | |

### `campaign`: one row per phishing campaign
| Field | Type | Notes |
|---|---|---|
| `id` | u64 | |
| `url_hash` | string | |
| `brand` | string | |
| `domain_age_days` | i32 | from RDAP, -1 if unknown |
| `first_seen_ms` | u64 | |

### `agent_trace`: one row per agent step (shown live on screens)
| Field | Type | Notes |
|---|---|---|
| `id` | u64 | |
| `track_id` | u64 | |
| `ts_ms` | u64 | |
| `kind` | string | "plan" / "tool_call" / "tool_result" / "replan" / "summary" |
| `text` | string | one human-readable line, ≤140 chars |

### `prediction`: agent's predicted path for a track
| Field | Type | Notes |
|---|---|---|
| `track_id` | u64 | primary key (one live prediction per track) |
| `path_json` | string | JSON array of `[lat, lon]` points, next ~5 min |
| `intercept_lat`, `intercept_lon` | f64 | suggested intercept point |
| `eta_s` | u32 | seconds until blaster reaches intercept |
| `updated_ms` | u64 | |

### `alert`: warnings sent to phones in the path
| Field | Type | Notes |
|---|---|---|
| `id` | u64 | |
| `track_id` | u64 | |
| `zone_json` | string | polygon `[[lat,lon],...]` |
| `message` | string | exact text sent |
| `sent_ms` | u64 | |
| `recipients` | u32 | count (real Twilio sends + simulated) |

### `sim_truth`: **simulator only**, never shown in the demo UI
| Field | Type | Notes |
|---|---|---|
| `scenario` | string | `"<scenario-id>#<blaster-index>"`, e.g. `twin-01#1` (one row per blaster per tick) |
| `ts_ms` | u64 | |
| `lat`, `lon` | f64 | true blaster position |
| `on_air` | bool | is the blaster transmitting |

---

## 3. Reducers (callable entry points)

| Reducer | Called by | Args | Effect |
|---|---|---|---|
| `report_anomaly` | phone app, simulator | all `anomaly_event` input fields except `id`, `fusion_score`, `track_id` | inserts event, computes `fusion_score` |
| `recluster` | **scheduled**, every 3 s | none | assigns events to tracks, updates position, heading, speed, confidence, status |
| `agent_write_trace` | agent | `track_id, kind, text` | inserts `agent_trace` row |
| `agent_set_prediction` | agent | `prediction` fields | upserts `prediction` |
| `agent_link_campaign` | agent | `track_id, url_hash, brand, domain_age_days` | upserts `campaign`, sets `track.campaign_id` |
| `agent_record_alert` | agent | `alert` fields | inserts `alert` |
| `sim_write_truth` | simulator | `sim_truth` fields | inserts truth row |
| `reset_world` | dev only | none | clears all tables (for rehearsals); keeps `dev_config` weights and the recluster schedule |
| `dev_set_fusion_weights` | dev only (Role 1 ablation) | `w_rat, w_sms, w_smsc, smsc_bonus` | sets the §4 weights for events ingested **after** the call |

**Hard rule: the agent never writes `confidence` or `status`.** Only `recluster` does. The LLM proposes; the database decides.

---

## 4. Fusion score (computed in `report_anomaly`)

```
fusion = 0.45 * rat_drop_signal
       + 0.35 * sms_score
       + 0.20 * smsc_signal

rat_drop_signal = 1.0 if rat_drop and rat_drop_secs <= 30 else 0.0
smsc_signal     = 1.0 if smsc_match == "no"
                  0.5 if smsc_match == "unknown"
                  0.0 if smsc_match == "yes"
```
Events with `fusion < 0.3` are stored but ignored by `recluster`. Weights can be tuned later by Role 1 + Role 2 together; record any change here.

Weights live in the `dev_config` row (§11) and default to the values above. The ablation presets are in `spacetime/src/fusion.ts`.

## 5. Track thresholds (used by `recluster`)
- Cluster radius: events within **800 m** and **120 s** of each other belong together.
- `candidate` → `active` when `event_count >= 5` **and** `confidence >= 0.8`.
- `active` → `dormant` after **90 s** with no new events.
- `dormant` → `active` again if a new cluster with the **same `url_hash`** appears.
- Role 1 additions (not in the original contract): `candidate` → `closed` after 120 s with no events; `dormant` → `closed` after 10 min; two live tracks of the same `url_hash` within 1 km are merged (the older one survives, the other is `closed`).

---

## 6. Phone/simulator report payload

Both the Android app and simulator call `report_anomaly` with exactly this shape:

```json
{
  "ts_ms": 1762548000000,
  "lat": 32.986,
  "lon": -96.750,
  "rat_drop": true,
  "rat_drop_secs": 8.2,
  "sms_score": 0.97,
  "url_hash": "3f9a…",
  "brand": "TxTag",
  "smsc_match": "no",
  "source": "phone"
}
```
Phones **never** send raw message text, phone numbers or exact GPS.

---

## 7. Agent tool signatures (Role 2 runs the agent; owners build each tool)

| Tool | Owner | Input | Output |
|---|---|---|---|
| `get_track_context` | Role 2 | `track_id` | track row + last 50 events (from Spacetime) |
| `rdap_domain_age` | Role 2 | `domain` | `{ "domain": str, "created": iso8601 \| null, "age_days": int }` |
| `carrier_smsc_lookup` | Role 2 | `url_hash, ts_ms` | `{ "match": "yes" \| "no" \| "unknown" }` (**mock**) |
| `predict_route` | **Role 1** | `lat, lon, heading_deg, speed_mps, horizon_s` | `{ "path": [[lat,lon],...], "intercept": [lat,lon], "eta_s": int }` |
| `send_warning` | Role 2 | `zone_polygon, message` | `{ "sent": int }` (Twilio to verified team phones + count of simulated phones in zone) |
| `draft_report` | **Role 3** | `track_id, kind: "police" \| "registrar" \| "warning"` | `{ "text": str }` |

Every tool is a plain function with this exact signature, so the agent doesn't care who wrote it. Owners deliver a working tool plus one unit test.

## 8. Classifier endpoint (Role 2)
```
POST /score   { "text": "..." }  ->  { "score": 0.97, "brand": "TxTag" }
```
Runs on the Brev box. Phone app and simulator both call it.

---

## 9. Demo constants
- Map center: UTD / Campbell Rd area, Richardson TX (Role 1 picks exact route points from OpenStreetMap and records them in `sim/routes/demo.json`).
- Demo scenario seed: `demo-01`. Never change it after Sunday 8 AM.
- Verified Twilio numbers: list them in a private `.env`, **not** in this file.

---

## 10. Integration checkpoints (whole team)

| Time | Checkpoint | Pass condition |
|---|---|---|
| 3:00 PM Sat | **C0 Contract** | Everyone has read and agreed to this file |
| 6:00 PM | **C1 Parts alive** | Each role's own "C1" items pass (see role files) |
| 8:00 PM | **C1.5 Android check** | Phone app has sent at least one report into Spacetime. If not, Role 1 pairs with Role 3 for an hour. |
| 9:00 PM | **C2 First end-to-end** | Sim → track → agent trace visible on analyst map |
| 10:00 PM | **C3 Go/no-go** | Real phone path decided: live detection or debug trigger |
| 2:00 AM | **C4 Metrics** | Eval numbers computed from at least 3 scenarios |
| 8:00 AM Sun | **C5 Freeze** | Only bug fixes after this |
| 8–10 AM | **C6 Rehearse** | 3 full runs + failure drills from `TESTING.md` |

---

## 11. Role 1 additions (changelog)

Announced in chat before pushing, per the rule at the top.

**`dev_config`**: one row, `id = 0`, public, written only by dev/sim reducers.
| Field | Type | Notes |
|---|---|---|
| `id` | u32 | primary key, always 0 |
| `w_rat`, `w_sms`, `w_smsc` | f32 | §4 fusion weights (default 0.45 / 0.35 / 0.20) |
| `smsc_bonus` | f32 | recluster confidence bonus when any event has `smsc_match == "no"` (default 0.1) |
| `sim_now_ms` | u64 | latest `sim_truth.ts_ms`; `recluster` uses `max(server time, sim_now_ms)` as "now" so `sim run --speed 4x` ages events on sim time. `reset_world` sets it back to 0. |

**Other notes:**
- `recluster_schedule` is a private scheduled table (one row, 3 s interval). Clients never call `recluster`.
- `report_anomaly` re-coarsens `lat`/`lon` to 3 decimals server-side, clamps `sms_score` to 0–1, and normalizes `smsc_match` (anything else becomes `"unknown"`), so a buggy client can't store exact GPS.
- `agent_write_trace` truncates `text` to 140 chars and rejects unknown `kind`s. `agent_set_prediction` rejects a `path_json` that isn't an array of `[lat, lon]`. `updated_ms = 0` / `sent_ms = 0` mean "use server time".
- `agent_link_campaign` sets `campaign.first_seen_ms` to the earliest event with that `url_hash`.
- Client bindings: `spacetime/bindings/index.ts` (same shape as `spacetime generate` output). Reducer accessors are camelCase, e.g. `conn.reducers.reportAnomaly({...})`.
