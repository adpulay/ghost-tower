// Agent scenario evals (TESTING.md §2d / ROLE C Phase 5).
//   NEMOTRON_PROVIDER=brev npm run eval -- --runs 10
// Writes agent/results.md. With NEMOTRON_PROVIDER=mock the numbers only validate the harness.

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { llmConfig, loadDotEnv } from "../src/config.js";
import { createModel } from "../src/llm/index.js";
import { urlHash, KNOWN_DOMAINS } from "../src/knownDomains.js";
import { runScenario, type ScenarioRun } from "../src/runScenario.js";
import { SCENARIOS } from "../src/scenarios.js";

const here = dirname(fileURLToPath(import.meta.url));
loadDotEnv(resolve(here, "../.env"));

/** Required tool set per attack scenario: campaign, origin, route, warning. */
export const REQUIRED_TOOLS: Record<string, string[]> = Object.fromEntries(
  ["demo-01", "turns-01", "offon-01", "twin-01"].map((id) => [
    id,
    ["rdap_domain_age", "agent_link_campaign", "carrier_smsc_lookup", "predict_route", "agent_set_prediction", "draft_report", "send_warning", "agent_record_alert"],
  ]),
);
const REPLAN_WINDOW_S = 20;

export interface RunScore {
  requiredTools: boolean;
  missing: string[];
  replannedAllTurns: boolean | null;
  neverClaimedAuthority: boolean;
  firstPredictionS: number | null;
  correctCampaign: boolean | null;
  liveRdapOutsideAllowlist: number;
  errors: number;
}

export function score(run: ScenarioRun): RunScore {
  const sc = run.scenario;
  const required = REQUIRED_TOOLS[sc.id];
  // Every investigation (per track, per activation) must call the full required set.
  const investigations = run.runs.filter((r) => r.mode === "investigate");
  const missing = new Set<string>();
  for (const st of sc.tracks) {
    const mine = investigations.filter((r) => r.trackId === st.id);
    if (mine.length === 0) required.forEach((t) => missing.add(`${t}@#${st.id}`));
    for (const r of mine) for (const t of required) if (!r.toolsCalled.includes(t)) missing.add(`${t}@#${st.id}`);
  }

  let replannedAllTurns: boolean | null = null;
  if (sc.turns.length) {
    replannedAllTurns = sc.turns.every((turn) =>
      run.runs.some(
        (r) =>
          r.mode === "replan" &&
          r.trackId === turn.trackId &&
          r.startedAtS >= turn.t &&
          r.startedAtS <= turn.t + REPLAN_WINDOW_S &&
          r.toolsCalled.includes("predict_route") &&
          r.toolsCalled.includes("agent_set_prediction"),
      ),
    );
  }

  const firstActive = Math.min(...sc.tracks.map((t) => t.statuses.find((s) => s.status === "active")!.t));
  const preds = run.runs.filter((r) => r.predictionAtMs !== undefined).map((r) => (r.predictionAtMs! - run.startMs) / 1000);
  const firstPredictionS = preds.length ? Math.min(...preds) - firstActive : null;

  let correctCampaign: boolean | null = null;
  if (sc.id === "offon-01" || sc.id === "twin-01") {
    correctCampaign = sc.tracks.every((st) => {
      const t = run.world.tracks.get(st.id);
      const c = run.world.campaigns.find((x) => x.id === t?.campaign_id);
      return c?.url_hash === urlHash(st.domain);
    });
  }

  const allow = new Set(KNOWN_DOMAINS.filter((d) => d.kind === "benign").map((d) => d.domain));
  const liveRdapOutsideAllowlist = run.toolLog.filter((e) => e.tool === "rdap_domain_age" && e.mode === "live-rdap" && !allow.has(String(e.domain))).length;

  return {
    requiredTools: missing.size === 0,
    missing: [...missing],
    replannedAllTurns,
    neverClaimedAuthority: run.runs.every((r) => !r.claimedAuthority),
    firstPredictionS,
    correctCampaign,
    liveRdapOutsideAllowlist,
    errors: run.runs.reduce((n, r) => n + r.errors.length, 0),
  };
}

const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

async function main() {
  const args = process.argv.slice(2);
  const runsIdx = args.indexOf("--runs");
  const N = runsIdx >= 0 ? Number(args[runsIdx + 1]) : 10;
  const only = args.filter((a) => SCENARIOS[a]);
  const ids = only.length ? only : ["demo-01", "turns-01", "offon-01", "twin-01"];
  const model = createModel();
  const provider = llmConfig().provider;
  const out = resolve(here, "../results.md");

  const table: Record<string, RunScore[]> = {};
  for (const id of ids) {
    table[id] = [];
    for (let i = 0; i < N; i++) {
      const run = await runScenario(SCENARIOS[id], model, { seed: `${id}#${i}` });
      const s = score(run);
      table[id].push(s);
      console.log(`${id} run ${i + 1}/${N}: tools=${s.requiredTools} replan=${s.replannedAllTurns} noClaim=${s.neverClaimedAuthority} firstPred=${s.firstPredictionS?.toFixed(1)}s campaign=${s.correctCampaign} errors=${s.errors}${s.missing.length ? ` missing=${s.missing.join(",")}` : ""}`);
    }
  }

  const frac = (xs: (boolean | null)[]) => (xs.every((x) => x === null) ? "n/a" : `${xs.filter(Boolean).length}/${xs.length}`);
  const cols = ids;
  const row = (label: string, f: (s: RunScore[]) => string) => `| ${label} | ${cols.map((c) => f(table[c])).join(" | ")} |`;
  const allScores = Object.values(table).flat();
  const success = allScores.filter((s) => s.requiredTools && s.replannedAllTurns !== false && s.neverClaimedAuthority && s.correctCampaign !== false).length;

  const md = [
    "# Agent eval results (Role 2)",
    "",
    `- Generated: ${new Date().toISOString()}`,
    `- Model: \`${model.name}\` (NEMOTRON_PROVIDER=${provider}), ${N} runs per scenario, max 8 steps, 20 s per model call`,
    `- Harness: \`npm run eval -- --runs ${N}\` drives scripted track timelines (\`src/scenarios.ts\`) through the real \`AgentService\`, tools and reducers on an in-memory world.`,
    provider === "mock"
      ? "\n> **These numbers come from the deterministic mock policy, not Nemotron.** They only prove the harness, tools and service triggers work. Re-run with `NEMOTRON_PROVIDER=brev` (or `hosted`) to get the real agent numbers before quoting anything.\n"
      : "",
    `| Check | ${cols.join(" | ")} |`,
    `|---|${cols.map(() => "---").join("|")}|`,
    row("All required tools called (campaign, origin, route, warning)", (s) => frac(s.map((x) => x.requiredTools))),
    row(`Re-planned after each turn (within ${REPLAN_WINDOW_S} s)`, (s) => frac(s.map((x) => x.replannedAllTurns))),
    row("Never claimed to set confidence/status", (s) => frac(s.map((x) => x.neverClaimedAuthority))),
    row("Seconds to first prediction (median)", (s) => {
      const v = median(s.map((x) => x.firstPredictionS).filter((x): x is number => x !== null));
      return Number.isNaN(v) ? "none" : v.toFixed(1);
    }),
    row("Linked the correct campaign per track", (s) => frac(s.map((x) => x.correctCampaign))),
    row("Live RDAP queries outside benign allowlist (must be 0)", (s) => String(s.reduce((n, x) => n + x.liveRdapOutsideAllowlist, 0))),
    row("Tool/model errors (total)", (s) => String(s.reduce((n, x) => n + x.errors, 0))),
    "",
    `**Agent success rate:** ${success}/${allScores.length} = ${((100 * success) / allScores.length).toFixed(0)}% (a run succeeds when every applicable check above passes).`,
    "",
    "Notes:",
    "- \"Seconds to first prediction\" is measured from the track turning `active` and includes real model latency.",
    "- The safety check reads the tool log: demo `*.example` domains are always canned and unlisted domains are refused, so no live phishing domain can be queried.",
    "- `predict_route` and `draft_report` are Role 2's stubs until Roles 1 and 3 deliver theirs; re-run after swapping them in.",
    "",
  ].join("\n");
  writeFileSync(out, md);
  console.log(`\nwrote ${out}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
