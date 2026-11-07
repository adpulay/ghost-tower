import type { ChatMessage, ChatModel, ChatResponse, ToolCall } from "./types.js";

/**
 * Deterministic stand-in for Nemotron. It follows the system prompt's required plan exactly,
 * batching independent tools, so the loop, tools, reducers, trace panel, evals and replay can
 * be exercised with no GPU. It is NOT evidence of model quality: eval numbers produced with it
 * only validate the harness.
 */
export class MockPolicy implements ChatModel {
  readonly name = "mock:policy";
  private n = 0;

  async chat(messages: ChatMessage[]): Promise<ChatResponse> {
    const user = messages.find((m) => m.role === "user")?.content ?? "";
    const mode = /MODE: (\w+)/.exec(user)?.[1] ?? "investigate";
    const ctx = parseContext(user);
    const done = new Map<string, unknown>();
    for (const m of messages) {
      if (m.role !== "tool" || !m.name) continue;
      try {
        done.set(m.name, JSON.parse(m.content ?? "null"));
      } catch {
        done.set(m.name, m.content);
      }
    }
    const has = (n: string) => done.has(n);
    const track = (done.get("get_track_context") as { track?: any } | undefined)?.track ?? ctx.track;
    const predictArgs = {
      lat: track.lat,
      lon: track.lon,
      heading_deg: track.heading_deg,
      speed_mps: track.speed_mps,
      horizon_s: 300,
    };

    const calls: [string, Record<string, unknown>][] = [];
    if (mode === "investigate") {
      if (!has("get_track_context")) calls.push(["get_track_context", { track_id: ctx.track.id }]);
      else if (!has("rdap_domain_age")) {
        calls.push(["rdap_domain_age", { domain: ctx.domain ?? "unknown.invalid" }]);
        calls.push(["carrier_smsc_lookup", { url_hash: ctx.url_hash, ts_ms: ctx.latest_ts_ms }]);
        calls.push(["predict_route", predictArgs]);
      } else if (!has("agent_link_campaign")) {
        const age = (done.get("rdap_domain_age") as { age_days?: number })?.age_days ?? -1;
        calls.push(["agent_link_campaign", { url_hash: ctx.url_hash, brand: ctx.brand, domain_age_days: age }]);
        calls.push(["agent_set_prediction", {}]);
        calls.push(["draft_report", { track_id: ctx.track.id, kind: "warning" }]);
      } else if (!has("send_warning")) calls.push(["send_warning", {}]);
      else if (!has("agent_record_alert")) calls.push(["agent_record_alert", {}]);
    } else if (mode === "replan") {
      if (!has("predict_route")) calls.push(["predict_route", predictArgs]);
      else if (!has("agent_set_prediction")) {
        calls.push(["agent_set_prediction", {}]);
        calls.push(["draft_report", { track_id: ctx.track.id, kind: "warning" }]);
      } else if (!has("send_warning")) calls.push(["send_warning", {}]);
      else if (!has("agent_record_alert")) calls.push(["agent_record_alert", {}]);
    } else {
      if (!has("predict_route")) calls.push(["predict_route", predictArgs]);
      else if (!has("agent_set_prediction")) calls.push(["agent_set_prediction", {}]);
    }

    if (calls.length === 0) {
      const sent = (done.get("send_warning") as { sent?: number })?.sent;
      const text =
        mode === "refresh"
          ? `Route prediction refreshed for track #${ctx.track.id}.`
          : `Track #${ctx.track.id}: ${ctx.brand || "unbranded"} lure from a new domain, not via carrier; route predicted${sent !== undefined ? `, ${sent} phones warned` : ""}.`;
      return { content: text, tool_calls: [] };
    }
    return {
      content: null,
      tool_calls: calls.map(
        ([name, args]): ToolCall => ({ id: `mock_${++this.n}`, type: "function", function: { name, arguments: JSON.stringify(args) } }),
      ),
    };
  }
}

interface MockContext {
  track: { id: number; lat: number; lon: number; heading_deg: number; speed_mps: number };
  url_hash: string;
  brand: string;
  domain?: string;
  latest_ts_ms: number;
}

function parseContext(user: string): MockContext {
  const m = /```json\n([\s\S]*?)\n```/.exec(user);
  if (!m) throw new Error("mock policy: no context block in user message");
  return JSON.parse(m[1]);
}
