// Record every agent reducer call with its timing, and replay it later with the original
// timing. This is the fallback if Brev (and the hosted endpoint) die mid-demo:
//   npm run replay -- replay/demo-01.json [--track-id N] [--speed 1]

import { readFileSync, writeFileSync } from "node:fs";
import type { Alert, Prediction, TraceKind } from "./types.js";
import type { World } from "./world/World.js";

export type RecordedOp =
  | { t_ms: number; op: "agent_write_trace"; track_id: number; kind: TraceKind; text: string }
  | { t_ms: number; op: "agent_set_prediction"; prediction: Prediction }
  | { t_ms: number; op: "agent_link_campaign"; track_id: number; url_hash: string; brand: string; domain_age_days: number }
  | { t_ms: number; op: "agent_record_alert"; alert: Omit<Alert, "id"> };

export interface Recording {
  scenario: string;
  recorded_at: string;
  /** Which model produced it, e.g. "brev:nemotron" or "mock:policy". */
  model: string;
  /** Offsets are relative to the first op; absolute timestamps are rewritten on replay. */
  ops: RecordedOp[];
}

/** Wraps a World and records all agent writes (reads pass through). */
export class RecordingWorld implements World {
  ops: RecordedOp[] = [];
  private t0: number | null = null;
  constructor(private inner: World, private now: () => number = Date.now) {}

  private t(): number {
    const n = this.now();
    if (this.t0 === null) this.t0 = n;
    return n - this.t0;
  }

  // Evidence reports aren't part of a recorded replay: they pass straight through.
  agentSaveReport(trackId: number, kind: "police" | "registrar", text: string, generated: boolean) {
    return this.inner.agentSaveReport(trackId, kind, text, generated);
  }

  listTracks() {
    return this.inner.listTracks();
  }
  getTrack(id: number) {
    return this.inner.getTrack(id);
  }
  recentEvents(id: number, limit: number) {
    return this.inner.recentEvents(id, limit);
  }
  getCampaign(id: number) {
    return this.inner.getCampaign(id);
  }
  getPrediction(id: number) {
    return this.inner.getPrediction(id);
  }
  listTraces(id?: number) {
    return this.inner.listTraces(id);
  }

  async agentWriteTrace(track_id: number, kind: TraceKind, text: string) {
    this.ops.push({ t_ms: this.t(), op: "agent_write_trace", track_id, kind, text });
    return this.inner.agentWriteTrace(track_id, kind, text);
  }
  async agentSetPrediction(prediction: Prediction) {
    this.ops.push({ t_ms: this.t(), op: "agent_set_prediction", prediction: { ...prediction } });
    return this.inner.agentSetPrediction(prediction);
  }
  async agentLinkCampaign(track_id: number, url_hash: string, brand: string, domain_age_days: number) {
    this.ops.push({ t_ms: this.t(), op: "agent_link_campaign", track_id, url_hash, brand, domain_age_days });
    return this.inner.agentLinkCampaign(track_id, url_hash, brand, domain_age_days);
  }
  async agentRecordAlert(alert: Omit<Alert, "id">) {
    this.ops.push({ t_ms: this.t(), op: "agent_record_alert", alert: { ...alert } });
    return this.inner.agentRecordAlert(alert);
  }

  save(path: string, scenario: string, model: string): Recording {
    const rec: Recording = { scenario, recorded_at: new Date().toISOString(), model, ops: this.ops };
    writeFileSync(path, JSON.stringify(rec, null, 2) + "\n");
    return rec;
  }
}

export interface ReplayOptions {
  /** Rewrite every track_id to this one (track ids differ between runs). */
  trackId?: number;
  /** 2 = twice as fast. */
  speed?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export function loadRecording(path: string): Recording {
  return JSON.parse(readFileSync(path, "utf8")) as Recording;
}

export async function replay(rec: Recording, world: World, opts: ReplayOptions = {}): Promise<number> {
  const speed = opts.speed ?? 1;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const start = now();
  const tid = (id: number) => opts.trackId ?? id;
  for (const op of rec.ops) {
    const wait = start + op.t_ms / speed - now();
    if (wait > 0) await sleep(wait);
    const ts = now();
    switch (op.op) {
      case "agent_write_trace":
        await world.agentWriteTrace(tid(op.track_id), op.kind, op.text);
        break;
      case "agent_set_prediction":
        await world.agentSetPrediction({ ...op.prediction, track_id: tid(op.prediction.track_id), updated_ms: ts });
        break;
      case "agent_link_campaign":
        await world.agentLinkCampaign(tid(op.track_id), op.url_hash, op.brand, op.domain_age_days);
        break;
      case "agent_record_alert":
        await world.agentRecordAlert({ ...op.alert, track_id: tid(op.alert.track_id), sent_ms: ts });
        break;
    }
  }
  return rec.ops.length;
}
