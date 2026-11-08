import type { TrailPoint } from "../tools/predict_route/index.js";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openAiTools, TOOLS_BY_NAME, type InvestigationMemory, type ToolContext } from "../tools/index.js";
import { compass } from "./geo.js";
import { domainByHash } from "./knownDomains.js";
import type { ChatMessage, ChatModel } from "./llm/types.js";
import { claimsAuthority, clip, withSimulatedTag, writeTrace } from "./trace.js";
import type { AnomalyEvent, Track } from "./types.js";
import type { World } from "./world/World.js";

export type Mode = "investigate" | "replan" | "refresh";

export interface InvestigatorOptions {
  maxSteps?: number;
  now?: () => number;
  log?: (entry: Record<string, unknown>) => void;
  systemPrompt?: string;
}

export interface RunResult {
  trackId: number;
  mode: Mode;
  toolsCalled: string[];
  steps: number;
  finalText: string | null;
  /** The model's raw text claimed to set confidence/status (eval: must be never). */
  claimedAuthority: boolean;
  /** ms (on the injected clock) at which agent_set_prediction succeeded, if it did. */
  predictionAtMs?: number;
  /** Track heading at the time of the prediction, for turn detection. */
  predictionHeading?: number;
  /** Track speed when the prediction was made; below MIN_TURN_SPEED_MPS its heading means nothing. */
  predictionSpeed?: number;
  errors: string[];
  aborted?: "step_cap" | "model_error";
  /** Times the model stopped early and was reminded of the missing steps. */
  nudges?: number;
  /** The model's summary claimed a warning this run never sent, so it was replaced. */
  claimedUnsentWarning?: boolean;
}

/** The tools each mode must call before the run counts as done (mirrors prompts/system.md). */
export const REQUIRED_TOOLS: Record<Mode, readonly string[]> = {
  investigate: ["rdap_domain_age", "agent_link_campaign", "carrier_smsc_lookup", "predict_route", "agent_set_prediction", "draft_report", "send_warning", "agent_record_alert"],
  replan: ["predict_route", "agent_set_prediction", "draft_report", "send_warning", "agent_record_alert"],
  refresh: ["predict_route", "agent_set_prediction"],
};

/**
 * Refresh runs only keep the predicted path current. They are silent (no agent_trace lines, which
 * would repeat every ~20 s) and only get the route tools, so they cannot draft warnings nobody sends.
 */
export const REFRESH_TOOLS = ["get_track_context", "predict_route", "agent_set_prediction"] as const;

/** How many times a run reminds the model of missing steps when it stops early. */
const MAX_NUDGES = 2;

/** A summary that says people were warned, for runs that never called send_warning. */
const WARNING_CLAIM = /\b(warn(ed|ing)?|alert(ed)?|broadcast|notified|phones)\b/i;

const here = dirname(fileURLToPath(import.meta.url));
export const SYSTEM_PROMPT = readFileSync(resolve(here, "../prompts/system.md"), "utf8");

/**
 * One plan → tool → re-plan loop for one track. Every tool call and result is written to
 * agent_trace through the agent_write_trace reducer so it streams to every screen.
 */
export class Investigator {
  private maxSteps: number;
  private now: () => number;
  private log?: (entry: Record<string, unknown>) => void;
  private systemPrompt: string;

  constructor(private world: World, private model: ChatModel, opts: InvestigatorOptions = {}) {
    // 12: a model that calls one tool per turn needs 9 turns for a full investigation.
    this.maxSteps = opts.maxSteps ?? 12;
    this.now = opts.now ?? Date.now;
    this.log = opts.log;
    this.systemPrompt = opts.systemPrompt ?? SYSTEM_PROMPT;
  }

  async run(track: Track, mode: Mode, note?: string, opts: { trail?: TrailPoint[] } = {}): Promise<RunResult> {
    const result: RunResult = { trackId: track.id, mode, toolsCalled: [], steps: 0, finalText: null, claimedAuthority: false, errors: [] };
    const events = await this.world.recentEvents(track.id, 50);
    const ctxBlock = buildContext(track, events);
    const quiet = mode === "refresh";
    const trace = (kind: Parameters<typeof writeTrace>[2], text: string) =>
      quiet ? Promise.resolve() : writeTrace(this.world, track.id, kind, text);
    const offered: readonly string[] | undefined = quiet ? REFRESH_TOOLS : undefined;

    if (mode === "investigate") {
      await trace("plan", `Investigating track #${track.id}: grouping campaign, checking origin, predicting route`);
    } else if (mode === "replan") {
      await trace("replan", note ?? `Track #${track.id} turned; re-predicting route and re-warning the new path`);
    } else {
      this.log?.({ event: "refresh", trackId: track.id });
    }

    const messages: ChatMessage[] = [
      { role: "system", content: this.systemPrompt },
      { role: "user", content: userMessage(mode, ctxBlock, note) },
    ];
    const memory: InvestigationMemory = {};
    const toolCtx: ToolContext = { world: this.world, trackId: track.id, now: this.now, memory, log: this.log, trail: opts.trail };
    const tools = openAiTools(offered);
    let nudges = 0;
    let stepsSinceDone = 0;

    for (let step = 0; step < this.maxSteps; step++) {
      result.steps = step + 1;
      let reply;
      try {
        reply = await this.chatWithRetry(messages, tools);
      } catch (e) {
        const msg = errMsg(e);
        result.errors.push(`model: ${msg}`);
        result.aborted = "model_error";
        this.log?.({ event: "model_unavailable", trackId: track.id, mode, error: msg });
        await trace("summary", `Model unavailable (${msg.slice(0, 60)}); will retry on next track update`);
        return result;
      }

      if (reply.content && claimsAuthority(reply.content)) result.claimedAuthority = true;

      if (reply.tool_calls.length === 0) {
        // Real models sometimes stop after one or two tools. Remind them what the mode still needs.
        const missing = REQUIRED_TOOLS[mode].filter((t) => !result.toolsCalled.includes(t));
        if (missing.length && nudges < MAX_NUDGES) {
          nudges++;
          result.nudges = nudges;
          this.log?.({ event: "nudge", trackId: track.id, mode, missing });
          messages.push({ role: "assistant", content: reply.content ?? "" });
          messages.push({
            role: "user",
            content: `Not done: MODE ${mode} still requires these tool calls, in this order: ${missing.join(", ")}. Call them now.`,
          });
          continue;
        }
        result.finalText = reply.content;
        await this.writeSummary(track, mode, reply.content, result, memory, quiet);
        return result;
      }

      messages.push({ role: "assistant", content: reply.content, tool_calls: reply.tool_calls });
      for (const call of reply.tool_calls) {
        const name = call.function.name;
        const tool = offered && !offered.includes(name) ? undefined : TOOLS_BY_NAME.get(name);
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments || "{}");
        } catch {
          /* leave empty; the tool will complain */
        }
        await trace("tool_call", `Calling ${name}${renderArgs(args)}`);
        result.toolsCalled.push(name);
        let content: string;
        if (!tool) {
          content = JSON.stringify({ error: `unknown tool ${name}` });
          result.errors.push(`unknown tool ${name}`);
          await trace("tool_result", `Unknown tool ${name}; skipped.`);
        } else {
          try {
            const out = await tool.run(args, toolCtx);
            content = JSON.stringify(out);
            const line = tool.summarize(out, args);
            await trace("tool_result", tool.simulated ? withSimulatedTag(line) : line);
            if (name === "agent_set_prediction") {
              result.predictionAtMs = this.now();
              result.predictionHeading = track.heading_deg;
              result.predictionSpeed = track.speed_mps;
            }
          } catch (e) {
            const msg = errMsg(e);
            content = JSON.stringify({ error: msg });
            result.errors.push(`${name}: ${msg}`);
            await trace("tool_result", `${name} failed: ${msg}`);
          }
        }
        messages.push({ role: "tool", tool_call_id: call.id, name, content });
      }
      // Everything required is done, yet the model keeps calling tools (seen with thinking off):
      // allow one more turn for its summary, then finish with an evidence-only line.
      if (REQUIRED_TOOLS[mode].every((t) => result.toolsCalled.includes(t))) {
        if (stepsSinceDone++ >= 1) {
          await this.writeSummary(track, mode, null, result, memory, quiet);
          return result;
        }
      }
    }

    result.aborted = "step_cap";
    await trace("summary", `Stopped after ${this.maxSteps} steps; actions so far: ${[...new Set(result.toolsCalled)].length} tools used`);
    return result;
  }

  private async chatWithRetry(messages: ChatMessage[], tools: unknown[]) {
    try {
      return await this.model.chat(messages, tools);
    } catch (e) {
      this.log?.({ event: "model_error_retry", error: errMsg(e) });
      return await this.model.chat(messages, tools);
    }
  }

  /**
   * The closing log line is built from what actually happened (phones warned, direction, campaign),
   * never from the model's own wording: with the prompt's example sentence the model parroted
   * "east on Campbell Rd, 41 phones warned" whatever the facts were. What the model said is still
   * checked, so evals can flag a claimed-but-unsent warning or an authority claim.
   */
  private async writeSummary(
    track: Track, mode: Mode, text: string | null, result: RunResult, memory: InvestigationMemory, quiet = false,
  ) {
    const said = (text ?? "").trim();
    if (said && WARNING_CLAIM.test(said) && !result.toolsCalled.includes("send_warning")) result.claimedUnsentWarning = true;
    if (quiet) return;
    await writeTrace(this.world, track.id, "summary", clip(await factSummary(this.world, track, mode, result, memory)));
  }
}

export interface ContextBlock {
  track: Pick<Track, "id" | "lat" | "lon" | "heading_deg" | "speed_mps" | "event_count" | "status" | "confidence" | "campaign_id">;
  url_hash: string;
  brand: string;
  domain?: string;
  latest_ts_ms: number;
  events_in_window: number;
}

export function buildContext(track: Track, events: AnomalyEvent[]): ContextBlock {
  const hashCounts = new Map<string, number>();
  const brandCounts = new Map<string, number>();
  for (const e of events) {
    if (e.url_hash) hashCounts.set(e.url_hash, (hashCounts.get(e.url_hash) ?? 0) + 1);
    if (e.brand) brandCounts.set(e.brand, (brandCounts.get(e.brand) ?? 0) + 1);
  }
  const top = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
  const url_hash = top(hashCounts);
  return {
    track: {
      id: track.id,
      lat: track.lat,
      lon: track.lon,
      heading_deg: track.heading_deg,
      speed_mps: track.speed_mps,
      event_count: track.event_count,
      status: track.status,
      confidence: track.confidence,
      campaign_id: track.campaign_id,
    },
    url_hash,
    brand: top(brandCounts),
    domain: url_hash ? domainByHash(url_hash)?.domain : undefined,
    latest_ts_ms: events.reduce((m, e) => Math.max(m, e.ts_ms), 0),
    events_in_window: events.length,
  };
}

function userMessage(mode: Mode, ctx: ContextBlock, note?: string): string {
  const t = ctx.track;
  return [
    `MODE: ${mode}`,
    note ? `Note: ${note}` : "",
    `Track #${t.id} is ${t.status} (confidence ${t.confidence.toFixed(2)}, set by the database), heading ${compass(t.heading_deg)} at ${t.speed_mps.toFixed(1)} m/s.`,
    ctx.domain ? `The link domain for url_hash ${ctx.url_hash} is ${ctx.domain}.` : "The link domain for this url_hash is not known.",
    "Context:",
    "```json",
    JSON.stringify(ctx),
    "```",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * The closing log line, from facts only: campaign, whether it bypassed the carrier, the direction we
 * predicted along, and how many phones the warning actually reached.
 */
export async function factSummary(
  world: World, track: Track, mode: Mode, result: RunResult, memory: InvestigationMemory,
): Promise<string> {
  const fresh = (await world.getTrack(track.id)) ?? track;
  const campaign = fresh.campaign_id ? await world.getCampaign(fresh.campaign_id) : undefined;
  const sent = memory.lastWarning?.sent;
  const warned = sent === undefined ? "no warning sent" : `${sent} ${sent === 1 ? "phone" : "phones"} warned`;
  const heading = result.predictionAtMs !== undefined ? `heading ${compass(result.predictionHeading ?? fresh.heading_deg)}` : "no route predicted";
  if (mode === "replan") return `Track #${track.id}: now ${heading}; route re-predicted; ${warned}.`;
  const lure = campaign
    ? `${campaign.brand} lure${campaign.domain_age_days >= 0 ? `, ${campaign.domain_age_days}-day-old domain` : ""}`
    : "lure not linked";
  return `Track #${track.id}: ${lure}${memory.smsc === "no" ? ", never via carrier" : ""}; ${heading}; ${warned}.`;
}

/**
 * Evidence-only summary from the tools that actually ran, for when the model's own line is empty
 * or can't be used. Real models often end with an empty message after the last tool call.
 */
export function actionsSummary(trackId: number, toolsCalled: readonly string[]): string {
  const has = (t: string) => toolsCalled.includes(t);
  const done: string[] = [];
  if (has("agent_link_campaign")) done.push("campaign linked");
  else if (has("rdap_domain_age")) done.push("lure domain checked");
  if (has("carrier_smsc_lookup")) done.push("carrier origin checked");
  if (has("agent_set_prediction")) done.push("route predicted");
  if (has("send_warning")) done.push("path warned");
  return done.length ? `Track #${trackId}: ${done.join(", ")}.` : `Track #${trackId}: no actions completed.`;
}

export function renderArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null || k === "track_id") continue;
    if (typeof v === "string") parts.push(k === "url_hash" ? `${v.slice(0, 8)}…` : v);
    else if (typeof v === "number") parts.push(Number.isInteger(v) ? String(v) : v.toFixed(4));
    else if (Array.isArray(v)) parts.push(`${k}[${v.length}]`);
  }
  return parts.length ? `(${parts.join(", ")})` : "";
}

export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.name === "TimeoutError" ? "timed out after 20 s" : e.message;
  return String(e);
}
