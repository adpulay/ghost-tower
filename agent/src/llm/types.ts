export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ChatResponse {
  content: string | null;
  tool_calls: ToolCall[];
}

export interface ChatModel {
  readonly name: string;
  chat(messages: ChatMessage[], tools: unknown[]): Promise<ChatResponse>;
}
