import type { ChatMessage, ModelToolSchema } from "@kern/protocol";

export interface TokenEstimator {
  countText(text: string): number;
}

/**
 * A conservative fallback estimator that is better than pure char/4 math.
 * It accounts for UTF-8 byte size, whitespace-separated words, and code-ish
 * punctuation so it behaves more sensibly for prompts, tool schemas, and code.
 */
export const defaultTokenEstimator: TokenEstimator = {
  countText(text: string): number {
    if (!text) return 0;
    const bytes = new TextEncoder().encode(text).length;
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    const alnumTokens = text.match(/[\p{L}\p{N}_]+/gu)?.length ?? 0;
    const punctTokens = text.match(/[^\p{L}\p{N}\s]+/gu)?.length ?? 0;
    const byteEstimate = Math.ceil(bytes / 4);
    const lexicalEstimate = Math.max(words, alnumTokens) + Math.ceil(punctTokens / 2);
    return Math.max(1, Math.ceil((byteEstimate + lexicalEstimate) / 2));
  },
};

/**
 * Backward-compatible estimateTokens() wrapper used throughout the runtime.
 * This is still heuristic, but it is no longer the crude char / 4 fallback.
 */
export function estimateTokens(text: string, charsPerToken = 4): number {
  void charsPerToken;
  return defaultTokenEstimator.countText(text);
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
  const roleCost = defaultTokenEstimator.countText(message.role);
  const bodyCost = defaultTokenEstimator.countText(String(chars));
  return roleCost + 4 + bodyCost;
}

export function countToolsTokens(tools: ModelToolSchema[]): number {
  let chars = 0;
  for (const t of tools) {
    chars += t.name.length + t.description.length + JSON.stringify(t.inputSchema).length;
  }
  return defaultTokenEstimator.countText("tools:") + defaultTokenEstimator.countText(String(chars));
}

export interface ContextUsage {
  systemTokens: number;
  toolsTokens: number;
  messagesTokens: number;
  totalTokens: number;
}

export function countContextTokens(systemPrompt: string, tools: ModelToolSchema[], messages: ChatMessage[]): ContextUsage {
  const systemTokens = defaultTokenEstimator.countText(systemPrompt);
  const toolsTokens = countToolsTokens(tools);
  let messagesTokens = 0;
  for (const m of messages) messagesTokens += countMessageTokens(m);
  return { systemTokens, toolsTokens, messagesTokens, totalTokens: systemTokens + toolsTokens + messagesTokens };
}
