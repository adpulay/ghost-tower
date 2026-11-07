import { compass } from "../src/geo.js";
import type { AnomalyEvent, Track } from "../src/types.js";
import type { ToolDef } from "./types.js";

export interface TrackContext {
  track: Track | null;
  events: AnomalyEvent[];
}

/** INTERFACES.md §7: track row + last 50 events, read from Spacetime. */
export async function getTrackContext(input: { track_id: number }, ctx: { world: import("../src/world/World.js").World }): Promise<TrackContext> {
  const track = (await ctx.world.getTrack(input.track_id)) ?? null;
  const events = track ? await ctx.world.recentEvents(input.track_id, 50) : [];
  return { track, events };
}

export const getTrackContextTool: ToolDef<{ track_id: number }, TrackContext> = {
  name: "get_track_context",
  description: "Read the track row and its last 50 anomaly events from Spacetime.",
  parameters: {
    type: "object",
    properties: { track_id: { type: "integer", description: "Track id" } },
    required: ["track_id"],
  },
  run: (input, ctx) => getTrackContext({ track_id: input.track_id ?? ctx.trackId }, ctx),
  summarize(out) {
    if (!out.track) return "Track not found in Spacetime.";
    const t = out.track;
    const brands = topBrand(out.events);
    return `Track #${t.id}: ${out.events.length} events, heading ${compass(t.heading_deg)} at ${t.speed_mps.toFixed(0)} m/s${brands ? `, lure brand ${brands}` : ""}.`;
  },
};

function topBrand(events: AnomalyEvent[]): string {
  const counts = new Map<string, number>();
  for (const e of events) if (e.brand) counts.set(e.brand, (counts.get(e.brand) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
}
