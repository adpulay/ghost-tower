# Ghost Tower: Testing Plan (run once it's built)

Use this after **C2 (first end-to-end)** and especially from **2:00 AM onward**.
The simulator records the true blaster position (`sim_truth`), so every claim below is scored against ground truth.

**Before every test run:** `reset_world` → start agent service → open analyst map with `?debug=1` → `sim run <scenario>`.

---

## 1. Scenario suite

Role 1 creates each as `sim/scenarios/<id>.json` with a fixed seed.

| ID | Type | What it tests | Pass condition |
|---|---|---|---|
| `demo-01` | Attack | The demo: Campbell Rd east, turn onto Coit Rd | Track active, follows turn, agent re-plans |
| `straight-01` | Attack | One straight road | Error stays low end to end |
| `turns-01` | Attack | Three turns | Agent `replan` after each turn |
| `stopgo-01` | Attack | Stop-and-go traffic, 2 min parked | Track doesn't drift or split while parked |
| `offon-01` | Attack | Blaster off 3 min, back on 2 km away, same campaign | Track → `dormant` → reactivates by `url_hash` |
| `twin-01` | Attack | Two blasters, different campaigns, 1.5 km apart | **Two** separate tracks, never merged |
| `walker-01` | Attack | Hand-carried, low power (range 150 m), 1.4 m/s | Still detected; note how much slower |
| `benign-01` | Benign | Normal handovers, dropouts, garages | **Zero** `active` tracks |
| `benign-02` | Benign | Real toll texts via normal network (`smsc_match=yes`) | **Zero** `active` tracks |
| `border-01` | Benign | Phones see a "foreign" 2G cell (no SMS) | **Zero** `active` tracks |

Run each **3 times** for metrics. Run agent evals **5–10 times** per attack scenario.

---

## 2. Layer tests

### 2a. Spacetime reducers (Role 1)
- [x] `report_anomaly` computes `fusion_score` exactly per `INTERFACES.md` §4 (test 4 hand-made payloads).
- [x] `recluster` with a fixed event sequence → track position within 300 m of expected.
- [x] Status transitions: candidate → active → dormant → active (same `url_hash`) all fire at the right thresholds.
- [x] Agent reducers **cannot** change `track.confidence` or `track.status`.
- [x] **Load test:** 300 → 1,000 → 3,000 simulated phones. Record `recluster` run time at each size. *(Local wasm datastore under Node, demo-01; p50 / p95. Re-measure on Maincloud. `npm run eval -- --only load`)*

| Phones | recluster time (ms) | Map still smooth? |
|---|---|---|
| 300 | 1.1 / 11.5 | not measured (needs Role 3's map) |
| 1,000 | 3.6 / 21.1 | not measured |
| 3,000 | 12.7 / 33.1 | not measured |

### 2b. Classifier (Role 2)
- [ ] Held-out test split from T-Mobile's dataset, untouched until now.

| Model | Precision | Recall | F1 |
|---|---|---|---|
| T-Mobile baseline | | | |
| Ours | | | |

- [ ] Extra set of 30+ toll/bank lures (the most common blaster messages): report recall.
- [ ] Confusion matrix saved to `classifier/results.md`.

### 2c. Signal fusion ablation (Roles 1 + 2)
Re-run `demo-01`, `twin-01`, `benign-01`, `benign-02` (+ `border-01`) with each signal set. *(Filled by `npm run eval`, 3 runs each, events pooled. Details: `eval/results.md`.)*

| Signals | Event precision | Event recall | False active tracks |
|---|---|---|---|
| Text only | 0.92 | 1.00 | 4 |
| 2G drop only | 0.75 | 1.00 | 12 |
| Text + 2G drop | 1.00 | 1.00 | 0 |
| All three (+ carrier log check) | 1.00 | 1.00 | 0 |

**Expected story:** each signal alone is noisy; combined, false alarms drop sharply.
**Measured:** holds. Text alone false-alarms on the real TxTag reminder blast (`benign-02`); 2G drop alone false-alarms on the foreign cell (`border-01`) and garages. Text + 2G drop already gets to 0 here, so in sim the carrier check adds no extra margin. Caveat: real-toll texts use cached classifier scores of 0.55–0.95; re-run with Role 2's `/score`.

### 2d. Agent (Role 2)
For each attack scenario, per run:

| Check | demo-01 | turns-01 | offon-01 | twin-01 |
|---|---|---|---|---|
| All required tools called (campaign, origin, route, warning) | /10 | /10 | /10 | /10 |
| Re-planned after each turn | /10 | /10 | n/a | /10 |
| Never claimed to set confidence/status | /10 | /10 | /10 | /10 |
| Seconds to first prediction (median) | | | | |
| Linked the correct campaign per track | n/a | n/a | /10 | /10 |

- [ ] **Safety:** confirm no tool ever queried a real phishing domain (check tool logs).

### 2e. Android app (Role 3)
- [ ] Emulator: inject network-type change to 2G + SMS → notification appears, report lands in `anomaly_event`.
- [ ] Emulator: SMS **without** a 2G drop → no report (or low fusion).
- [ ] Emulator: 2G drop **without** SMS → report with `sms_score=0`.
- [ ] Real phone: shows real network type/cell ID; stays silent through 30 min of normal use.
- [ ] Debug trigger and demo-mode trigger both fire the same code path.
- [ ] Report payload contains **no** message text, phone number or exact GPS (inspect a row).

### 2f. Twilio (Role 2)
- [ ] Account upgraded; no trial message plays.
- [ ] Warning arrives on all three verified phones in < 10 s.

### 2g. `draft_report` tool (Role 3)
- [ ] `warning` output is under 160 characters and contains **no URL**, across 20 runs.
- [ ] If generation fails either check, the fixed template is sent instead.
- [ ] `police` brief includes position, heading, intercept point and campaign brand.
- [ ] `registrar` report names the domain and brand and reads formally.

### 2h. `predict_route` + patrol tablet (Role 1)
- [x] `predict_route` on Campbell Rd heading east stays on or near the road.
- [x] Straight-line fallback works with the routing API turned off.
- [ ] Patrol tablet updates its status line within ~5 s of a `replan` trace row.
- [ ] Patrol tablet is readable and tappable on the actual tablet used in the demo.

---

## 3. Headline metrics (Role 1's `eval/run_eval`)

Fill from 3 runs of each attack scenario (median across runs):

| Metric | demo-01 | turns-01 | walker-01 | Target |
|---|---|---|---|---|
| Time to first alert (s) | 12 | 12 | 9 | < 30 |
| Time to usable fix (s) | 12 | 12 | 9 | < 60 |
| Location error, median (m) | 264 | 261 | 39 | < 250 |
| Location error, p90 (m) | 400 | 374 | 61 | < 500 |
| Protected before hit (%) | 90* | 84* | 100* | > 40 |
| False alarms per 1,000 phone-hours (benign) | 0 (all benign scenarios, 450 phone-hours) | | | ≈ 0 |
| Agent success rate (%) | | | | > 90 |

Targets are starting guesses; report honestly whatever you get. A real 70% beats a fake 99%.

*Simulator numbers from `npm run eval` (in-process module, 3 seeds, medians). Vehicle median error misses the 250 m target by ~15 m: reports only arrive 6–14 s after a hit, so the centroid trails a car moving at 11 m/s. \*Protected before hit uses a stand-in alert (a straight 5-min corridor every 30 s), not the real agent. Re-measure once Role 2's agent runs. Agent success rate is Role 2's (§2d).*

---

## 4. End-to-end rehearsal (Sun 8–10 AM)

Run the full `pitch/DEMO_SCRIPT.md` **three times**, timed, with seed `demo-01`.

| Run | Total time | Phone buzzed on cue? | Re-plan visible? | Warning SMS arrived? | Issues |
|---|---|---|---|---|---|
| 1 | | | | | |
| 2 | | | | | |
| 3 | | | | | |

---

## 5. Failure drills (practice recovering, don't just hope)

| Failure | Recovery | Owner | Practiced? |
|---|---|---|---|
| Venue Wi-Fi dies | Switch all clients to local Spacetime on Role 1's laptop + phone hotspot | Role 1 | [ ] |
| Brev endpoint down | Flip env to hosted Nemotron; if that fails, `agent replay demo-01` | Role 2 | [ ] |
| Real phone doesn't buzz | Press hidden debug trigger | Role 3 | [ ] |
| Twilio SMS delayed | Point at the alert zone + recipient count on map; keep talking | Role 2 | [ ] |
| Map frozen | Refresh; subscriptions reconnect. If not, play the saved screen recording | Role 3 | [ ] |
| Patrol tablet frozen | Refresh; if still stuck, show `/patrol` on the laptop instead | Role 1 | [ ] |
| Routing API rate-limited | `predict_route` falls back to straight-line projection automatically | Role 1 | [ ] |
| Everything fails | Play saved recording of a perfect run; walk through slides | Role 3 | [ ] |

---

## 6. Final pre-judging checklist

- [ ] `reset_world` done, seed `demo-01` loaded, sim paused at t=0
- [ ] Nemotron warmed with one dummy request
- [ ] Twilio verified numbers + `.env` on the demo laptop
- [ ] Phone charged, notifications on, volume up, demo location pinned
- [ ] Patrol tablet logged in and on `/patrol`
- [ ] `?debug=1` **off** on the big screen (no ground truth visible)
- [ ] Mocked parts labeled "simulated" on screen
- [ ] Repo public, README runs in ≤5 commands, `eval/results.md` committed
- [ ] Everyone can answer: *real vs simulated, US relevance, surveillance, 2G visibility, existing carrier detection*
