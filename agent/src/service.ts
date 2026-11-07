import { Investigator, type Mode, type RunResult } from "./agent.js";
import { compass, headingDelta } from "./geo.js";
import type { ChatModel } from "./llm/types.js";
import { writeTrace } from "./trace.js";
import type { Track } from "./types.js";
import type { World } from "./world/World.js";

export const TURN_THRESHOLD_DEG = 45;
export const STALE_PREDICTION_MS = 20_000;
/** Below this speed, heading is noise (parked / stop-and-go) and never triggers a replan. */
export const MIN_TURN_SPEED_MPS = 2;
const RETRY_AFTER_ERROR_MS = 10_000;
/** Replan once the heading has settled (≤10° change per tick) or 8 s after the turn was first seen. */
export const TURN_SETTLE_DEG = 10;
export const TURN_SETTLE_MAX_MS = 8_000;

interface TrackState {
  lastStatus: string;
  /** An investigation has completed (or been attempted) since the track last became active. */
  investigated: boolean;
  running: Promise<RunResult> | null;
  predictionMs?: number;
  predictionHeading?: number;
  retryAfterMs?: number;
  lastHeading?: number;
  turnSeenMs?: number;
}

export interface ServiceOptions {
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
  private investigator: Investigator;
  private now: () => number;
  private log?: (entry: Record<string, unknown>) => void;
  private onRun?: (r: RunResult) => void;
  private timer?: NodeJS.Timeout;
  private ticking = false;

  constructor(private world: World, model: ChatModel, opts: ServiceOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log;
    this.onRun = opts.onRun;
    this.investigator = new Investigator(world, model, { now: this.now, log: this.log, maxSteps: opts.maxSteps });
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
  }

  async tick(): Promise<void> {
    const tracks = await this.world.listTracks();
    for (const t of tracks) await this.onTrack(t);
  }

  private async onTrack(track: Track): Promise<void> {
    let st = this.state.get(track.id);
    if (!st) {
      st = { lastStatus: "", investigated: false, running: null };
      this.state.set(track.id, st);
    }
    const prevStatus = st.lastStatus;
    st.lastStatus = track.status;
    const prevHeading = st.lastHeading;
    st.lastHeading = track.heading_deg;

    if (track.status === "dormant") {
      if (prevStatus !== "dormant" && prevStatus !== "") {
        await writeTrace(this.world, track.id, "summary", `Track #${track.id} dormant, watching for campaign reappearance`);
      }
      st.investigated = false; // reactivation (same url_hash) gets a fresh investigation
      st.predictionMs = undefined;
      return;
    }
    if (track.status !== "active" || st.running) return;
    const now = this.now();
    if (st.retryAfterMs && now < st.retryAfterMs) return;

    if (!st.investigated) {
      const note = prevStatus === "dormant" ? `Track #${track.id} reappeared after going dormant; re-checking campaign` : undefined;
      this.launch(track, st, "investigate", note);
      return;
    }

    const turned =
      st.predictionHeading !== undefined &&
      track.speed_mps >= MIN_TURN_SPEED_MPS &&
      headingDelta(track.heading_deg, st.predictionHeading) > TURN_THRESHOLD_DEG;
    if (turned) {
      st.turnSeenMs ??= now;
      const settled =
        (prevHeading !== undefined && headingDelta(track.heading_deg, prevHeading) <= TURN_SETTLE_DEG) ||
        now - st.turnSeenMs >= TURN_SETTLE_MAX_MS;
      if (!settled) return; // still mid-turn; don't predict along a diagonal
      st.turnSeenMs = undefined;
      const d = Math.round(headingDelta(track.heading_deg, st.predictionHeading!));
      this.launch(track, st, "replan", `Track #${track.id} turned ${d}°, now heading ${compass(track.heading_deg)}; re-predicting route and re-warning`);
      return;
    }
    st.turnSeenMs = undefined;
    if (st.predictionMs === undefined || now - st.predictionMs > STALE_PREDICTION_MS) {
      this.launch(track, st, "refresh");
    }
  }

  private launch(track: Track, st: TrackState, mode: Mode, note?: string): void {
    this.log?.({ event: "launch", track: track.id, mode });
    st.running = this.investigator
      .run(track, mode, note)
      .then((r) => {
        if (mode === "investigate") st.investigated = true;
        if (r.predictionAtMs !== undefined) {
          st.predictionMs = r.predictionAtMs;
          st.predictionHeading = r.predictionHeading;
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
