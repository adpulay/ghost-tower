# Role 3: Apps and Pitch (Android + Analyst Map + Report Tool + Demo)

**You own:** `android/`, `web/` (app shell + analyst map), `agent/tools/draft_report`, `pitch/` (slides + demo script).
**Your job:** the phone moment, the main screen judges watch, the words the system sends to real people, and the story that ties it together.

Read `INTERFACES.md` first. You read tables, and the phone app calls `report_anomaly`.

**Estimated load:** ~14 build hours. The patrol tablet moved to Role 1 and the trace panel to Role 2; each role now writes its own track panel for the slides.

### Skills you'll walk away with
- **Native mobile:** an Android app using telephony, SMS and notification APIs, tested with emulator injection
- **Mapping UI:** a real-time Leaflet map driven by live database subscriptions
- **LLM prompting:** building an agent tool that writes police briefs, registrar reports and public warnings with Nemotron
- **Product storytelling:** slide design, demo choreography and handling judge questions

**Priority order if time runs short:**
1. Analyst map (non-negotiable)
2. Android notification moment (or its debug trigger)
3. `draft_report` tool (can return templates if Nemotron isn't ready)
4. Polish

---

## Phase 0: Setup (2:20–3:00 PM)

- [ ] Scaffold `web/` (React + Vite is fine; the Spacetime template already generates a React client you can copy).
- [ ] Add Leaflet with OpenStreetMap tiles. Center on UTD / Campbell Rd, Richardson.
- [ ] Install Android Studio; create an empty Kotlin app in `android/`; start an emulator.
- [ ] Attend the contract meeting.

---

## Phase 1: Web shell + analyst map on fake data (3:00–6:00 PM)

Don't wait for Role 1. Hardcode a fake track and fake events, then swap to live subscriptions once the schema is up (~4:30 PM).

**Shell first (others build inside it):**
- [ ] Routes: `/` (analyst map) and `/patrol` (empty placeholder for Role 1).
- [ ] A shared Spacetime client hook (connect, subscribe, read tables) that Role 1 and Role 2 reuse.
- [ ] A side-panel slot where Role 2's trace panel component mounts.
- [ ] Push the shell to `main` by 6:00 PM and tell Roles 1 and 2.

**Analyst map layout (laptop on the big display):**
```
┌──────────────────────────────────────┬──────────────────┐
│                                      │  [Role 2's       │
│              MAP                     │   trace panel    │
│  • grey dots   = phones (sim)        │   mounts here]   │
│  • orange dots = anomaly events      │                  │
│  • red marker  = blaster estimate    │                  │
│  • dashed line = predicted path      │                  │
│  • shaded zone = alert zone          │                  │
│  • blue star   = intercept point     │                  │
└──────────────────────────────────────┴──────────────────┘
```

- [ ] Subscribe to `anomaly_event`, `track`, `prediction`, `alert`.
- [ ] Events fade out after 120 s (matches the reducer window).
- [ ] **Never render `sim_truth`** in demo mode. Add a hidden `?debug=1` flag that shows it for testing.
- [ ] Label anything mocked with a small "simulated" tag.

### ✅ C1 checklist (6:00 PM)
- [ ] Map shows Role 1's simulator dots moving live
- [ ] Track marker appears and moves (even with the stub reducer)
- [ ] Shell + client hook pushed for Roles 1 and 2

---

## Phase 2: Android sensor app (6:00–10:00 PM)

**What it does:** watches network type, catches an SMS during a 2G window, scores it, reports to Spacetime, notifies the user.

- [ ] Permissions: phone state, coarse location, receive SMS, notifications. Show a one-screen opt-in that explains what's sent: *"Your phone is now a sensor. We only report fake-tower events, never your calls, contacts or exact location."*
- [ ] Listen for network-type changes (Android's telephony callback / service-state APIs). Record when the data network type becomes a 2G type (GPRS/EDGE/GSM) and when it returns.
- [ ] Listen for incoming SMS. If one arrives within the 2G window (or ≤10 s after), send its text to Role 2's `/score` endpoint. **Only the score, brand and link hash leave the phone; never the text itself in the report.**
- [ ] Call `report_anomaly` with the payload in `INTERFACES.md` §6 (coarsen lat/lon to 3 decimals).
- [ ] Show the notification: *"Your phone was just pulled onto a fake cell tower. The text you received is fake. Don't tap the link."*
- [ ] Home screen shows the phone's **real** current network type and cell ID. This proves to judges the telemetry is real.

**Testing 2G without breaking the law:** use the **emulator console** (telnet to the emulator port) to inject an SMS and change the simulated network state. Verify your app actually sees the network type change.

- [ ] **Debug trigger (mandatory backup):** a hidden button that fires a fake 2G drop + scam SMS through the exact same code path.
- [ ] **Demo mode:** the app also watches the `track` table. When the simulated blaster's estimated position comes within range of the phone's pinned demo location, it fires the debug path automatically, so "the real phone buzzes when the car passes" happens on cue.

### ✅ C1.5 (8:00 PM): Android check
- [ ] At least one report from the app (emulator or real phone) has landed in `anomaly_event`.
- [ ] If not, **pull in Role 1 for up to an hour.** Their simulator already calls the same reducer.

### ✅ C3 go/no-go (10:00 PM)
- [ ] Decide: live detection in the demo, or demo-mode trigger. Write the decision in team chat. Either is honest if you say "the phone is running the same code path."

---

## Phase 3: `draft_report` tool (8:30–9:30 PM, fits around Android testing)

Your Nemotron piece. Role 2's agent calls it; signature in `INTERFACES.md` §7. Use the same Nemotron endpoint as Role 2 (ask them for the URL and the `.env`).

| `kind` | Output | Rules |
|---|---|---|
| `warning` | SMS sent to phones in the predicted path | ≤ 160 characters. Names the area and the lure type. Never includes a link. Plain words. |
| `police` | Intercept brief for the patrol unit | Track position, heading, speed, intercept point, campaign brand, domain age. 5 lines max. |
| `registrar` | Abuse report for the phishing domain | Domain, first seen, brand impersonated, evidence summary. Formal tone. |

- [ ] Prompt template per `kind` in `agent/tools/draft_report/prompts/`.
- [ ] Hard checks after generation: `warning` under 160 characters and contains no URL; if it fails, fall back to a fixed template.
- [ ] Unit test for each `kind` with a fixed track.
- [ ] Hand it to Role 2 by 9:00 PM.

### ✅ C2 checklist (9:00 PM, with Roles 1 and 2)
- [ ] Prediction path and alert zone render live on the map
- [ ] Role 2's trace panel renders in your side panel
- [ ] A real warning SMS **written by your tool** arrives on your phone during the run

---

## Phase 4: Map polish (10:00 PM–12:00 AM)

- [ ] Smooth track marker movement (animate between updates).
- [ ] Alert zone appears with a brief highlight when a warning goes out.
- [ ] A small counter: phones affected / phones warned before hit.
- [ ] Check readability on the actual projector or big screen (font sizes, colors).

---

## Phase 5: Pitch (12:00–6:00 AM)

`pitch/` contains the slides and `pitch/DEMO_SCRIPT.md`. Roles 1 and 2 send you their own track panels and numbers by 2:00 AM; you write the T-Mobile panel and design the deck.

**Slides (keep to 5):**
1. **Hook:** "Since August 3rd, there is no major-carrier 2G network left in the US." Toronto numbers: months to catch, 13M disruptions, 911 cut off.
2. **How a blaster works** (one simple diagram) and why carrier filters never see the text.
3. **Live demo** (switch to the map; no slide content).
4. **Track slide:** three panels. *T-Mobile* (you write it): classifier vs baseline, localization error, protected-before-hit %, false alarms. *Spacetime* (Role 1 writes). *Nemotron* (Role 2 writes).
5. **Close:** "Scammers built a mobile network. We built the network that hunts it." + honesty line on what's simulated.

**Demo script** (word for word, with who says what):
| Time | Screen | Speaker | Action |
|---|---|---|---|
| 0:00 | slide 1 | Role 3 | hook |
| 0:20 | map | Role 1 | `sim run demo-01`, explain dots |
| 0:45 | phone | Role 3 | hand phone to judge; it buzzes as car passes |
| 1:10 | trace panel | Role 2 | narrate agent steps |
| 1:40 | patrol tablet | Role 1 | hand tablet to second judge; car turns; route updates |
| 2:20 | slide 4 | each role | 15 s each on their own panel |
| 3:00 | slide 5 | Role 3 | close |

- [ ] Prepare answers for: *Is this real or simulated? Has this happened in the US? Isn't this surveillance? Can a phone really see a 10-second 2G drop? Don't carriers already detect this?*

---

## Phase 6: Hardening (6:00–8:00 AM)

- [ ] All screens work from a **local** Spacetime instance (Role 1's fallback) by changing one config value.
- [ ] Screen recording of a perfect run, saved locally, in case everything fails.
- [ ] Phone fully charged, notifications on for the app, volume up.

---

## Reintegration (how your work merges back)

**At every checkpoint:**
1. Pull `main`, rebase `role3/*`, point clients at a fresh `reset_world` + `sim run demo-01`.
2. If clean, merge and post "Role 3 merged @ C#" with one line on what changed.
3. You only read the schema; if something you need is missing, ask Role 1. **Don't add tables yourself.**
4. **Shared web app:** you own the shell. When Role 1's patrol view or Role 2's trace panel merges, run the app once before approving.

**Integration responsibilities:**
- You own the web shell and the final demo script and run order.
- You make the go/no-go call at C3 on live phone detection vs demo-mode trigger.

**What you hand to others:**
| To | What | When |
|---|---|---|
| Role 1 + 2 | web shell + Spacetime client hook | 6:00 PM |
| Role 1 | confirmation the map renders sim + tracks | 6:00 PM |
| Role 2 | `draft_report` function + tests | 9:00 PM |
| All | C3 phone decision | 10:00 PM |
| All | slides + demo script draft | 6:00 AM |

**What you need from others:**
| From | What | When |
|---|---|---|
| Role 1 | live schema + host | 4:30 PM |
| Role 2 | `/score` endpoint + Nemotron URL | 6:00 PM |
| Role 2 | trace panel component | 11:00 PM |
| Role 1 | patrol view | 12:00 AM |
| Roles 1 + 2 | their panels + numbers | 2:00 AM |
