# Agent (Role 2): Nemotron investigation agent

A long-lived service that watches the Spacetime `track` table and, for every track that goes
`active`, runs a plan → tool → re-plan loop on Nemotron. Every tool call and result goes to
`agent_trace` through the `agent_write_trace` reducer, so it streams live to every screen.

Requires **Node.js 22.23.4 or newer** (pinned in `/.nvmrc`; `npm install` refuses older versions).

```bash
nvm use                               # from the repo root, picks up .nvmrc
cd agent && npm install
cp ../.env.example ../.env            # fill in Brev URL, Spacetime, Twilio
npm run warm                          # one dummy request; run right before judging
npm start                             # watch Spacetime and investigate tracks
npm start -- --record replay/demo-01.json   # same, and record everything the agent writes (Ctrl-C saves)
npm run replay -- replay/demo-01.json --track-id 1   # fallback: write a recorded run back with its original timing
NEMOTRON_PROVIDER=mock npx tsx src/cli.ts local demo-01   # offline: scripted track + mock policy, prints the trace
npm test                              # unit tests (tools, loop guardrails, service triggers, replay)
npm run eval -- --runs 10             # scenario evals → results.md
```

## Switching models

`NEMOTRON_PROVIDER` is the only switch: `brev` (vLLM on the Brev box), `hosted`
(build.nvidia.com), or `mock` (a deterministic scripted policy for offline tests; it is not the
model).

Serve Nemotron on Brev with tool calling turned on. Check the model card for the current flags:

```bash
vllm serve --model "nvidia/NVIDIA-Nemotron-Nano-3-30B-A3B-FP8" --dtype auto --trust-remote-code \
  --served-model-name nemotron --host 0.0.0.0 --port 5000 \
  --enable-auto-tool-choice --tool-call-parser qwen3_coder --reasoning-parser deepseek_r1
```

## How it behaves (`src/service.ts`, `src/agent.ts`)

| Track event | Agent action | Trace |
|---|---|---|
| goes `active` (or comes back from `dormant`) | **investigate** once its direction can be trusted (see below): group campaign, check origin, predict route, warn path. Run as a **playbook** (below) | `plan` … `summary` |
| heading changes > 45° from the last prediction (speed ≥ 2 m/s, once the turn settles) | **replan**: re-predict and re-warn | `replan` (highlighted on the panel) |
| prediction older than 4 s | **refresh**: re-predict and re-publish the route. **Plain computation, no model call**, no log lines. Also runs mid-turn, aimed along where the track is actually going, so the route and the warning zone drawn from it follow the car instead of waiting for the replan | none (the map shows the new path and zone) |
| goes `dormant` | nothing to do | `summary` "Track dormant, watching for campaign reappearance" |

**First warning waits for a trustworthy direction.** A new track reports little or no speed and a noisy heading,
so a prediction made at once points at nobody (seen live: heading northwest for a car driving east; the first
warning reached 0 phones in three runs). The first investigation starts when the track is moving (>= 2 m/s)
and its reported heading is within 45 degrees of where its position has actually gone over the last 8 s,
or after 25 s regardless (`FIRST_WARNING_MAX_WAIT_MS`). Replans and refreshes are unaffected.

**Playbook, not a tool loop (`src/playbook.ts`, `AGENT_MODE`).** By default the investigation is a short playbook in
code: the independent steps run in parallel and the model is called **once**, inside `draft_report`, to write
the warning text. Investigate is `[rdap_domain_age | carrier_smsc_lookup | predict_route]` → `[agent_link_campaign |
agent_set_prediction]` → `draft_report` → `send_warning` → `agent_record_alert`; replan is `predict_route` →
`[agent_set_prediction | draft_report]` → `send_warning` → `agent_record_alert`. Same tools, same log lines and same
fact-based closing line as before. `agent_trace` writes go through a per-track queue that keeps their order but
does not block the actions, so the map updates first and the log catches up. In the old model loop every step was
a model round trip (about 11 per investigation, ~12 s), and the model ran the same eight tools in the same order
every time. Set `AGENT_MODE=llm` to get the model-driven loop back (the model chooses tools turn by turn).

Guardrails:
- At most 12 model steps per run (a model that stops before its mode's required tools are done gets up to 2 reminders; the closing log line is built from facts, see below), a 20 s timeout per model call, and one retry. Failures write a
  trace line and retry 10 s later; they don't crash the service.
- Write tools are pinned to the track under investigation. **No tool can write
  `track.confidence` or `track.status`.**
- **The closing log line is built from facts, not from the model's wording** (`factSummary` in
  `src/agent.ts`): e.g. `Track #3: TxTag lure, 2-day-old domain, never via carrier; heading east; 31 phones
  warned.` The phone count is what `send_warning` really reached; the direction is the one predicted. Live,
  the model copied the prompt's example sentence ("east on Campbell Rd, 41 phones warned") whatever the
  facts were. What the model said is still recorded (`finalText`) and checked, so evals can flag an authority
  claim or a warning it claimed but never sent.
- **Replans need a trustworthy direction too.** A turn is only acted on once the heading has settled *and*
  agrees with where the track actually went. At low speed the reported heading is noise (seen live:
  "turned 55 degrees, now heading northwest" part-way up a straight road).
- **A moving vehicle is predicted at no less than 8 m/s** (`MIN_MOVING_SPEED_MPS` in
  `tools/predict_route/index.ts`). New tracks under-estimate speed (4 m/s for a car doing 11), which made the
  warned path far too short. Parked and walking speeds (< 2 m/s) are used as given.
- Trace lines are ≤140 chars. Results from mocked tools end in `[simulated]`, which the trace
  panel shows as a tag.

## Tools (`tools/`, INTERFACES.md §7)

| Tool | Status | Notes |
|---|---|---|
| `get_track_context` | real | track row + last 50 events from Spacetime |
| `rdap_domain_age` | real for allowlisted benign domains; **canned for `*.example` demo domains**; unlisted domains are refused | never queries a live phishing domain; every decision is logged to `logs/tool_calls.jsonl` |
| `carrier_smsc_lookup` | **mock** | campaign hash → `no`, benign toll hash → `yes`, else `unknown` |
| `send_warning` | real Twilio to `TWILIO_VERIFIED_NUMBERS` only + simulated phone count | refuses text >160 chars or with a link; real texts throttled to one burst per 60 s |
| `predict_route` | **stub (Role 1 owns)** | straight-line projection; replace `tools/predict_route/index.ts` body, keep the signature |
| `draft_report` | **stub (Role 3 owns)** | fixed templates (also Role 3's required fallback); replace `tools/draft_report/index.ts` body |
| `agent_link_campaign`, `agent_set_prediction`, `agent_record_alert` | reducers | arguments are optional where they can be filled from the previous tool result |

`config/known_domains.json` maps link domains to `url_hash` (SHA-256 of the normalized domain,
the same normalization as `classifier/features.py`). Add the simulator's demo domains there.

## Spacetime connection

The module is in `spacetime/` (see `spacetime/README.md`). Maincloud database:
`ghost-tower-94144`; that is the default, so `.env` only needs `SPACETIME_HOST`/`SPACETIME_DB`
for the local fallback.

`src/world/spacetimeHttp.ts` uses SpacetimeDB's HTTP API (`/sql` to read, `/call/<reducer>` to
write) and polls `track` every second. Reducer arguments are sent positionally, in the order the
module declares them (`spacetime/src/index.ts`, same as INTERFACES.md §2/§3).

```bash
# agent against a local module (mock model, no Twilio)
NEMOTRON_PROVIDER=mock SPACETIME_HOST=http://127.0.0.1:3010 SPACETIME_DB=ghost-tower npm start
# meanwhile, in spacetime/: feed a fake blaster so recluster creates an active track
npm run smoke -- --host http://127.0.0.1:3010 --db ghost-tower
```

## Files

- `prompts/system.md`: system prompt
- `src/scenarios.ts`: scripted `demo-01`, `turns-01`, `offon-01`, `twin-01` track timelines for evals/offline runs
- `eval/run.ts` → `results.md`: scenario evals (TESTING.md §2d)
- `replay/demo-01.json`: recorded run for the fallback. **The committed file was recorded with
  the mock policy.** Re-record it from a clean live `demo-01` run before judging.
- `PITCH_PANEL.md`: draft Nemotron panel for the track slide
