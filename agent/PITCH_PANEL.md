# Nemotron panel (track slide) — draft for Role 3

> Fill the `__` numbers from `agent/results.md` after a **live** eval run
> (`NEMOTRON_PROVIDER=brev npm run eval -- --runs 10`). The numbers committed now come from the
> mock policy and must not go on the slide.

**Nemotron 3 Nano: an agent that plans, acts and re-plans**
- **Plan → tools → re-plan:** for each active track it groups the campaign, checks whether the
  text came through a carrier, predicts the route and warns phones ahead. When the blaster
  turns, it re-plans on its own.
- **Real tools:** Spacetime reads and writes, public RDAP domain age, Twilio SMS to real
  phones. The carrier SMSC lookup is simulated, and the UI labels it. The agent can't change
  confidence or status; only the database sets those.
- **Measured:** __% agent success over __ scripted runs (all required tools called, re-planned
  after every turn, never claimed authority). Median __ s from active to first prediction.

## For Role 3
- **T-Mobile panel classifier line:** "Scam-class F1 __ → __ vs T-Mobile baseline; __% recall
  on 32 toll/bank lures". Taken from `classifier/results.md` after `train.py --final`.
- **3 best trace lines for the slide** (from the recorded `demo-01` run; swap in live lines
  once it's re-recorded on Nemotron):
  1. `Domain txtag-pay-demo.example was registered 2 days ago, a typical throwaway lure.`
  2. `Carrier SMSC check: no match, so these texts never went through the carrier network.` (simulated)
  3. `RE-PLAN · Track #1 turned 90°, now heading north; re-predicting route and re-warning`

## 30-second narration (demo 1:10–1:40)
"This panel is Nemotron thinking out loud. The track just went active, so it made a plan:
group the campaign, check the origin, predict the route. The link domain is two days old.
The carrier says the text never went through its network, so it came from a fake tower.
It predicted the route and texted a warning to phones ahead. Watch this: the car turned onto
Coit. Re-plan. New route, new warning zone. Nobody told it to. And notice it never says how
confident it is. The database decides that. The agent only brings evidence."
