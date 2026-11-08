# Ghost Tower: Demo Script (3:30)

Seed `demo-01`. Run order and speakers follow `J/J.md` Phase 5. Draft: Roles 1 and 2 edit their own lines.

**Before going on:** `reset_world`, load `demo-01`, sim paused at t=0, `?debug=1` OFF on the big screen, Nemotron warmed, phone charged and volume up, patrol tablet on `/patrol`. See `CentralMD/TESTING.md` §6.

| Time | Screen | Speaker | Say / do |
|---|---|---|---|
| 0:00 | Slide 1 | Role 3 | "Since August 3rd there is no major-carrier 2G network left in the US. Scammers built their own. A fake cell tower in a car trunk pulls phones onto 2G and texts them directly, so carrier spam filters never see the message. In Toronto it took months to catch one, disrupted 13 million connections, and cut people off from 911." |
| 0:20 | Analyst map | Role 1 | Run `sim run demo-01`. "Grey dots are simulated phones. When one gets a suspicious text during a 2G drop, it reports. Those are the orange dots." Point at the red marker as it appears. |
| 0:45 | Phone | Role 3 | Hand the phone to a judge. It buzzes as the car passes. "That is the real app running the same code path as the simulator. Your phone just told us it was pulled onto a fake tower." |
| 1:10 | Trace panel | Role 2 | Narrate: campaign linked, domain age, route predicted, warning drafted and sent. "The model proposes, the database decides. The agent can't set confidence or status." |
| 1:40 | Patrol tablet | Role 1 | Hand the tablet to a second judge. The car turns. "Watch the route and intercept point update." |
| 2:20 | Slide 4 | each role | 15 s each on their own panel. |
| 3:00 | Slide 5 | Role 3 | Close line plus the honesty line. |

## Honesty line (say it every time)
"The blaster, the traffic and most phones are simulated. The phone in your hand and the detection code on it are real. Numbers on the next slide are from the simulator with ground truth we can check."

## Likely questions
- **Is this real or simulated?** The radio side is simulated: we're not transmitting. The phone app, the scoring, tracking, agent and alerts are real software running on that simulated feed. We can show the ground-truth comparison.
- **Has this happened in the US?** Blasters have been reported in the US and elsewhere; verify current cases before quoting a specific one on stage. (TODO: Role 3 to add one sourced example.)
- **Isn't this surveillance?** Phones report only fake-tower events. No message text, no phone numbers, no exact location (rounded to about 150 m). Opt-in, one screen explains it.
- **Can a phone really see a 10-second 2G drop?** Android exposes network-type changes through telephony callbacks. We demonstrate it on the emulator console and on the real phone's home screen.
- **Don't carriers already detect this?** Carriers can't see texts that never touch their network. A blaster delivers the SMS directly, so the phone is the only witness.

## Failure drills
Pull from `CentralMD/TESTING.md` §5: phone doesn't buzz → hidden debug trigger (long-press the app title); map frozen → refresh, then the saved recording; everything fails → play the recording and walk the slides.
