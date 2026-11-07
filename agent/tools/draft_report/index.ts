// OWNER: Role 3. This is Role 2's STUB until Role 3's LLM-backed draft_report lands.
// Contract (INTERFACES.md §7): draft_report(track_id, kind: "police"|"registrar"|"warning") -> { text }
// The stub uses fixed templates, which double as Role 3's required fallback when generation
// fails its hard checks (warning ≤160 chars, no URL).

import { compass } from "../../src/geo.js";
import { domainByHash } from "../../src/knownDomains.js";
import type { World } from "../../src/world/World.js";
import type { ToolDef } from "../types.js";

export type ReportKind = "police" | "registrar" | "warning";

export interface DraftReportDeps {
  world: World;
  areaName?: string;
}

export async function draftReport(input: { track_id: number; kind: ReportKind }, deps: DraftReportDeps): Promise<{ text: string }> {
  const track = await deps.world.getTrack(input.track_id);
  const campaign = track?.campaign_id ? await deps.world.getCampaign(track.campaign_id) : undefined;
  const events = track ? await deps.world.recentEvents(track.id, 50) : [];
  const brand = campaign?.brand || events.find((e) => e.brand)?.brand || "toll";
  const area = deps.areaName ?? process.env.DEMO_AREA_NAME ?? "Campbell Rd, Richardson";

  if (input.kind === "warning") {
    return { text: warningTemplate(brand, area) };
  }
  if (input.kind === "police") {
    const pred = await deps.world.getPrediction(input.track_id);
    const lines = [
      `SMS blaster suspect, track #${input.track_id}.`,
      track ? `Position ${track.lat.toFixed(4)}, ${track.lon.toFixed(4)}, heading ${compass(track.heading_deg)} at ${track.speed_mps.toFixed(0)} m/s.` : "Position unknown.",
      pred ? `Intercept ${pred.intercept_lat.toFixed(4)}, ${pred.intercept_lon.toFixed(4)} in ~${pred.eta_s} s.` : "No intercept yet.",
      `Campaign: ${brand} lure${campaign && campaign.domain_age_days >= 0 ? `, domain ${campaign.domain_age_days} days old` : ""}.`,
      "Look for a vehicle with a powered antenna; do not engage the device.",
    ];
    return { text: lines.join("\n") };
  }
  const domain = campaign ? domainByHash(campaign.url_hash)?.domain ?? "(domain unknown)" : "(domain unknown)";
  return {
    text: [
      "To the Registrar Abuse Team:",
      `We report the domain ${domain}, first observed ${campaign ? new Date(campaign.first_seen_ms).toISOString() : "recently"}, impersonating ${brand}.`,
      `The domain is distributed by SMS from a rogue base station that bypasses carrier networks; ${events.length} affected handsets were observed.`,
      campaign && campaign.domain_age_days >= 0 ? `The domain was registered ${campaign.domain_age_days} days before first observation.` : "",
      "We request suspension of the domain under your abuse policy.",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

export function warningTemplate(brand: string, area: string): string {
  const t = `Scam alert near ${area}: fake ${brand} texts asking you to pay are circulating. Do not tap links. Pay only via the official app or site.`;
  return t.length <= 160 ? t : `Scam alert near you: fake ${brand} payment texts are circulating. Do not tap any links.`.slice(0, 160);
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
    const out = await draftReport({ track_id: ctx.trackId, kind: input.kind }, { world: ctx.world });
    ctx.memory.lastDraft = { kind: input.kind, text: out.text };
    return out;
  },
  summarize(out, input) {
    const first = out.text.split("\n")[0];
    return input.kind === "warning" ? `Drafted warning: "${first}"` : `Drafted ${input.kind} report: ${first}`;
  },
};
