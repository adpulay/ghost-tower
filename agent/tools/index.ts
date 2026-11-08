import { carrierSmscLookupTool } from "./carrier_smsc_lookup.js";
import { draftReportTool } from "./draft_report/index.js";
import { getTrackContextTool } from "./get_track_context.js";
import { predictRouteTool } from "./predict_route/index.js";
import { rdapDomainAgeTool } from "./rdap_domain_age.js";
import { agentLinkCampaignTool, agentRecordAlertTool, agentSetPredictionTool } from "./reducers.js";
import { sendWarningTool } from "./send_warning.js";
import type { ToolDef } from "./types.js";

export const TOOLS: ToolDef[] = [
  getTrackContextTool,
  rdapDomainAgeTool,
  carrierSmscLookupTool,
  predictRouteTool,
  draftReportTool,
  sendWarningTool,
  agentLinkCampaignTool,
  agentSetPredictionTool,
  agentRecordAlertTool,
];

export const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** OpenAI-compatible `tools` array for the chat completions request. */
export function openAiTools(only?: readonly string[]) {
  return TOOLS.filter((t) => !only || only.includes(t.name)).map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

export * from "./types.js";
