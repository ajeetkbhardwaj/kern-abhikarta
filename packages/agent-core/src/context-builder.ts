import type { Logger, ModelAdapter, ModelRequest, ModelToolSchema, ModelStreamEvent, ChatMessage } from "@kern/protocol";
import { createLogger, nullLogger, AssistantMessageAssembler, getToolCalls } from "@kern/protocol";
import { SessionManager } from "@kern/session-store";
import { ToolRegistry } from "@kern/tools";

export interface ContextSnapshot {
  systemPrompt: string;
  messages: ChatMessage[];
  tools: ModelToolSchema[];
  contextTokens?: number;
}

export class ContextBuilder {
  private readonly baseSystemPrompt: string;
  private readonly toolRegistry: ToolRegistry;
  private readonly logger: Logger;

  constructor(options: { baseSystemPrompt: string; toolRegistry: ToolRegistry; logger?: Logger }) {
    this.baseSystemPrompt = options.baseSystemPrompt;
    this.toolRegistry = options.toolRegistry;
    this.logger = options.logger ?? nullLogger;
  }

  async build(sessions: SessionManager): Promise<ContextSnapshot> {
    const compaction = sessions.lastCompaction();
    const messages: ChatMessage[] = [];
    if (compaction) {
      messages.push({ role: "user", content: [{ type: "text", text: `[COMPACTED SUMMARY]\n${compaction.summary}` }], timestamp: compaction.timestamp });
    }
    const active = sessions.getActivePath();
    for (const entry of active) {
      if (entry.type === "message") {
        if (compaction && entry.id <= compaction.replacesThroughId) continue;
        messages.push(entry.message);
      }
    }
    const tools = this.toolRegistry.listModelSchemas();
    return {
      systemPrompt: this.baseSystemPrompt,
      messages,
      tools,
    };
  }
}