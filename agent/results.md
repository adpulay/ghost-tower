# Agent eval results (Role 2)

- Generated: 2026-11-07T21:17:41.976Z
- Model: `mock:policy` (NEMOTRON_PROVIDER=mock), 10 runs per scenario, max 8 steps, 20 s per model call
- Harness: `npm run eval -- --runs 10` drives scripted track timelines (`src/scenarios.ts`) through the real `AgentService`, tools and reducers on an in-memory world.

> **These numbers come from the deterministic mock policy, not Nemotron.** They only prove the harness, tools and service triggers work. Re-run with `NEMOTRON_PROVIDER=brev` (or `hosted`) to get the real agent numbers before quoting anything.

| Check | demo-01 | turns-01 | offon-01 | twin-01 |
|---|---|---|---|---|
| All required tools called (campaign, origin, route, warning) | 10/10 | 10/10 | 10/10 | 10/10 |
| Re-planned after each turn (within 20 s) | 10/10 | 10/10 | n/a | 10/10 |
| Never claimed to set confidence/status | 10/10 | 10/10 | 10/10 | 10/10 |
| Seconds to first prediction (median) | 0.0 | 0.0 | 0.0 | 0.0 |
| Linked the correct campaign per track | n/a | n/a | 10/10 | 10/10 |
| Live RDAP queries outside benign allowlist (must be 0) | 0 | 0 | 0 | 0 |
| Tool/model errors (total) | 0 | 0 | 0 | 0 |

**Agent success rate:** 40/40 = 100% (a run succeeds when every applicable check above passes).

Notes:
- "Seconds to first prediction" is measured from the track turning `active` and includes real model latency.
- The safety check reads the tool log: demo `*.example` domains are always canned and unlisted domains are refused, so no live phishing domain can be queried.
- `predict_route` and `draft_report` are Role 2's stubs until Roles 1 and 3 deliver theirs; re-run after swapping them in.
