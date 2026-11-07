# Ghost Tower

Detect, track and warn people about SMS-blaster fake cell towers. Phones report suspicious 2G drops and scam texts; Spacetime fuses them into tracks; a Nemotron agent predicts the route, drafts warnings and briefs; an analyst map and a patrol tablet show it live.

Planning docs: `CentralMD/INTERFACES.md` (the shared contract) and `CentralMD/TESTING.md`. Per-role plans: `A.zip` (Role 1), `C.zip` (Role 2), `J/J.md` (Role 3).

## Layout

| Folder | Owner | What |
|---|---|---|
| `web/` | Role 3 | React app shell, analyst map (`/`), patrol slot (`/patrol`), trace panel slot |
| `web/src/trace-panel/` | Role 2 | Live agent trace component |
| `web/src/patrol/` | Role 1 | Patrol tablet view. **Not in the repo yet** |
| `agent/` | Role 2 | Nemotron agent service and tools (`draft_report` is Role 3's) |
| `classifier/` | Role 2 | SMS scam classifier and `/score` endpoint |
| `android/` | Role 3 | Phone sensor app |
| `pitch/` | Role 3 | Demo script and slide outline |
| `spacetime/`, `sim/`, `eval/` | Role 1 | **Not in the repo yet** |

## Run it

```bash
# 1. Web app on simulated data (no backend needed): http://localhost:5173
cd web && npm install && npm run dev

# 2. Agent tests, offline (mock model)
cd agent && npm install && NEMOTRON_PROVIDER=mock npx tsx --test test/*.test.ts

# 3. Classifier tests (Windows needs -X utf8)
python -X utf8 -m unittest discover -s classifier/tests

# 4. Classifier /score endpoint on :8001 (rule-based scorer until a model is trained, see classifier/README.md)
python classifier/server.py

# 5. Android: open android/ in Android Studio and run (see android/README.md)
```

The web app uses a built-in simulated feed until it is pointed at Spacetime: set `VITE_SPACETIME_URI` in `web/.env` (see `web/.env.example`) once Role 1's schema is live. `?debug=1` shows simulator ground truth; leave it off on the big screen.

## Integration status

| Piece | State |
|---|---|
| Role 2 trace panel mounted in the web shell | done |
| `draft_report` called by the agent (TypeScript, LLM-backed with fallbacks) | done, untested against real Nemotron |
| Android `/score` URL matches the classifier port (8001) | done |
| Android and agent both call Spacetime over HTTP (`/call/<reducer>`, `/sql`) | consistent, untested against a live host |
| Web `liveSource.ts` wired to Spacetime | **todo**, needs Role 1's generated bindings |
| Role 1: Spacetime module, simulator, eval, patrol view | **not merged** |
| Android app compiled | **todo**, needs Android Studio |

Mocked parts are labelled "simulated" on screen. Copy `.env.example` to `.env` for the agent (never commit it).
