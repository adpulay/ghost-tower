// OWNER: Role 1. This is Role 2's STUB until Role 1's real predict_route lands.
// Contract (INTERFACES.md §7):
//   predict_route(lat, lon, heading_deg, speed_mps, horizon_s)
//     -> { path: [[lat,lon],...], intercept: [lat,lon], eta_s: int }
// The stub is straight-line projection along heading_deg (the same fallback Role 1's version
// uses when the routing API is rate-limited). Role 1: replace the body, keep the signature.

import { destination } from "../../src/geo.js";
import type { LatLon } from "../../src/types.js";
import type { PredictRouteOutput, ToolDef } from "../types.js";

export interface PredictRouteInput {
  lat: number;
  lon: number;
  heading_deg: number;
  speed_mps: number;
  horizon_s: number;
}

export async function predictRoute(input: PredictRouteInput): Promise<PredictRouteOutput> {
  const horizon = Math.max(30, Math.min(900, input.horizon_s || 300));
  const speed = Math.max(0, Math.min(40, input.speed_mps || 0));
  const stepS = 30;
  const path: LatLon[] = [[input.lat, input.lon]];
  for (let t = stepS; t <= horizon; t += stepS) {
    path.push(destination([input.lat, input.lon], input.heading_deg, speed * t));
  }
  // Suggested intercept: where the blaster will be in ~2 minutes (time for a patrol unit to get there).
  const eta_s = Math.min(120, horizon);
  const intercept = destination([input.lat, input.lon], input.heading_deg, speed * eta_s);
  return { path, intercept, eta_s };
}

export const predictRouteTool: ToolDef<PredictRouteInput, PredictRouteOutput> = {
  name: "predict_route",
  description: "Predict the blaster's path for the next horizon_s seconds and suggest an intercept point.",
  parameters: {
    type: "object",
    properties: {
      lat: { type: "number" },
      lon: { type: "number" },
      heading_deg: { type: "number", description: "0 = north, clockwise" },
      speed_mps: { type: "number" },
      horizon_s: { type: "integer", description: "Seconds ahead, normally 300" },
    },
    required: ["lat", "lon", "heading_deg", "speed_mps", "horizon_s"],
  },
  async run(input, ctx) {
    const out = await predictRoute(input);
    ctx.memory.lastPrediction = out;
    return out;
  },
  summarize(out) {
    const [la, lo] = out.intercept;
    return `Predicted ${out.path.length}-point route; intercept at ${la.toFixed(4)}, ${lo.toFixed(4)} in ~${out.eta_s} s.`;
  },
};
