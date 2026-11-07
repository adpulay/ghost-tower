// The agent reducers from INTERFACES.md §3 exposed as model tools. track_id is always pinned
// to the track under investigation, so the model cannot write to another track. There is no
// tool that can touch track.confidence or track.status.

import { isLatLonArray } from "../src/geo.js";
import type { ToolDef } from "./types.js";

export const agentLinkCampaignTool: ToolDef<{ url_hash: string; brand: string; domain_age_days: number }, { ok: true; url_hash: string }> = {
  name: "agent_link_campaign",
  description: "Group this track into a phishing campaign by its link hash (creates the campaign if new).",
  parameters: {
    type: "object",
    properties: {
      url_hash: { type: "string" },
      brand: { type: "string" },
      domain_age_days: { type: "integer", description: "From rdap_domain_age; -1 if unknown" },
    },
    required: ["url_hash", "brand", "domain_age_days"],
  },
  async run(input, ctx) {
    if (!input.url_hash) throw new Error("url_hash is required");
    const age = Number.isFinite(Number(input.domain_age_days)) ? Math.trunc(Number(input.domain_age_days)) : -1;
    await ctx.world.agentLinkCampaign(ctx.trackId, input.url_hash, input.brand ?? "", age);
    return { ok: true, url_hash: input.url_hash };
  },
  summarize(_o, input) {
    return `Linked track to the ${input.brand || "unbranded"} campaign (link ${input.url_hash.slice(0, 8)}…).`;
  },
};

export const agentSetPredictionTool: ToolDef<
  { path_json?: string; intercept_lat?: number; intercept_lon?: number; eta_s?: number },
  { ok: true; eta_s: number }
> = {
  name: "agent_set_prediction",
  description: "Publish the predicted route to the map. Omit all fields to publish the latest predict_route result.",
  parameters: {
    type: "object",
    properties: {
      path_json: { type: "string", description: "JSON [[lat,lon],...]" },
      intercept_lat: { type: "number" },
      intercept_lon: { type: "number" },
      eta_s: { type: "integer" },
    },
  },
  async run(input, ctx) {
    const last = ctx.memory.lastPrediction;
    let path = last?.path;
    if (input.path_json) {
      try {
        const parsed = JSON.parse(input.path_json);
        if (isLatLonArray(parsed) || (Array.isArray(parsed) && parsed.length > 0)) path = parsed;
      } catch {
        /* fall back to memory */
      }
    }
    if (!path) throw new Error("no route to publish; call predict_route first");
    const ilat = input.intercept_lat ?? last?.intercept[0];
    const ilon = input.intercept_lon ?? last?.intercept[1];
    const eta = Math.max(0, Math.trunc(input.eta_s ?? last?.eta_s ?? 0));
    if (ilat === undefined || ilon === undefined) throw new Error("no intercept point; call predict_route first");
    await ctx.world.agentSetPrediction({
      track_id: ctx.trackId,
      path_json: JSON.stringify(path),
      intercept_lat: ilat,
      intercept_lon: ilon,
      eta_s: eta,
      updated_ms: ctx.now(),
    });
    return { ok: true, eta_s: eta };
  },
  summarize(o) {
    return `Published predicted route and intercept point to the map (ETA ${o.eta_s} s).`;
  },
};

export const agentRecordAlertTool: ToolDef<{ zone_json?: string; message?: string; recipients?: number }, { ok: true; recipients: number }> = {
  name: "agent_record_alert",
  description: "Record the warning that was sent so it shows on the map. Omit fields to record the latest send_warning.",
  parameters: {
    type: "object",
    properties: {
      zone_json: { type: "string" },
      message: { type: "string" },
      recipients: { type: "integer" },
    },
  },
  async run(input, ctx) {
    const w = ctx.memory.lastWarning;
    const zone_json = input.zone_json || (w ? JSON.stringify(w.zone) : "");
    const message = input.message || w?.message || "";
    const recipients = Math.max(0, Math.trunc(input.recipients ?? w?.sent ?? 0));
    if (!zone_json || !message) throw new Error("nothing to record; call send_warning first");
    await ctx.world.agentRecordAlert({ track_id: ctx.trackId, zone_json, message, sent_ms: ctx.now(), recipients });
    return { ok: true, recipients };
  },
  summarize(o) {
    return `Recorded alert for ${o.recipients} recipients on the map.`;
  },
};
