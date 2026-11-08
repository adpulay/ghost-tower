import assert from "node:assert/strict";
import { test } from "node:test";
import type { LlmConfig } from "../src/config.js";
import { NemotronClient, parseXmlToolCalls } from "../src/llm/nemotron.js";

const CFG: LlmConfig = { provider: "brev", baseUrl: "http://x/v1", apiKey: "", model: "nemotron", timeoutMs: 1000 };

/** A fetch stub that returns one chat completion message and records the request body. */
function stub(message: Record<string, unknown>) {
  const sent: any[] = [];
  const f = (async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200 });
  }) as unknown as typeof fetch;
  return { f, sent };
}

// What vLLM 0.31 returned live with enable_thinking=false and --reasoning-parser deepseek_r1.
const XML = "\n<tool_call>\n<function=predict_route>\n<parameter=lat>\n32.9858\n</parameter>\n<parameter=heading_deg>\n90\n</parameter>\n<parameter=note>\nheading east\n</parameter>\n</function>\n</tool_call>\n";

test("parses qwen3_coder XML tool calls, keeping numbers as numbers", () => {
  const [c] = parseXmlToolCalls(XML);
  assert.equal(c.function.name, "predict_route");
  assert.deepEqual(JSON.parse(c.function.arguments), { lat: 32.9858, heading_deg: 90, note: "heading east" });
  assert.equal(parseXmlToolCalls("no calls here").length, 0);
});

test("string parameters stay strings even when they look like JSON (seen live with zone_json)", () => {
  const xml = "<tool_call>\n<function=agent_record_alert>\n<parameter=zone_json>\n[[32.98,-96.77]]\n</parameter>\n<parameter=recipients>\n26\n</parameter>\n</function>\n</tool_call>";
  const tools = [{ type: "function", function: { name: "agent_record_alert", parameters: { properties: { zone_json: { type: "string" }, recipients: { type: "integer" } } } } }];
  const args = JSON.parse(parseXmlToolCalls(xml, tools)[0].function.arguments);
  assert.equal(args.zone_json, "[[32.98,-96.77]]");
  assert.equal(args.recipients, 26);
});

test("tool calls that land in `reasoning` (thinking off) are recovered", async () => {
  const { f } = stub({ content: null, reasoning: XML, tool_calls: [] });
  const r = await new NemotronClient(CFG, f).chat([{ role: "user", content: "go" }], [{}]);
  assert.equal(r.tool_calls.length, 1);
  assert.equal(r.tool_calls[0].function.name, "predict_route");
  assert.ok(r.tool_calls[0].id, "recovered calls get an id");
});

test("real tool_calls from the server win over anything in reasoning", async () => {
  const real = { id: "a", type: "function", function: { name: "send_warning", arguments: "{}" } };
  const { f } = stub({ content: null, reasoning: XML, tool_calls: [real] });
  const r = await new NemotronClient(CFG, f).chat([{ role: "user", content: "go" }], [{}]);
  assert.deepEqual(r.tool_calls.map((t) => t.function.name), ["send_warning"]);
});

test("final summary in `reasoning` is used only when thinking is off", async () => {
  const msg = { content: null, reasoning: "Route predicted east on Campbell Rd.", tool_calls: [] };
  const prev = process.env.NEMOTRON_THINKING;
  try {
    process.env.NEMOTRON_THINKING = "0";
    assert.equal((await new NemotronClient(CFG, stub(msg).f).chat([], [])).content, "Route predicted east on Campbell Rd.");
    delete process.env.NEMOTRON_THINKING;
    assert.equal((await new NemotronClient(CFG, stub(msg).f).chat([], [])).content, null, "private reasoning is never shown");
  } finally {
    if (prev === undefined) delete process.env.NEMOTRON_THINKING;
    else process.env.NEMOTRON_THINKING = prev;
  }
});

test("empty tools list is left out of the request", async () => {
  const { f, sent } = stub({ content: "ready" });
  await new NemotronClient(CFG, f).chat([{ role: "user", content: "ready?" }], []);
  assert.equal("tools" in sent[0], false);
  assert.equal("tool_choice" in sent[0], false);
});
