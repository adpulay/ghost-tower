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
  errors: string[];
  aborted?: "step_cap" | "model_error";
}

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
    this.maxSteps = opts.maxSteps ?? 8;
    this.now = opts.now ?? Date.now;
    this.log = opts.log;
    this.systemPrompt = opts.systemPrompt ?? SYSTEM_PROMPT;
  }

  async run(track: Track, mode: Mode, note?: string): Promise<RunResult> {
    const result: RunResult = { trackId: track.id, mode, toolsCalled: [], steps: 0, finalText: null, claimedAuthority: false, errors: [] };
    const events = await this.world.recentEvents(track.id, 50);
    const ctxBlock = buildContext(track, events);

    if (mode === "investigate") {
      await writeTrace(this.world, track.id, "plan", `Investigating track #${track.id}: grouping campaign, checking origin, predicting route`);
    } else if (mode === "replan") {
      await writeTrace(this.world, track.id, "replan", note ?? `Track #${track.id} turned; re-predicting route and re-warning the new path`);
    } else {
      await writeTrace(this.world, track.id, "plan", note ?? `Refreshing route prediction for track #${track.id}`);
    }

    const messages: ChatMessage[] = [
      { role: "system", content: this.systemPrompt },
      { role: "user", content: userMessage(mode, ctxBlock, note) },
    ];
    const memory: InvestigationMemory = {};
    const toolCtx: ToolContext = { world: this.world, trackId: track.id, now: this.now, memory, log: this.log };
    const tools = openAiTools();

    for (let step = 0; step < this.maxSteps; step++) {
      result.steps = step + 1;
      let reply;
      try {
        reply = await this.chatWithRetry(messages, tools);
      } catch (e) {
        const msg = errMsg(e);
        result.errors.push(`model: ${msg}`);
        result.aborted = "model_error";
        await writeTrace(this.world, track.id, "summary", `Model unavailable (${msg.slice(0, 60)}); will retry on next track update`);
        return result;
      }

      if (reply.content && claimsAuthority(reply.content)) result.claimedAuthority = true;

      if (reply.tool_calls.length === 0) {
        result.finalText = reply.content;
        await this.writeSummary(track.id, reply.content, result);
        return result;
      }

      messages.push({ role: "assistant", content: reply.content, tool_calls: reply.tool_calls });
      for (const call of reply.tool_calls) {
        const name = call.function.name;
        const tool = TOOLS_BY_NAME.get(name);
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments || "{}");
        } catch {
          /* leave empty; the tool will complain */
        }
        await writeTrace(this.world, track.id, "tool_call", `Calling ${name}${renderArgs(args)}`);
        result.toolsCalled.push(name);
        let content: string;
        if (!tool) {
          content = JSON.stringify({ error: `unknown tool ${name}` });
          result.errors.push(`unknown tool ${name}`);
          await writeTrace(this.world, track.id, "tool_result", `Unknown tool ${name}; skipped.`);
        } else {
          try {
            const out = await tool.run(args, toolCtx);
            content = JSON.stringify(out);
            const line = tool.summarize(out, args);
            await writeTrace(this.world, track.id, "tool_result", tool.simulated ? withSimulatedTag(line) : line);
            if (name === "agent_set_prediction") {
              result.predictionAtMs = this.now();
              result.predictionHeading = track.heading_deg;
            }
          } catch (e) {
            const msg = errMsg(e);
            content = JSON.stringify({ error: msg });
            result.errors.push(`${name}: ${msg}`);
            await writeTrace(this.world, track.id, "tool_result", `${name} failed: ${msg}`);
          }
        }
        messages.push({ role: "tool", tool_call_id: call.id, name, content });
      }
    }

    result.aborted = "step_cap";
    await writeTrace(this.world, track.id, "summary", `Stopped after ${this.maxSteps} steps; actions so far: ${[...new Set(result.toolsCalled)].length} tools used`);
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

  private async writeSummary(trackId: number, text: string | null, result: RunResult) {
    let line = (text ?? "").trim();
    if (!line || result.claimedAuthority) {
      // Never broadcast an authority claim; fall back to an evidence-only line.
      const used = [...new Set(result.toolsCalled)];
      line = `Done: ${used.length} tools used (${used.slice(0, 4).join(", ")}${used.length > 4 ? ", …" : ""}).`;
    }
    await writeTrace(this.world, trackId, "summary", clip(line));
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

function renderArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null || k === "track_id") continue;
    if (typeof v === "string") parts.push(k === "url_hash" ? `${v.slice(0, 8)}…` : v);
    else if (typeof v === "number") parts.push(Number.isInteger(v) ? String(v) : v.toFixed(4));
    else if (Array.isArray(v)) parts.push(`${k}[${v.length}]`);
  }
  return parts.length ? `(${parts.join(", ")})` : "";
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.name === "TimeoutError" ? "timed out after 20 s" : e.message;
  return String(e);
}
