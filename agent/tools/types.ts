import type { World } from "../src/world/World.js";
import type { LatLon } from "../src/types.js";

export interface PredictRouteOutput {
  path: LatLon[];
  intercept: LatLon;
  eta_s: number;
  /** Whether the path follows roads (OSRM) or is the straight-line fallback. */
  source?: "osrm" | "straight_line";
}

/** Per-investigation scratch memory so the model doesn't have to copy big arrays between tools. */
export interface InvestigationMemory {
  lastPrediction?: PredictRouteOutput;
  lastZone?: LatLon[];
  lastWarning?: { message: string; sent: number; zone: LatLon[] };
  lastDraft?: { kind: string; text: string };
}

export interface ToolContext {
  world: World;
  /** The track under investigation. Write-tools are pinned to it. */
  trackId: number;
  now: () => number;
  memory: InvestigationMemory;
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
