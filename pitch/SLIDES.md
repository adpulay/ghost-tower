# Ghost Tower: Slide Outline (5 slides)

Content draft for the deck. Build in whatever slide tool the team prefers; keep text sparse.

## 1. Hook
**Since August 3rd, no major US carrier runs a 2G network.**
Scammers built their own.
- Toronto: months to catch one blaster, 13M connections disrupted, 911 cut off.
- *(Role 3: confirm each figure against its source before the final deck.)*

## 2. How a blaster works
One diagram: car with fake tower → phones drop LTE→2G → SMS delivered directly → phones reconnect.
- Carrier spam filters never see the text.
- The phone is the only witness.

## 3. Live demo
No slide content. Switch to the analyst map.

## 4. Track slide: three panels
| T-Mobile (Role 3) | Spacetime (Role 1) | Nemotron (Role 2) |
|---|---|---|
| Classifier vs baseline (P / R / F1) | Live subscriptions, `recluster` time at 300 / 1,000 / 3,000 phones | Agent success rate over N runs |
| Localization error median / p90 | Reducers enforce confidence and status; agent can't write them | Tools called, replans after each turn |
| Protected-before-hit % | | |
| False alarms per 1,000 phone-hours | | |

Numbers come from `eval/results.md` and `classifier/results.md`. **Leave blank until real; never fill with targets.** Targets are in `CentralMD/TESTING.md` §3.

## 5. Close
**Scammers built a mobile network. We built the network that hunts it.**
Honesty line: the radio and most phones are simulated; the phone app, scoring, tracking, agent and alerts are real.
