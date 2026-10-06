import type { ChatMessage, ModelToolSchema } from "@kern/protocol";

/** Rough characters-per-token for English/code. Only a fallback. */
export const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string, charsPerToken = CHARS_PER_TOKEN): number {
  if (text.length === 0) return 0;
  return Math.max(1, Math.ceil(text.length / charsPerToken));
}

export function countMessageTokens(message: ChatMessage): number {
  let chars = 0;
  for (const block of message.content) {
    if (block.type === "text" || block.type === "reasoning") chars += block.text.length;
    else if (block.type === "tool_call") chars += block.name.length + JSON.stringify(block.arguments ?? "").length + 16;
    else if (block.type === "tool_result") {
      for (const c of block.content) chars += c.text.length;
      chars += 16;
    }
  }
  // Role + framing overhead.
  return estimateTokens(message.role) + 4 + Math.ceil(chars / CHARS_PER_TOKEN);
}

export function countToolsTokens(tools: ModelToolSchema[]): number {
  let chars = 0;
  for (const t of tools) {
    chars += t.name.length + t.description.length + JSON.stringify(t.inputSchema).length;
  }
  return estimateTokens("tools:") + Math.ceil(chars / CHARS_PER_TOKEN);
}

export interface ContextUsage {
  systemTokens: number;
  toolsTokens: number;
  messagesTokens: number;
  totalTokens: number;
}

export function countContextTokens(systemPrompt: string, tools: ModelToolSchema[], messages: ChatMessage[]): ContextUsage {
  const systemTokens = estimateTokens(systemPrompt);
  const toolsTokens = countToolsTokens(tools);
  let messagesTokens = 0;
  for (const m of messages) messagesTokens += countMessageTokens(m);
  return { systemTokens, toolsTokens, messagesTokens, totalTokens: systemTokens + toolsTokens + messagesTokens };
}
