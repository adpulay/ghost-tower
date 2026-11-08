import type { Campaign, Track } from "./types.ts";

/**
 * The track the screens should follow. The real blaster is the active track; with live data,
 * benign noise keeps creating short-lived low-confidence candidates, so "the newest track" is
 * almost never the right one.
 *
 * Order: active before candidate (dormant/closed only if nothing else), then highest
 * confidence, then most recently updated, then lowest id.
 */
export function focusTrack(tracks: readonly Track[]): Track | undefined {
  const rank = (s: string) => (s === "active" ? 0 : s === "candidate" ? 1 : s === "dormant" ? 2 : 3);
  return [...tracks].sort(
    (a, b) =>
      rank(a.status) - rank(b.status) ||
      b.confidence - a.confidence ||
      b.updated_ms - a.updated_ms ||
      a.id - b.id,
  )[0];
}

/** The campaign linked to the focused track, if the agent has linked one. */
export function focusCampaign(track: Track | undefined, campaigns: readonly Campaign[]): Campaign | undefined {
  if (!track || !track.campaign_id) return undefined;
  return campaigns.find((c) => c.id === track.campaign_id);
}
