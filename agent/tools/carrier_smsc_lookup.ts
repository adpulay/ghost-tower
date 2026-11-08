import { domainByHash } from "../src/knownDomains.js";
import type { SmscMatch } from "../src/types.js";
import type { ToolDef } from "./types.js";

export interface SmscOutput {
  match: SmscMatch;
}

/**
 * INTERFACES.md §7 carrier_smsc_lookup — MOCK. A real version would ask the carrier whether
 * the SMS passed through its SMSC. Blaster texts never touch the carrier network, so:
 *   campaign (demo scam) hash → "no"; benign toll-text hash → "yes"; anything else → "unknown".
 */
export function carrierSmscLookup(input: { url_hash: string; ts_ms: number }): SmscOutput {
  const known = domainByHash(input.url_hash ?? "");
  if (!known) return { match: "unknown" };
  return { match: known.kind === "demo-scam" ? "no" : "yes" };
}

export const carrierSmscLookupTool: ToolDef<{ url_hash: string; ts_ms: number }, SmscOutput> = {
  name: "carrier_smsc_lookup",
  description:
    "Ask the carrier whether texts with this link hash passed through its SMS center (SMSC). 'no' means the text bypassed the carrier network. (Simulated.)",
  simulated: true,
  parameters: {
    type: "object",
    properties: {
      url_hash: { type: "string", description: "SHA-256 url_hash from the events" },
      ts_ms: { type: "integer", description: "Event time, Unix ms" },
    },
    required: ["url_hash", "ts_ms"],
  },
  run: async (input, ctx) => {
    const out = await carrierSmscLookup(input);
    ctx.memory.smsc = out.match;
    return out;
  },
  summarize(out) {
    if (out.match === "no") return "Carrier SMSC check: no match, so these texts never went through the carrier network.";
    if (out.match === "yes") return "Carrier SMSC check: match, so these texts came through the normal carrier network.";
    return "Carrier SMSC check: no record either way for this link.";
  },
};
