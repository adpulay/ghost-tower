# Ghost Tower: Demo Script (3:30)

Seed `demo-01`, simulator at **3x** so the whole story fits. Each speaker edits their own lines.

## Before going on
Reset the world, but **do not start the simulator yet**. It has no pause: you start it on cue at 0:20.

- **Run `npm run preflight`** and fix anything marked FAIL.
- Classifier running: `python classifier/server.py`
- Agent running and Nemotron warmed: `cd agent`, `npm run warm`, `npm start`
- Web app on the live database: in `web/`, set `VITE_SPACETIME_URI=https://maincloud.spacetimedb.com` and `VITE_SPACETIME_DB=ghost-tower-94144`, then `npm run dev`
- Big screen on the analyst map (`/`), tablet on `<laptop-ip>:5173/patrol`. **`?debug=1` OFF** on both.
- Phone: app installed (rebuilt for this network's classifier address), permissions granted (there is no mode switch: the demo trigger is always on), charged, volume up, unlocked.
- Reset for a clean start (this clears the shared database, so tell the team first):
  `npm run sim -- reset` with `SPACETIME_HOST=wss://maincloud.spacetimedb.com` and `SPACETIME_DB=ghost-tower-94144`.
- Cue command, ready in a terminal: `npm run sim -- run --speed 3x demo-01` (same two environment variables).
- Full checklist: `TESTING.md` §6.

## Timeline at 3x
First rows measured by replaying `demo-01` on the real Spacetime module; the warning and phone rows come from one live 3x run with the phone pinned on Coit Rd (2,500 m along the route), with the simulator started at 0:20. The real run varies by several seconds, most of all the warning time (it depends on Nemotron). Rehearse it.

| Demo clock | What happens | Why |
|---|---|---|
| 0:20 | Simulator started | cue |
| ~0:24 | Track goes **active**; red diamond appears | active 12 s after the blaster starts |
| ~0:35 | First **warning** goes out; its zone covers the phone's spot | the agent's first alert; the phone is inside the zone, so it shows **"Fake tower heading your way"** (the phone checks the zone itself) |
| ~1:28 | Car turns north onto Coit Rd | 205 s of simulator time |
| ~1:40 to 1:55 | Route and intercept **re-plan** on the tablet | the track heading takes ~25 s of simulator time to swing; the agent waits for it to settle. Depends on Nemotron speed. |
| ~1:41 | Phone fires | the active track comes within 300 m of the phone's pinned spot, about 65 s after the warning |
| ~1:48 | Phone shows the **detection** alert | about 7 s after it fires: the debug path waits 6 s, then scores and reports. The map's hollow ring turns into the solid dot. |
| ~2:40 | Blaster goes off air | 480 s of simulator time |

The first agent log lines appear some seconds after the track goes active. Time this in rehearsal.

## The run
| Time | Screen | Speaker | Say / do |
|---|---|---|---|
| 0:00 | Slide 1 | Phone lead | "Since August 3rd there is no major-carrier 2G network left in the US. Scammers built their own. A fake cell tower in a car trunk pulls phones onto 2G and texts them directly, so carrier spam filters never see the message. In Toronto it took police months to catch one. They logged more than 13 million network disruptions, and phones caught by it could lose access to 911." |
| 0:20 | Analyst map | Tracking lead | Start the simulator (command above). "Each orange dot is a simulated phone reporting that it dropped to 2G and then got a suspicious text. The red diamond is our estimate of where the fake tower is." Point at the diamond as it appears (~0:24). |
| 0:30 | Phone | Phone lead | Hand the phone to a judge. It buzzes at ~0:35 with the warning, then again at ~1:48 when the tower reaches it. "This is a real app with a real detection pipeline, but its inputs are simulated: it plays out a 2G drop and a sample scam text when the simulated car passes. It does not read anyone's texts. On a real network, this is the moment your phone tells us it was pulled onto a fake tower." |
| 1:10 | Agent log | Agent lead | Narrate: campaign linked, domain age, route predicted, warning drafted and sent. "Code runs the investigation so it's fast and repeatable. Nemotron writes the words: the warning, the police brief and the registrar report, using only facts from the database. It can't set confidence or status." Open **Evidence packet** on the console. |
| 1:40 | Patrol tablet | Tracking lead | Hand the tablet to a second judge. The car has turned (~1:29). "Watch the route and intercept point update." |
| 2:20 | Slide 4 | each role | 15 s each on their own panel. |
| 3:00 | Slide 5 | Phone lead | Close line plus the honesty line. |

## Honesty line (say it every time)
"The blaster, the traffic and most phones are simulated, and so is the 2G drop and the text on the phone in your hand. The app, its scoring, report and notification pipeline, and the tracking, agent and alerts behind it are real software. Numbers on the next slide are from the simulator with ground truth we can check."

## Likely questions
- **Is this real or simulated?** The radio side is simulated: we're not transmitting. The phone app, the scoring, tracking, agent and alerts are real software running on that simulated feed. In the demo the phone fires on a simulated 2G drop and a sample text, through the same code path as a real one. We can show the ground-truth comparison.
- **Has this happened in the US?** Blasters have been reported in the US and elsewhere; verify current cases before quoting a specific one on stage. (TODO: add one sourced example.)
- **Isn't this surveillance?** This build never reads texts or calls and has no SMS permission. A report carries a score, a brand, a hash of a link's domain and a fixed demo location: no message text, no phone number, no GPS. Opt-in, one screen explains it.
- **Can a phone really see a 10-second 2G drop?** Android exposes network-type changes through telephony callbacks, and the home screen shows the phone's real network type. In this build the drop itself is simulated: we can't legally run a blaster, so the app plays it out. A production version would listen to those callbacks.
- **What does Nemotron actually do?** It writes: the public warning, the police brief and the registrar report, from facts in the database, and each one is checked before use. Code runs the investigation steps, because they're the same every time and it's several times faster. The console labels any report that fell back to a template.
- **How many phones need the app?** In simulation, about 3 per km² caught every run, but slowly (first alert after roughly 2 minutes). About 10 per km² gets a first alert within 30 seconds. That assumes every phone is opted in and spread evenly, which is why this belongs in a carrier's app. Source: `eval/results.md`.
- **Don't you need carrier data?** No. In the simulator, text + 2G drop alone gave the same precision and recall as adding the carrier log check, and no false alarms.
- **Don't carriers already detect this?** Carriers can't see texts that never touch their network. A blaster delivers the SMS directly, so the phone is the only witness.

## Failure drills
Pull from `TESTING.md` §5:
- Phone doesn't buzz: open **Settings** and tap **Run the demo now**. It buzzes about 8 seconds later.
- Home says the scam checker is offline: the alert used a sample score and says so. Paste the current `/score` address into **Settings**, no rebuild needed.
- Home says "Can't reach the demo": the phone has no internet.
- Map frozen: refresh, then the saved recording.
- Everything fails: play the recording and walk the slides.
