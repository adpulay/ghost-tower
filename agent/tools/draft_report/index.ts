// OWNER: Role 3. LLM-backed draft_report with hard checks and fixed-template fallbacks.
// Contract (INTERFACES.md §7): draft_report(track_id, kind: "police"|"registrar"|"warning") -> { text }
//
// The model only writes words. Every fact comes from Spacetime rows and is filled into the
// prompt; whatever the model returns must pass the checks below or the fixed template is
// sent instead. With no model (mock provider, no `llm` dep, timeout, error) the template is used.

import { llmConfig } from "../../src/config.js";
import { compass } from "../../src/geo.js";
import { domainByHash } from "../../src/knownDomains.js";
import { createModel } from "../../src/llm/index.js";
import type { ChatModel } from "../../src/llm/types.js";
import type { World } from "../../src/world/World.js";
import type { ToolDef } from "../types.js";
import { validateWarning } from "../send_warning.js";
import { renderPrompt, type PromptFacts } from "./prompts.js";

export type ReportKind = "police" | "registrar" | "warning";

export const POLICE_MAX_LINES = 5;
const DEFAULT_DRAFT_TIMEOUT_MS = 8_000;

export interface DraftReportDeps {
  world: World;
  areaName?: string;
  /** Model used to write the text. Omit to use the fixed templates only. */
  llm?: ChatModel;
  /** Hard cap on one generation, so a slow model can't stall the agent. */
  timeoutMs?: number;
  log?: (entry: Record<string, unknown>) => void;
}

interface Facts extends PromptFacts {
  /** Raw values the templates and checks need (PromptFacts holds the display strings). */
  trackLat?: number;
  trackLon?: number;
  speedMps?: number;
  interceptLat?: number;
  interceptLon?: number;
  etaS?: number;
  campaignDomainAge: number;
  firstSeenMs?: number;
  eventCount: number;
  domainKnown: boolean;
}

async function gatherFacts(trackId: number, deps: DraftReportDeps): Promise<Facts> {
  const { world } = deps;
  const track = await world.getTrack(trackId);
  const campaign = track?.campaign_id ? await world.getCampaign(track.campaign_id) : undefined;
  const events = track ? await world.recentEvents(track.id, 50) : [];
  const pred = track ? await world.getPrediction(trackId) : undefined;
  const known = campaign ? domainByHash(campaign.url_hash) : undefined;
  const age = campaign?.domain_age_days ?? -1;

  return {
    track_id: trackId,
    brand: campaign?.brand || events.find((e) => e.brand)?.brand || "toll",
    area: deps.areaName ?? process.env.DEMO_AREA_NAME ?? "Campbell Rd, Richardson",
    lat: track ? track.lat.toFixed(5) : "unknown",
    lon: track ? track.lon.toFixed(5) : "unknown",
    heading_deg: track ? track.heading_deg.toFixed(0) : "unknown",
    heading_name: track ? compass(track.heading_deg) : "unknown",
    speed_mph: track ? (track.speed_mps * 2.237).toFixed(0) : "unknown",
    intercept: pred ? `${pred.intercept_lat.toFixed(5)}, ${pred.intercept_lon.toFixed(5)}` : "not available",
    eta_s: pred ? pred.eta_s : "unknown",
    domain: known?.domain ?? "unknown",
    domain_age: age >= 0 ? `${age} days` : "unknown",
    first_seen: campaign ? new Date(campaign.first_seen_ms).toISOString() : "unknown",
    evidence: `SMS delivered during a 2G downgrade on ${events.length} handsets, flagged by a classifier, with no match in carrier logs.`,

    trackLat: track?.lat,
    trackLon: track?.lon,
    speedMps: track?.speed_mps,
    interceptLat: pred?.intercept_lat,
    interceptLon: pred?.intercept_lon,
    etaS: pred?.eta_s,
    campaignDomainAge: age,
    firstSeenMs: campaign?.first_seen_ms,
    eventCount: events.length,
    domainKnown: Boolean(known),
  };
}

// ---- fixed templates (also the fallback when generation fails its checks) ----

export function warningTemplate(brand: string, area: string): string {
  const t = `Scam alert near ${area}: fake ${brand} texts asking you to pay are circulating. Do not tap links. Pay only via the official app or site.`;
  return t.length <= 160 ? t : `Scam alert near you: fake ${brand} payment texts are circulating. Do not tap any links.`.slice(0, 160);
}

function policeTemplate(f: Facts): string {
  const predLine = f.interceptLat === undefined
    ? "No intercept yet."
    : `Intercept ${f.interceptLat.toFixed(4)}, ${f.interceptLon!.toFixed(4)} in ~${f.etaS} s.`;
  return [
    `SMS blaster suspect, track #${f.track_id}.`,
    f.trackLat !== undefined
      ? `Position ${f.trackLat.toFixed(4)}, ${f.trackLon!.toFixed(4)}, heading ${f.heading_name} at ${f.speedMps!.toFixed(0)} m/s.`
      : "Position unknown.",
    predLine,
    `Campaign: ${f.brand} lure${f.campaignDomainAge >= 0 ? `, domain ${f.campaignDomainAge} days old` : ""}.`,
    "Look for a vehicle with a powered antenna; do not engage the device.",
  ].join("\n");
}

function registrarTemplate(f: Facts): string {
  const domain = f.domainKnown ? String(f.domain) : "(domain unknown)";
  return [
    "To the Registrar Abuse Team:",
    `We report the domain ${domain}, first observed ${f.firstSeenMs !== undefined ? new Date(f.firstSeenMs).toISOString() : "recently"}, impersonating ${f.brand}.`,
    `The domain is distributed by SMS from a rogue base station that bypasses carrier networks; ${f.eventCount} affected handsets were observed.`,
    f.campaignDomainAge >= 0 ? `The domain was registered ${f.campaignDomainAge} days before first observation.` : "",
    "We request suspension of the domain under your abuse policy.",
  ]
    .filter(Boolean)
    .join("\n");
}

function template(kind: ReportKind, f: Facts): string {
  if (kind === "warning") return warningTemplate(f.brand, f.area);
  if (kind === "police") return policeTemplate(f);
  return registrarTemplate(f);
}

// ---- hard checks on generated text; each returns a problem string or null ----

export function checkPolice(text: string): string | null {
  const lines = text.split("\n").filter((l) => l.trim());
  if (lines.length === 0) return "empty";
  if (lines.length > POLICE_MAX_LINES) return `${lines.length} lines (max ${POLICE_MAX_LINES})`;
  return null;
}

export function checkRegistrar(text: string, f: Pick<Facts, "domain" | "brand" | "domainKnown">): string | null {
  const t = text.toLowerCase();
  if (!t.trim()) return "empty";
  if (f.domainKnown && !t.includes(String(f.domain).toLowerCase())) return "domain missing";
  if (f.brand && f.brand !== "toll" && !t.includes(f.brand.toLowerCase())) return "brand missing";
  return null;
}

function check(kind: ReportKind, text: string, f: Facts): string | null {
  if (kind === "warning") return validateWarning(text);
  if (kind === "police") return checkPolice(text);
  return checkRegistrar(text, f);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`draft_report generation timed out after ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

const clean = (s: string) => s.trim().replace(/^["'“]+|["'”]+$/g, "").trim();

export async function draftReport(
  input: { track_id: number; kind: ReportKind },
  deps: DraftReportDeps,
): Promise<{ text: string }> {
  const kinds: ReportKind[] = ["police", "registrar", "warning"];
  if (!kinds.includes(input.kind)) throw new Error(`draft_report: kind must be one of ${kinds.join(", ")}`);

  const facts = await gatherFacts(input.track_id, deps);
  const fixed = template(input.kind, facts);
  if (!deps.llm) return { text: fixed };

  try {
    const prompt = renderPrompt(input.kind, facts);
    const res = await withTimeout(
      deps.llm.chat([{ role: "user", content: prompt }], []),
      deps.timeoutMs ?? Number(process.env.DRAFT_TIMEOUT_MS ?? DEFAULT_DRAFT_TIMEOUT_MS),
    );
    const text = clean(res.content ?? "");
    const problem = check(input.kind, text, facts);
    if (problem) {
      deps.log?.({ tool: "draft_report", kind: input.kind, fallback: true, reason: problem });
      return { text: fixed };
    }
    return { text };
  } catch (e) {
    deps.log?.({ tool: "draft_report", kind: input.kind, fallback: true, reason: String((e as Error).message) });
    return { text: fixed };
  }
}

let defaultModel: ChatModel | null | undefined;
/** Same Nemotron endpoint as the agent. Undefined under NEMOTRON_PROVIDER=mock (templates only). */
function getDefaultModel(): ChatModel | undefined {
  if (defaultModel === undefined) {
    defaultModel = llmConfig().provider === "mock" ? null : createModel();
  }
  return defaultModel ?? undefined;
}

export const draftReportTool: ToolDef<{ track_id: number; kind: ReportKind }, { text: string }> = {
  name: "draft_report",
  description:
    "Write text for a response action. kind='warning' is the public SMS warning (≤160 chars, no links); 'police' is the intercept brief; 'registrar' is the domain abuse report.",
  parameters: {
    type: "object",
    properties: {
      track_id: { type: "integer" },
      kind: { type: "string", enum: ["police", "registrar", "warning"] },
    },
    required: ["track_id", "kind"],
  },
  async run(input, ctx) {
    const out = await draftReport(
      { track_id: ctx.trackId, kind: input.kind },
      { world: ctx.world, llm: getDefaultModel(), log: ctx.log },
    );
    ctx.memory.lastDraft = { kind: input.kind, text: out.text };
    return out;
  },
  summarize(out, input) {
    const first = out.text.split("\n")[0];
    return input.kind === "warning" ? `Drafted warning: "${first}"` : `Drafted ${input.kind} report: ${first}`;
  },
};
