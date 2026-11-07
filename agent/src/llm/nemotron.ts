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
      tools,
      tool_choice: "auto",
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
      choices: { message: { content?: string | null; tool_calls?: ToolCall[] } }[];
    };
    const msg = json.choices?.[0]?.message ?? {};
    return {
      content: stripThinking(msg.content ?? null),
      tool_calls: (msg.tool_calls ?? []).map((tc, i) => ({
        id: tc.id || `call_${Date.now()}_${i}`,
        type: "function",
        function: { name: tc.function.name, arguments: tc.function.arguments || "{}" },
      })),
    };
  }
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
