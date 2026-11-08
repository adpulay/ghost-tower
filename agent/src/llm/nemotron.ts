import type { LlmConfig } from "../config.js";
import type { ChatMessage, ChatModel, ChatResponse, ToolCall } from "./types.js";

/**
 * OpenAI-compatible chat client for Nemotron, served by vLLM on Brev
 * (--enable-auto-tool-choice --tool-call-parser qwen3_coder --reasoning-parser deepseek_r1)
 * or NVIDIA's hosted endpoint. Every call has a hard timeout (default 20 s).
 */
export class NemotronClient implements ChatModel {
  readonly name: string;
  constructor(private cfg: LlmConfig, private fetchImpl: typeof fetch = fetch) {
    this.name = `${cfg.provider}:${cfg.model}`;
  }

  async chat(messages: ChatMessage[], tools: unknown[]): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages,
      // vLLM ≥0.31 rejects `tools: []`, so leave tools out entirely when there are none.
      ...(tools.length ? { tools, tool_choice: "auto" } : {}),
      temperature: Number(process.env.NEMOTRON_TEMPERATURE ?? 0.2),
      max_tokens: Number(process.env.NEMOTRON_MAX_TOKENS ?? 2048),
    };
    // Nemotron 3 supports turning reasoning off for lower latency.
    if (process.env.NEMOTRON_THINKING === "0") body.chat_template_kwargs = { enable_thinking: false };

    const res = await this.fetchImpl(`${this.cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.cfg.apiKey ? { Authorization: `Bearer ${this.cfg.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.cfg.timeoutMs),
    });
    if (!res.ok) throw new Error(`nemotron HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = (await res.json()) as {
      choices: { message: { content?: string | null; reasoning?: string | null; reasoning_content?: string | null; tool_calls?: ToolCall[] } }[];
    };
    const msg = json.choices?.[0]?.message ?? {};
    let toolCalls = msg.tool_calls ?? [];
    if (!toolCalls.length) {
      // With thinking off, vLLM's deepseek_r1 reasoning parser never sees </think>, so it files the
      // whole reply (tool calls included) under `reasoning` and the tool parser never runs.
      // Recover the qwen3_coder-format calls ourselves.
      toolCalls = parseXmlToolCalls(`${msg.reasoning ?? msg.reasoning_content ?? ""}\n${msg.content ?? ""}`, tools);
    }
    let content = toolCalls.length && !msg.tool_calls?.length ? stripToolCallXml(msg.content ?? null) : msg.content ?? null;
    // Same parser issue for the final summary: with thinking off, `reasoning` is the actual answer.
    // With thinking on it's the model's private reasoning, so it's never shown.
    if (!content && !toolCalls.length && process.env.NEMOTRON_THINKING === "0") {
      content = stripToolCallXml(msg.reasoning ?? msg.reasoning_content ?? null);
    }
    return {
      content: stripThinking(content),
      tool_calls: toolCalls.map((tc, i) => ({
        id: tc.id || `call_${Date.now()}_${i}`,
        type: "function",
        function: { name: tc.function.name, arguments: tc.function.arguments || "{}" },
      })),
    };
  }
}

/**
 * Parse qwen3_coder-style tool calls:
 *   <tool_call><function=NAME><parameter=KEY>VALUE</parameter>…</function></tool_call>
 * Parameters the tool schema declares as strings stay strings (a `zone_json` string must not become
 * an array). Others are parsed as JSON when they can be (numbers, booleans, arrays, objects).
 */
export function parseXmlToolCalls(text: string, tools: unknown[] = []): ToolCall[] {
  const calls: ToolCall[] = [];
  const callRe = /<tool_call>\s*<function=([^>\s]+)>([\s\S]*?)<\/function>\s*<\/tool_call>/g;
  const paramRe = /<parameter=([^>\s]+)>\n?([\s\S]*?)\n?<\/parameter>/g;
  for (const m of text.matchAll(callRe)) {
    const props = schemaProps(tools, m[1]);
    const args: Record<string, unknown> = {};
    for (const p of m[2].matchAll(paramRe)) {
      const raw = p[2].trim();
      if (props[p[1]]?.type === "string") {
        args[p[1]] = raw;
        continue;
      }
      try {
        args[p[1]] = JSON.parse(raw);
      } catch {
        args[p[1]] = raw;
      }
    }
    calls.push({ id: "", type: "function", function: { name: m[1], arguments: JSON.stringify(args) } });
  }
  return calls;
}

/** The JSON-schema `properties` of one tool from an OpenAI `tools` array, or {} if not found. */
function schemaProps(tools: unknown[], name: string): Record<string, { type?: string }> {
  for (const t of tools as { function?: { name?: string; parameters?: { properties?: Record<string, { type?: string }> } } }[]) {
    if (t?.function?.name === name) return t.function.parameters?.properties ?? {};
  }
  return {};
}

function stripToolCallXml(s: string | null): string | null {
  if (!s) return s;
  return s.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "").trim() || null;
}

/** Remove any <think>…</think> block that leaks into content if the reasoning parser is off. */
export function stripThinking(s: string | null): string | null {
  if (!s) return s;
  return s.replace(/<think>[\s\S]*?<\/think>/g, "").trim() || null;
}

/** One tiny request so the first real call isn't cold (run right before judging). */
export async function warmUp(model: ChatModel): Promise<number> {
  const t0 = Date.now();
  await model.chat(
    [
      { role: "system", content: "You are a warm-up probe. Reply with the word ready." },
      { role: "user", content: "ready?" },
    ],
    [],
  );
  return Date.now() - t0;
}
