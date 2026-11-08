## Inspiration
SMS blasters are fake cell towers small enough to fit in a car trunk. They drive through a neighbourhood, pull every nearby phone down to 2G, and text phishing links straight to them: "your toll is overdue", "your package is held". Because the text never passes through a carrier, carrier spam filters never see it, and the carrier has no record it was sent. The only witness is the phone that received it.

That got us thinking: if every phone is a witness, what happens when the phones compare notes?

## What it does
Ghost Tower is a working prototype of a crowd-sourced sensor network for fake cell towers. The radio side is simulated, and everything downstream of it is real software.

- **The phone reports.** Our Android demo app runs the detection logic for a blaster's pattern: a sudden drop to 2G, with a scam-scored text arriving during that drop or within 10 seconds after. In this build, the 2G drop and the text are simulated and played through that logic when the simulated car passes. The app warns the owner ("Don't tap the link") and sends an anonymous report: a score, the brand being impersonated, a hash of the link's domain and a coarsened location.
- **The database tracks.** Reports stream into SpacetimeDB, which fuses and clusters them every 3 seconds into a moving track: one blaster driving down one road, not a scatter of complaints. A track only becomes "active" once enough phones agree.
- **The agent investigates.** Each active track gets the same fast investigation, run by code, with NVIDIA Nemotron Nano 3 on Brev writing the words:
  - **The lure:** it checks how old the link's domain is and links the track to its phishing campaign.
  - **The origin:** it runs a carrier-origin check, which is simulated for now and labelled that way.
  - **The route:** it predicts the vehicle's route along real roads using an offline road map.
  - **The warning:** Nemotron drafts a plain-language warning from database facts, and it goes out for the phones in the predicted path, before the blaster gets there.
  - **The turn:** when the car turns, the agent notices, updates the route and warns again.
  - **The case:** Nemotron drafts a police brief and a domain-registrar abuse report in the background.
- **People watch it happen.** Analysts see everything on a live map with a plain-language status sidebar and activity log, and can open the technical trace of every step. A patrol tablet shows the predicted route and intercept point. The demo phone shows "Fake tower heading your way" when its spot falls inside a warning zone.

**Hard rule:** the AI never decides whether something is a threat. Only the database's tracking math sets a track's confidence and status. The model writes from the evidence, and the data decides.

## How we built it
- **Android demo app (Kotlin):** a foreground service polls the database over HTTP, and fires the demo when an active track comes within 300 m of the phone's pinned spot. The window logic, classifier call, report and notification are real; the inputs are simulated. This build has no 2G listener and no SMS receiver, so it never reads a real text. Permissions are optional, and the scam-checker address can be changed in the app.
- **SpacetimeDB on Maincloud (TypeScript module):**
  - **Live data:** it's the shared real-time state. The reducers fuse signals into a score and cluster events (800 m, 120 s, separated by phishing campaign). Each track blends a recency-weighted centroid with its predicted position, then takes speed and heading from its last two smoothed positions.
  - **Access:** phones report anonymously, and the module restricts every other write to the database's operator.
  - **Clients:** the web screens subscribe live; the agent and the phone talk to it over HTTP.
- **Simulator (TypeScript):** it drives a seeded blaster along real Richardson roads past hundreds of simulated phones, mixed with realistic noise: normal handovers, 2G dropouts, parking garages, foreign cells and real toll texts. It also records ground truth, so we can measure the tracker against it.
- **Agent (TypeScript + Nemotron):**
  - **Serving:** Nemotron Nano 3 (30B-A3B, FP8), served by vLLM on an RTX PRO 6000 Blackwell on Brev. One script starts the model, classifier, tunnel and agent.
  - **Playbook:** by default, code runs the independent steps in parallel and calls the model only to write. The original model-driven tool loop is still available with `AGENT_MODE=llm`.
  - **Tools:** domain age via RDAP, the simulated carrier check, route prediction, report drafting, warnings, and database writes.
  - **Route prediction:** it walks an offline OpenStreetMap road graph, falling back to OSRM and then a straight line.
  - **Warnings:** real Twilio texts go only to verified team phones, and an optional ntfy relay pushes alerts to the demo phone. The reported count also includes simulated phones inside the zone.
  - **Guardrails:** every piece of model text must pass hard checks (a warning is at most 160 characters with no link) or a fixed template is used, and the console labels which it was. The model loop also has a step cap, timeouts, completion checks, and a filter that catches made-up claims in the model's summaries.
- **Scam-text classifier (Python):** served at `/score`, and it never logs message text. The training pipeline is built (word and character TF-IDF plus handcrafted features for brand keywords, suspicious links, urgency and money, with logistic regression), but the labelled dataset isn't in yet, so it currently serves a rule-based scorer.
- **Web (React, Leaflet, Vite, on Vercel):** the analyst map with its status sidebar, the patrol view, the evidence packet, and the live agent trace, behind a demo-only login.

## Challenges we ran into
- **Two clocks.** The simulator's clock runs ahead at demo speed, while a real phone stamps reports with wall-clock time. At 4x, the phone's reports fell outside the 120-second clustering window and never joined the track. Fixing it meant having the phone stamp each report with the later of its own clock and the simulator's.
- **Getting Nemotron running on a brand-new GPU.** On the Blackwell box, vLLM crashed twice: first because the FlashInfer package for attention was missing, then because FlashInfer's sampler needed a CUDA compiler the box didn't have. We moved attention to Triton and switched off FlashInfer's sampler. We also found the latest vLLM rejects an empty tools list, which broke our warm-up call.
- **Real models aren't scripted.** Our offline mock policy called every tool perfectly every time. Real Nemotron sometimes stopped after one tool, and once its summary claimed it had warned 41 phones when it hadn't sent anything. We added completion checks and a filter for those claims. Then we noticed the model ran the same tools in the same order every time, at about 12 seconds per investigation, so we moved those steps into code and kept the model for writing.
- **Predicting real roads.** Asking a router for a route to a point "straight ahead" usually picks an off-road point, so paths ended in a hook toward an arbitrary spot. Walking an offline road graph fixed that and removed the dependency on a public server during the demo.
- **Signal versus noise.** Ordinary phones drop to 2G all the time: parking garages, handovers, dead zones. The tracker has to ignore that and still lock on to a blaster within seconds, including the moment it turns a corner.
- **Four people, one shared schema.** We wrote an interface contract first and merged a lot of branches against it.

## Accomplishments that we're proud of
- **The full loop runs live:** a simulated blaster, then a real Android phone's report joining its track, then the agent investigating, predicting the route, re-planning after the turn and warning phones ahead. The full run takes about two and a half minutes at 3x speed, with the first warning about 15 seconds in.
- **The agent can't overrule the data:** it has no way to set confidence or status, and the trace shows exactly what it did and why.
- **It holds up on ground truth:** in simulator testing, no benign scenario produced a false active track across 450 phone-hours. On the demo route, a track goes active 12 seconds after the blaster starts, with a median position error of 264 m. Text alone gave 4 false tracks and the 2G drop alone gave 12; combined, they gave none.
- **Privacy is built in:** no message text in the database, no phone numbers, a coarsened location, and an opt-in screen. The demo app has no permission to read texts at all, and it checks warning zones on the device.
- **The demo is honest:** the blaster, the 2G drop and the text on the phone are simulated, and we say so. The app, scoring, reporting, tracking, agent and alerts are real software.

## What we learned
- Building against a real-time database changes how you design. When every screen reacts to the same tables, the demo gets much simpler.
- Agents need guardrails measured against real models, not mocks. The failures we hit only appeared once real Nemotron was in the loop.
- Not every step needs a model. Letting code run the fixed steps made the agent faster and more predictable, and let Nemotron focus on the writing it's good at.
- Clocks, units and coordinate order cause more bugs than the algorithms do.
- Cellular security is a policy problem as much as a technical one: we can't legally transmit as a fake tower even to test, so simulation and ground truth aren't optional.

## What's next for Ghost Tower
- **Real detection on phones:** add the real 2G listener and SMS receiver, with the phone's actual rounded location.
- **Real carrier data:** replace the simulated carrier-origin check with a real one, through a carrier partnership.
- **Field testing:** test with real blaster signals inside an RF-shielded lab, under the right authorisation.
- **Measured results:** train and evaluate the classifier on carrier-labelled scam-text data, and publish precision and recall numbers.
- **Better coverage:** handle phones with no location fix, support more Android versions and hardware, and extend the road map beyond Richardson.
- **Partners:** route the police briefs and registrar reports to the people who can act on them: carriers, domain registrars and local police.
