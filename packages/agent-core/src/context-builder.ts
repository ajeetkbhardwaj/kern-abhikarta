import type { Logger, ModelToolSchema, ChatMessage } from "@kern/protocol";
import { nullLogger } from "@kern/protocol";
import { SessionManager } from "@kern/session-store";
import { ToolRegistry } from "@kern/tools";
import { countContextTokens, type ContextUsage } from "./tokens.js";

export interface ContextSnapshot {
  systemPrompt: string;
  messages: ChatMessage[];
  tools: ModelToolSchema[];
  usage: ContextUsage;
}

export interface ContextBuilderOptions {
  baseSystemPrompt: string;
  toolRegistry: ToolRegistry;
  logger?: Logger;
  /** Extra system sections appended after the base prompt (AGENTS.md, skills catalog). */
  systemExtra?: string;
}

export class ContextBuilder {
  private readonly baseSystemPrompt: string;
  private readonly toolRegistry: ToolRegistry;
  private readonly logger: Logger;
  private systemExtra: string;

  constructor(options: ContextBuilderOptions) {
    this.baseSystemPrompt = options.baseSystemPrompt;
    this.toolRegistry = options.toolRegistry;
    this.logger = options.logger ?? nullLogger;
    this.systemExtra = options.systemExtra ?? "";
  }

  setSystemExtra(text: string): void {
    this.systemExtra = text;
  }

  systemPrompt(): string {
    if (!this.systemExtra) return this.baseSystemPrompt;
    return `${this.baseSystemPrompt}\n\n${this.systemExtra}`;
  }

  async build(sessions: SessionManager): Promise<ContextSnapshot> {
    const systemPrompt = this.systemPrompt();
    const compaction = sessions.lastCompaction();
    const messages: ChatMessage[] = [];
    if (compaction) {
      messages.push({
        role: "user",
        content: [{ type: "text", text: `[COMPACTED SUMMARY]\n${compaction.summary}` }],
        timestamp: compaction.timestamp,
      });
    }
    const active = sessions.getActivePath();
    // Resolve the compaction cutoff to a seq when possible. The cutoff entry
    // (replacesThroughId) carries the highest covered seq; entries at or
    // below it are replaced by the summary.
    const cutoff = compaction ? sessions.getEntry(compaction.replacesThroughId) : undefined;
    const cutoffSeq = cutoff?.seq;
    for (const entry of active) {
      if (entry.type !== "message") continue;
      if (compaction && isCoveredByCompaction(entry.id, entry.seq, compaction.replacesThroughId, cutoffSeq)) continue;
      messages.push(entry.message);
    }
    const tools = this.toolRegistry.listModelSchemas();
    const usage = countContextTokens(systemPrompt, tools, messages);
    return { systemPrompt, messages, tools, usage };
  }
}

/**
 * Decide whether an entry predates the compaction cutoff.
 * Prefers monotonic seq when both sides carry it; falls back to the
 * zero-padded id comparison for entries written before seq existed.
 */
function isCoveredByCompaction(
  entryId: string,
  entrySeq: number | undefined,
  replacesThroughId: string,
  cutoffSeq: number | undefined,
): boolean {
  if (entrySeq !== undefined && cutoffSeq !== undefined) {
    return entrySeq <= cutoffSeq;
  }
  return entryId <= replacesThroughId;
}
