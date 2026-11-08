// Numbers shown on the console. Pure, so they are unit-tested in Node.

/**
 * Phones warned so far, without counting a phone twice. The agent records several alerts per track (a duplicate per
 * warning, and one per re-plan) over mostly the same phones, and alerts carry a count rather than phone ids, so the
 * largest single warning per track is the honest figure. It can undercount; it can't inflate.
 */
export function phonesWarned(alerts: readonly { track_id: number; recipients: number }[]): number {
  const perTrack = new Map<number, number>();
  for (const a of alerts) perTrack.set(a.track_id, Math.max(perTrack.get(a.track_id) ?? 0, a.recipients));
  return [...perTrack.values()].reduce((sum, n) => sum + n, 0);
}

/**
 * The time to measure report ages against. A sped-up simulator stamps reports ahead of this browser's clock, so the
 * newest report is "now" whenever it is ahead of the wall clock.
 */
export function worldClock(events: readonly { ts_ms: number }[], wallNowMs: number): number {
  return events.reduce((latest, e) => Math.max(latest, e.ts_ms), wallNowMs);
}
