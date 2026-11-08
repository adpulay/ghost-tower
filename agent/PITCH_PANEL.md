# Nemotron panel (track slide)

> Fill the `__` numbers from `agent/results.md` after a **live** eval run
> (`NEMOTRON_PROVIDER=brev npm run eval -- --runs 10`). The numbers committed now come from the
> mock policy and must not go on the slide.

**Nemotron 3 Nano: it writes the case, the database decides it**
- **What the model does:** writes the public warning, the police brief and the registrar abuse
  report, using only facts from the database. Each is checked before use (160 characters and no
  link for the warning), and the console labels anything that fell back to a template.
- **What code does:** runs the investigation in parallel and re-plans when the heading changes.
  Those steps are the same every time, so code does them. The model-driven loop is still available
  (`AGENT_MODE=llm`) and is several times slower.
- **Real tools:** Spacetime reads and writes, public RDAP domain age, Twilio SMS to real
  phones. The carrier SMSC lookup is simulated, and the UI labels it. The agent can't change
  confidence or status; only the database sets those.
- **Measured:** __% agent success over __ scripted runs. Median __ s from active to first prediction.

## For the deck
- **T-Mobile panel classifier line:** "Scam-class F1 __ → __ vs T-Mobile baseline; __% recall
  on 32 toll/bank lures". Taken from `classifier/results.md` after `train.py --final`.
- **3 best trace lines for the slide** (from the recorded `demo-01` run; swap in live lines
  once it's re-recorded on Nemotron):
  1. `Domain txtag-pay-demo.example was registered 2 days ago, a typical throwaway lure.`
  2. `Carrier SMSC check: no match, so these texts never went through the carrier network.` (simulated)
  3. `RE-PLAN · Track #1 turned 90°, now heading north; re-predicting route and re-warning`

## 30-second narration (demo 1:10–1:40)
"This is the case being built. Code runs the checks in parallel so it's fast and repeatable: the
link domain is two days old, and the carrier lookup, simulated here, says the text never went
through its network. Nemotron turns those facts into a warning for the phones ahead. It also
writes the police brief and the takedown request. Here they are, ready to send. And when the car
turns onto Coit, the route, the warning and the brief all update. Notice the model never says how
confident we are. The database decides that. The model only writes from the evidence."
