import type { TrailPoint } from "../tools/predict_route/index.js";
import { TOOLS_BY_NAME, type InvestigationMemory, type ToolContext } from "../tools/index.js";
import type { DraftResult } from "../tools/draft_report/index.js";
import { buildContext, errMsg, factSummary, renderArgs, type Mode, type RunResult } from "./agent.js";
import { clip, withSimulatedTag, writeTrace } from "./trace.js";
import type { Track } from "./types.js";
import type { World } from "./world/World.js";

type TraceKind = Parameters<typeof writeTrace>[2];

export interface PlaybookOptions {
  now?: () => number;
  log?: (entry: Record<string, unknown>) => void;
}

/**
 * Runs an investigation as a short playbook in code instead of a model-driven tool loop.
 *
 * Why: in the model loop every step was a model round trip followed by a database write, about
 * 11 sequential turns and ~12 s per investigation, and the model never made a real choice: it ran
 * the same eight tools in the same order every time. Here the independent steps run in parallel
 * and the model is called once, inside draft_report, to write the warning text, then (in the background, see
 * queueEvidence) to write the police brief and the registrar report:
 *
 *   investigate:  [rdap_domain_age | carrier_smsc_lookup | predict_route]
 *                 → [agent_link_campaign | agent_set_prediction] → draft_report → send_warning → agent_record_alert
 *   replan:       predict_route → [agent_set_prediction | draft_report] → send_warning → agent_record_alert
 *
 * It uses the same tools, the same log lines and the same fact-based closing line as the model
 * loop (src/agent.ts, still available with AGENT_MODE=llm). The tools' hard rules are unchanged:
 * nothing here can write track.confidence or track.status.
 *
 * agent_trace writes go through a per-track queue that keeps their order but does not block the
 * actions, so the map updates as soon as the work is done and the log catches up behind it.
 */
export class PlaybookInvestigator {
  private now: () => number;
  private log?: (entry: Record<string, unknown>) => void;
  private traceChains = new Map<number, Promise<void>>();
  private evidence = new Set<Promise<void>>();

  constructor(private world: World, opts: PlaybookOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log;
  }

  /** Resolves once every queued agent_trace line and evidence report has been written (tests, and clean shutdown). */
  async flushTraces(): Promise<void> {
    await Promise.all([...this.traceChains.values(), ...this.evidence]);
  }

  /**
   * Writes the evidence packet without holding up the run: while a run is in progress the service pauses this
   * track's route refreshes, and these drafts can take several seconds. Failures are logged and never affect the warning.
   */
  private queueEvidence(toolCtx: ToolContext, kinds: ("police" | "registrar")[]): void {
    const draft = TOOLS_BY_NAME.get("draft_report");
    if (!draft) return;
    const job: Promise<void> = Promise.all(
      kinds.map(async (kind) => {
        try {
          const out = (await draft.run({ track_id: toolCtx.trackId, kind }, toolCtx)) as DraftResult;
          await this.world.agentSaveReport(toolCtx.trackId, kind, out.text, out.generated);
        } catch (e) {
          this.log?.({ event: "evidence_error", track: toolCtx.trackId, kind, error: errMsg(e) });
        }
      }),
    )
      .then(() => undefined)
      .finally(() => this.evidence.delete(job));
    this.evidence.add(job);
  }

  private trace(trackId: number, kind: TraceKind, text: string): void {
    const prev = this.traceChains.get(trackId) ?? Promise.resolve();
    this.traceChains.set(
      trackId,
      prev.then(() => writeTrace(this.world, trackId, kind, text)).catch((e) => this.log?.({ event: "trace_error", trackId, error: errMsg(e) })),
    );
  }

  async run(track: Track, mode: Mode, note?: string, opts: { trail?: TrailPoint[] } = {}): Promise<RunResult> {
    const result: RunResult = { trackId: track.id, mode, toolsCalled: [], steps: 0, finalText: null, claimedAuthority: false, errors: [] };
    const quiet = mode === "refresh";
    const events = await this.world.recentEvents(track.id, 50);
    const ctx = buildContext(track, events);
    const memory: InvestigationMemory = {};
    const toolCtx: ToolContext = { world: this.world, trackId: track.id, now: this.now, memory, log: this.log, trail: opts.trail };
    const say = (kind: TraceKind, text: string) => { if (!quiet) this.trace(track.id, kind, text); };

    /** Run one tool and log it exactly as the model loop does. Failures are recorded and do not stop the run. */
    const call = async (name: string, args: Record<string, unknown>): Promise<any> => {
      const tool = TOOLS_BY_NAME.get(name);
      if (!tool) throw new Error(`playbook references unknown tool ${name}`);
      say("tool_call", `Calling ${name}${renderArgs(args)}`);
      result.toolsCalled.push(name);
      try {
        const out = await tool.run(args, toolCtx);
        const line = tool.summarize(out, args);
        say("tool_result", tool.simulated ? withSimulatedTag(line) : line);
        return out;
      } catch (e) {
        const msg = errMsg(e);
        result.errors.push(`${name}: ${msg}`);
        say("tool_result", `${name} failed: ${msg}`);
        return undefined;
      }
    };
    const stage = () => { result.steps++; };
    const publishRoute = async () => {
      if (!memory.lastPrediction) return;
      if (await call("agent_set_prediction", {})) {
        result.predictionAtMs = this.now();
        result.predictionHeading = track.heading_deg;
        result.predictionSpeed = track.speed_mps;
      }
    };
    const predict = () =>
      call("predict_route", { lat: track.lat, lon: track.lon, heading_deg: track.heading_deg, speed_mps: track.speed_mps, horizon_s: 300 });
    const warn = async () => {
      if (!memory.lastPrediction || !memory.lastDraft) {
        say("tool_result", "No route or warning text, so no warning was sent.");
        return;
      }
      stage();
      await call("send_warning", {});
      if (memory.lastWarning) {
        stage();
        await call("agent_record_alert", {});
      }
    };

    if (mode === "investigate") {
      say("plan", `Investigating track #${track.id}: grouping campaign, checking origin, predicting route`);
      stage(); // 1: the independent lookups, in parallel
      const [rdap] = await Promise.all([
        ctx.domain ? call("rdap_domain_age", { domain: ctx.domain }) : undefined,
        ctx.url_hash ? call("carrier_smsc_lookup", { url_hash: ctx.url_hash, ts_ms: ctx.latest_ts_ms }) : undefined,
        predict(),
      ]);
      stage(); // 2: record what we learned, in parallel
      await Promise.all([
        ctx.url_hash ? call("agent_link_campaign", { url_hash: ctx.url_hash, brand: ctx.brand, domain_age_days: Number(rdap?.age_days ?? -1) }) : undefined,
        publishRoute(),
      ]);
      stage(); // 3: the one model call
      await call("draft_report", { track_id: track.id, kind: "warning" });
      await warn();
    } else if (mode === "replan") {
      say("replan", note ?? `Track #${track.id} turned; re-predicting route and re-warning the new path`);
      stage();
      await predict();
      stage();
      await Promise.all([publishRoute(), call("draft_report", { track_id: track.id, kind: "warning" })]);
      await warn();
    } else {
      // refresh: route only, silent
      stage();
      await predict();
      await publishRoute();
    }

    if (!quiet) this.trace(track.id, "summary", clip(await factSummary(this.world, track, mode, result, memory)));
    if (mode === "investigate") this.queueEvidence(toolCtx, ["police", "registrar"]);
    else if (mode === "replan") this.queueEvidence(toolCtx, ["police"]); // the position and intercept changed; the domain didn't
    return result;
  }
}
