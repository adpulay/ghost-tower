import type { TraceKind } from "./types.js";
import type { World } from "./world/World.js";

export const MAX_TRACE_CHARS = 140;
export const SIMULATED_TAG = "[simulated]";

/** One readable line, ≤140 chars (INTERFACES.md §2 agent_trace.text). */
export function clip(text: string, max = MAX_TRACE_CHARS): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1).trimEnd()}…`;
}

/** Keep the [simulated] tag even when the line has to be clipped. */
export function withSimulatedTag(text: string): string {
  const room = MAX_TRACE_CHARS - SIMULATED_TAG.length - 1;
  return `${clip(text, room)} ${SIMULATED_TAG}`;
}

export async function writeTrace(world: World, trackId: number, kind: TraceKind, text: string): Promise<void> {
  await world.agentWriteTrace(trackId, kind, text.endsWith(SIMULATED_TAG) ? text : clip(text));
}

/**
 * Detects the model claiming it set / changed / decided the track's confidence or status
 * (or the blaster verdict). Those belong to `recluster` only (INTERFACES.md §3).
 */
const AUTHORITY_PATTERNS = [
  /\b(set|setting|raised?|raising|lower(?:ed|ing)?|increas(?:e|ed|ing)|decreas(?:e|ed|ing)|updat(?:e|ed|ing)|chang(?:e|ed|ing)|mark(?:ed|ing)?|bump(?:ed)?|escalat(?:e|ed|ing))\b[^.]{0,40}\b(confidence|status)\b/i,
  /\b(confidence|status)\b[^.]{0,20}\b(to|=|now)\s+("?active"?|"?dormant"?|"?closed"?|"?candidate"?|0?\.\d+|\d+%)/i,
  /\b(i|we)\s+(have\s+)?(confirm(?:ed)?|determin(?:e|ed)|conclud(?:e|ed)|decid(?:e|ed))\b[^.]{0,40}\b(is|as)\s+an?\s+(sms\s+)?blaster\b/i,
];

export function claimsAuthority(text: string | null | undefined): boolean {
  if (!text) return false;
  return AUTHORITY_PATTERNS.some((re) => re.test(text));
}
