import { predictRoute, TRAIL_WINDOW_MS, type TrailPoint } from "../tools/predict_route/index.js";
import { Investigator, type Mode, type RunResult } from "./agent.js";
import { PlaybookInvestigator } from "./playbook.js";
import { bearingDeg, compass, haversineM, headingDelta } from "./geo.js";
import type { ChatModel } from "./llm/types.js";
import { writeTrace } from "./trace.js";
import type { LatLon, Track } from "./types.js";
import type { World } from "./world/World.js";

export const TURN_THRESHOLD_DEG = 45;
/**
 * How often the predicted route (and so the warning zone drawn from it) is refreshed. Every 20 s, through
 * the model, the zone lagged the car and a turn was not followed until the replan. Refreshes are now plain
 * computation (predict_route + agent_set_prediction, no model call), so they can be this frequent.
 */
export const STALE_PREDICTION_MS = 4_000;

/**
 * A refresh whose intercept lands more than this far from the one already published is held back once: a single
 * odd fix can send the predicted path down the wrong road for one refresh, and a real turn looks the same for that
 * one refresh. If the next refresh agrees with the held one (within HOLD_CONFIRM_M) it is published, so a real
 * turn shows up one refresh (4 s) late; if it goes back to the old path, the odd one is dropped.
 */
export const HOLD_JUMP_M = 1_000;
export const HOLD_CONFIRM_M = 600;

/**
 * True if a refresh landing at `next` should wait for confirmation (see HOLD_JUMP_M). A refresh made while the
 * track's heading has swung more than HOLD_EXEMPT_TURN_DEG from the route's is a turn the service already knows
 * about, so it is never held; the odd jumps this guards against happen at a steady heading.
 */
export const HOLD_EXEMPT_TURN_DEG = 45;
export function shouldHoldRefresh(published: LatLon | undefined, held: LatLon | undefined, next: LatLon, headingChangeDeg = 0): boolean {
  if (headingChangeDeg > HOLD_EXEMPT_TURN_DEG) return false;
  if (!published || haversineM(published, next) <= HOLD_JUMP_M) return false;
  return !(held && haversineM(held, next) <= HOLD_CONFIRM_M);
}
/** Below this speed, heading is noise (parked / stop-and-go) and never triggers a replan. */
export const MIN_TURN_SPEED_MPS = 2;
const RETRY_AFTER_ERROR_MS = 10_000;
/**
 * Replan once the heading has settled (stayed within 10° over the last 9 s, i.e. three recluster
 * updates) or 25 s after the turn was first seen. recluster fits heading over a 90 s window, so a
 * real 90° turn swings the track's heading over ~20–30 s; firing on the first quiet poll would
 * re-predict mid-swing.
 */
export const TURN_SETTLE_DEG = 10;
export const TURN_SETTLE_WINDOW_MS = 9_000;
export const TURN_SETTLE_MAX_MS = 25_000;

/**
 * The first investigation (and so the first warning) waits until the track's direction can be
 * trusted. A brand-new track reports little or no speed and a noisy heading (seen live: heading
 * northwest for a car driving east, speed 0), so a prediction made at once points at nobody and
 * the first warning reaches 0 phones. Direction counts as trustworthy when the track is moving
 * and its reported heading agrees with where its position has actually gone over the last few
 * seconds. After FIRST_WARNING_MAX_WAIT_MS the investigation goes ahead anyway.
 */
export const DIRECTION_WINDOW_MS = 8_000;
export const MIN_DISPLACEMENT_M = 40;
export const DIRECTION_TOLERANCE_DEG = 45;
export const FIRST_WARNING_MAX_WAIT_MS = 25_000;

interface TrackState {
  lastStatus: string;
  /** An investigation has completed (or been attempted) since the track last became active. */
  investigated: boolean;
  running: Promise<RunResult> | null;
  predictionMs?: number;
  predictionHeading?: number;
  predictionSpeed?: number;
  retryAfterMs?: number;
  /** Recent headings (last TURN_SETTLE_WINDOW_MS) for the settle check. */
  headings: { ms: number; deg: number }[];
  turnSeenMs?: number;
  /** Recent positions (last DIRECTION_WINDOW_MS), to compare heading with actual movement. */
  positions: { ms: number; lat: number; lon: number }[];
  /** When this track was first seen active (reset when it goes dormant). */
  activeSinceMs?: number;
  /** Track positions over the last TRAIL_WINDOW_MS of the track's own clock (updated_ms), for predict_route. */
  trail: TrailPoint[];
  /** Intercept of the last route a refresh published, and one that jumped away from it and awaits confirmation. */
  publishedIntercept?: LatLon;
  heldIntercept?: LatLon;
  /** Speed the last refresh predicted at, handed back to predict_route so the speed changes smoothly. */
  lastSpeed?: number;
}

/**
 * The heading to aim a refresh at. The reported heading is used unless it contradicts where the track has
 * actually gone over the last few seconds (or the track is too slow for a heading to mean anything), in
 * which case we trust the movement. That lets the route follow a turn before the heading has settled.
 */
export function refreshHeading(
  track: Pick<Track, "speed_mps" | "heading_deg" | "lat" | "lon">,
  positions: readonly { ms: number; lat: number; lon: number }[],
  now: number,
  lastHeading?: number,
): number {
  const first = positions[0];
  if (first && now - first.ms >= DIRECTION_WINDOW_MS - 1_000) {
    const from: [number, number] = [first.lat, first.lon];
    const to: [number, number] = [track.lat, track.lon];
    if (haversineM(from, to) >= MIN_DISPLACEMENT_M) {
      const went = bearingDeg(from, to);
      if (track.speed_mps < MIN_TURN_SPEED_MPS || headingDelta(track.heading_deg, went) > DIRECTION_TOLERANCE_DEG) return went;
    }
  }
  if (track.speed_mps < MIN_TURN_SPEED_MPS && lastHeading !== undefined) return lastHeading;
  return track.heading_deg;
}

/** True when the track is moving and its heading agrees with where it has actually gone. */
export function directionReliable(
  track: Pick<Track, "speed_mps" | "heading_deg" | "lat" | "lon">,
  positions: readonly { ms: number; lat: number; lon: number }[],
  now: number,
): boolean {
  if (track.speed_mps < MIN_TURN_SPEED_MPS) return false;
  const first = positions[0];
  if (!first || now - first.ms < DIRECTION_WINDOW_MS - 1_000) return false; // need about a full window of history
  const from: [number, number] = [first.lat, first.lon];
  const to: [number, number] = [track.lat, track.lon];
  if (haversineM(from, to) < MIN_DISPLACEMENT_M) return false;
  return headingDelta(track.heading_deg, bearingDeg(from, to)) <= DIRECTION_TOLERANCE_DEG;
}

/**
 * "playbook" (default): code runs the investigation steps (independent ones in parallel) and the model is
 * called once, to write the warning text. "llm": the model chooses tools turn by turn (slower: ~11 model
 * round trips per investigation). Set with AGENT_MODE.
 */
export type AgentMode = "playbook" | "llm";
export const agentModeFromEnv = (env = process.env): AgentMode => (env.AGENT_MODE === "llm" ? "llm" : "playbook");

interface Runner {
  run(track: Track, mode: Mode, note?: string, opts?: { trail?: TrailPoint[] }): Promise<RunResult>;
  flushTraces?(): Promise<void>;
}

export interface ServiceOptions {
  agentMode?: AgentMode;
  now?: () => number;
  log?: (entry: Record<string, unknown>) => void;
  maxSteps?: number;
  onRun?: (r: RunResult) => void;
}

/**
 * Long-lived service that watches the `track` table:
 *   active & not investigating      → investigate
 *   turned > 45° or prediction > 20 s → replan / refresh
 *   became dormant                  → summary line
 */
export class AgentService {
  private state = new Map<number, TrackState>();
  private investigator: Runner;
  private now: () => number;
  private log?: (entry: Record<string, unknown>) => void;
  private onRun?: (r: RunResult) => void;
  private timer?: NodeJS.Timeout;
  private ticking = false;

  constructor(private world: World, model: ChatModel, opts: ServiceOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log;
    this.onRun = opts.onRun;
    this.investigator =
      (opts.agentMode ?? agentModeFromEnv()) === "llm"
        ? new Investigator(world, model, { now: this.now, log: this.log, maxSteps: opts.maxSteps })
        : new PlaybookInvestigator(world, { now: this.now, log: this.log });
  }

  start(pollMs = 1000): void {
    const loop = async () => {
      if (this.ticking) return;
      this.ticking = true;
      try {
        await this.tick();
      } catch (e) {
        this.log?.({ event: "tick_error", error: String(e) });
      } finally {
        this.ticking = false;
      }
    };
    void loop();
    this.timer = setInterval(loop, pollMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Wait for every running investigation (used by evals and tests). */
  async idle(): Promise<void> {
    await Promise.all([...this.state.values()].map((s) => s.running).filter(Boolean));
    await this.investigator.flushTraces?.();
  }

  async tick(): Promise<void> {
    const tracks = await this.world.listTracks();
    for (const t of tracks) await this.onTrack(t);
  }

  private async onTrack(track: Track): Promise<void> {
    let st = this.state.get(track.id);
    if (!st) {
      st = { lastStatus: "", investigated: false, running: null, headings: [], positions: [], trail: [] };
      this.state.set(track.id, st);
    }
    const prevStatus = st.lastStatus;
    st.lastStatus = track.status;
    const tickMs = this.now();
    st.headings.push({ ms: tickMs, deg: track.heading_deg });
    st.headings = st.headings.filter((h) => tickMs - h.ms <= TURN_SETTLE_WINDOW_MS);
    st.positions.push({ ms: tickMs, lat: track.lat, lon: track.lon });
    st.positions = st.positions.filter((p) => tickMs - p.ms <= DIRECTION_WINDOW_MS);
    // The trail is keyed on the track's own clock, so it is right at any sim speed; one point per update.
    const trackMs = Number(track.updated_ms);
    if (Number.isFinite(trackMs) && trackMs !== st.trail[st.trail.length - 1]?.ms) {
      st.trail.push({ lat: track.lat, lon: track.lon, ms: trackMs });
      st.trail = st.trail.filter((p) => trackMs - p.ms <= TRAIL_WINDOW_MS);
    }

    if (track.status === "dormant") {
      if (prevStatus !== "dormant" && prevStatus !== "") {
        await writeTrace(this.world, track.id, "summary", `Track #${track.id} dormant, watching for campaign reappearance`);
      }
      st.investigated = false; // reactivation (same url_hash) gets a fresh investigation
      st.predictionMs = undefined;
      st.activeSinceMs = undefined;
      st.trail = []; // a blaster back on air may be somewhere else entirely
      return;
    }
    if (track.status !== "active" || st.running) return;
    const now = this.now();
    if (st.retryAfterMs && now < st.retryAfterMs) return;

    if (!st.investigated) {
      st.activeSinceMs ??= now;
      // Hold the first warning until we know which way the blaster is really going.
      if (!directionReliable(track, st.positions, now) && now - st.activeSinceMs < FIRST_WARNING_MAX_WAIT_MS) return;
      const note = prevStatus === "dormant" ? `Track #${track.id} reappeared after going dormant; re-checking campaign` : undefined;
      this.launch(track, st, "investigate", note);
      return;
    }

    const moving = track.speed_mps >= MIN_TURN_SPEED_MPS;
    // A prediction made while the track had no speed has no real direction: once it moves,
    // refresh it rather than calling the first real heading a "turn".
    if (moving && st.predictionSpeed !== undefined && st.predictionSpeed < MIN_TURN_SPEED_MPS) {
      st.turnSeenMs = undefined;
      await this.refreshDirect(track, st, now, true);
      return;
    }
    const turned =
      st.predictionHeading !== undefined &&
      moving &&
      headingDelta(track.heading_deg, st.predictionHeading) > TURN_THRESHOLD_DEG;
    if (turned) {
      st.turnSeenMs ??= now;
      const windowFull = st.headings.length > 0 && now - st.headings[0]!.ms >= TURN_SETTLE_WINDOW_MS - 1_000;
      const steady = st.headings.every((h) => headingDelta(track.heading_deg, h.deg) <= TURN_SETTLE_DEG);
      // Also demand the heading agrees with where the track really went: at low speed the reported
      // heading is noise (seen live: "turned 55 degrees, now heading northwest" mid-way up Coit Rd).
      const settled = (windowFull && steady && directionReliable(track, st.positions, now)) || now - st.turnSeenMs >= TURN_SETTLE_MAX_MS;
      if (!settled) {
        // Still mid-turn: don't warn along a diagonal, but keep the route (and zone) following the movement.
        await this.refreshIfDue(track, st, now);
        return;
      }
      st.turnSeenMs = undefined;
      const d = Math.round(headingDelta(track.heading_deg, st.predictionHeading!));
      this.launch(track, st, "replan", `Track #${track.id} turned ${d}°, now heading ${compass(track.heading_deg)}; re-predicting route and re-warning`);
      return;
    }
    st.turnSeenMs = undefined;
    await this.refreshIfDue(track, st, now);
  }

  private async refreshIfDue(track: Track, st: TrackState, now: number): Promise<void> {
    if (st.predictionMs === undefined || now - st.predictionMs >= STALE_PREDICTION_MS) {
      await this.refreshDirect(track, st, now);
    }
  }

  /**
   * Keep the published route current: predict from the track's latest position and publish it. No model
   * call and no log lines. `predictionHeading` / `predictionSpeed` stay the values the last full
   * investigation or replan warned along, so a real turn is still noticed against them. They are only
   * re-based when `rebaseline` is set (the first prediction was made before the track had a direction).
   */
  private async refreshDirect(track: Track, st: TrackState, now: number, rebaseline = false): Promise<void> {
    const heading = refreshHeading(track, st.positions, now, st.predictionHeading);
    try {
      const out = await predictRoute({
        lat: track.lat, lon: track.lon, heading_deg: heading, speed_mps: track.speed_mps, horizon_s: 300, trail: st.trail,
        speed_hint: st.lastSpeed,
      });
      st.lastSpeed = out.speed_mps;
      const headingChange = st.predictionHeading === undefined ? 0 : headingDelta(heading, st.predictionHeading);
      if (shouldHoldRefresh(st.publishedIntercept, st.heldIntercept, out.intercept, headingChange)) {
        st.heldIntercept = out.intercept; // wait for the next refresh to agree before swinging the map
        st.predictionMs = now;
        return;
      }
      st.heldIntercept = undefined;
      st.publishedIntercept = out.intercept;
      await this.world.agentSetPrediction({
        track_id: track.id,
        path_json: JSON.stringify(out.path),
        intercept_lat: out.intercept[0],
        intercept_lon: out.intercept[1],
        eta_s: out.eta_s,
        updated_ms: this.now(),
      });
      st.predictionMs = now;
      if (rebaseline) {
        st.predictionHeading = heading;
        st.predictionSpeed = track.speed_mps;
      }
    } catch (e) {
      this.log?.({ event: "refresh_error", track: track.id, error: String(e) });
      st.predictionMs = now - STALE_PREDICTION_MS + RETRY_AFTER_ERROR_MS; // back off before retrying
    }
  }

  private launch(track: Track, st: TrackState, mode: Mode, note?: string): void {
    this.log?.({ event: "launch", track: track.id, mode });
    st.running = this.investigator
      .run(track, mode, note, { trail: [...st.trail] })
      .then((r) => {
        if (mode === "investigate") st.investigated = true;
        if (r.predictionAtMs !== undefined) {
          // A full investigation or replan published its own route: compare later refreshes against that.
          st.publishedIntercept = undefined;
          st.heldIntercept = undefined;
          st.predictionMs = r.predictionAtMs;
          st.predictionHeading = r.predictionHeading;
          st.predictionSpeed = r.predictionSpeed;
        } else if (st.predictionMs === undefined) {
          // Never got a prediction: back off before the stale-refresh retries.
          st.predictionMs = this.now() - STALE_PREDICTION_MS + RETRY_AFTER_ERROR_MS;
        }
        if (r.aborted === "model_error") {
          st.retryAfterMs = this.now() + RETRY_AFTER_ERROR_MS;
          if (mode === "investigate") st.investigated = false;
        }
        this.onRun?.(r);
        return r;
      })
      .catch((e) => {
        this.log?.({ event: "run_error", track: track.id, error: String(e) });
        st.retryAfterMs = this.now() + RETRY_AFTER_ERROR_MS;
        return { trackId: track.id, mode, toolsCalled: [], steps: 0, finalText: null, claimedAuthority: false, errors: [String(e)] } as RunResult;
      })
      .finally(() => {
        st.running = null;
      });
  }
}
