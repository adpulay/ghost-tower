import type { World } from "../src/world/World.js";
import type { LatLon } from "../src/types.js";

export interface PredictRouteOutput {
  path: LatLon[];
  intercept: LatLon;
  eta_s: number;
  /** Whether the path follows roads (OSRM) or is the straight-line fallback. */
  source?: "osrm" | "straight_line";
  /** Where the start/direction/speed came from: the track row, its recent trail, or the trail snapped to roads. */
  basis?: "track" | "trail" | "snapped";
  /** Road the trail snapped to, when known. */
  road?: string;
}

/** Per-investigation scratch memory so the model doesn't have to copy big arrays between tools. */
export interface InvestigationMemory {
  lastPrediction?: PredictRouteOutput;
  lastZone?: LatLon[];
  lastWarning?: { message: string; sent: number; zone: LatLon[] };
  lastDraft?: { kind: string; text: string };
  /** carrier_smsc_lookup answer for this run: "yes" | "no" | "unknown". */
  smsc?: string;
}

export interface ToolContext {
  world: World;
  /** The track under investigation. Write-tools are pinned to it. */
  trackId: number;
  now: () => number;
  memory: InvestigationMemory;
  /** Recent positions of the track (agent service), used by predict_route. */
  trail?: import("./predict_route/index.js").TrailPoint[];
  log?: (entry: Record<string, unknown>) => void;
}

export interface JsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
}

export interface ToolDef<I = any, O = any> {
  name: string;
  description: string;
  parameters: JsonSchema;
  /** True when the tool's data is mocked; the trace line is tagged "[simulated]". */
  simulated?: boolean;
  run(input: I, ctx: ToolContext): Promise<O>;
  /** One sentence for agent_trace (≤140 chars after truncation). */
  summarize(output: O, input: I): string;
}
