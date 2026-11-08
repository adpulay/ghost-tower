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
| goes `active` (or comes back from `dormant`) | **investigate**: group campaign, check origin, predict route, warn path | `plan` … `summary` |
| heading changes > 45° from the last prediction (speed ≥ 2 m/s, once the turn settles) | **replan**: re-predict and re-warn | `replan` (highlighted on the panel) |
| prediction older than 20 s | **refresh**: re-predict only | `plan` "Refreshing…" |
| goes `dormant` | nothing to do | `summary` "Track dormant, watching for campaign reappearance" |

Guardrails:
- At most 8 model steps per run, a 20 s timeout per model call, and one retry. Failures write a
  trace line and retry 10 s later; they don't crash the service.
- Write tools are pinned to the track under investigation. **No tool can write
  `track.confidence` or `track.status`.** The final summary is checked for claims that the
  agent set them. If one is found, it's flagged for evals and replaced with an evidence-only
  line.
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

`src/world/spacetimeHttp.ts` uses SpacetimeDB's HTTP API (`/sql` to read, `/call/<reducer>` to
write) and polls `track` every second. It works before Role 1's generated bindings exist.
Reducer arguments are sent positionally, in the field order in INTERFACES.md §2/§3. If Role 1's
module uses a different order, change it in that one file.

## Files

- `prompts/system.md`: system prompt
- `src/scenarios.ts`: scripted `demo-01`, `turns-01`, `offon-01`, `twin-01` track timelines for evals/offline runs
- `eval/run.ts` → `results.md`: scenario evals (TESTING.md §2d)
- `replay/demo-01.json`: recorded run for the fallback. **The committed file was recorded with
  the mock policy.** Re-record it from a clean live `demo-01` run before judging.
- `PITCH_PANEL.md`: draft Nemotron panel for the track slide
