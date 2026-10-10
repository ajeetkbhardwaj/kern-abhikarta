import type { ChatMessage, Logger, ModelAdapter } from "@kern/protocol";
import { AssistantMessageAssembler, nullLogger } from "@kern/protocol";
import { SessionManager } from "@kern/session-store";
import type { ContextSnapshot } from "./context-builder.js";

export const COMPACTION_SYSTEM_PROMPT = `You are compressing a coding-agent conversation for continuation by another model.

Produce a structured checkpoint summary. Preserve:
- the user's exact goal and non-negotiable constraints;
- exact file paths, function/class names, APIs, commands, versions, and error messages;
- modifications already made and how they were verified;
- decisions and their rationale;
- blockers and the next concrete steps.

Do not invent results. Mark uncertainty explicitly.
Do not include irrelevant conversational wording or repeated tool output.

Use exactly this format:

# Context checkpoint

## Goal
- What the user wants

## Constraints and preferences
- Required technologies, style, permissions, scope restrictions

## Workspace facts
- Important files, paths, architecture, environment facts

## Progress
- Completed work
- Current work
- Verified results

## Decisions
- Design choices and why

## Errors and blockers
- Exact error messages, failed commands, unresolved questions

## Next steps
1. Concrete next action
2. Concrete next action

## Critical artifacts
- Exact paths, function names, commands, identifiers, API shapes`;

export interface CompactionDecision {
  shouldCompact: boolean;
  reason: string;
  totalTokens: number;
  budgetTokens: number;
  weakSummary?: boolean;
}

export interface CompactionQuality {
  isWeak: boolean;
  reason: string;
  minimumWords: number;
  observedWords: number;
}

export interface CompactorOptions {
  logger?: Logger;
  /** Fraction of the context window that triggers compaction. Default 0.75. */
  threshold?: number;
  /** Tokens always reserved for the next model response. Default 4000. */
  outputReserve?: number;
}

/**
 * Decides when history must be summarized and produces the summary
 * by asking the model itself. Raw entries stay on disk for audit;
 * only the reconstructed context view changes.
 */
export class Compactor {
  private readonly logger: Logger;
  private readonly threshold: number;
  private readonly outputReserve: number;
  private readonly minimumSummaryWords: number;

  constructor(options: CompactorOptions = {}) {
    this.logger = options.logger ?? nullLogger;
    this.threshold = options.threshold ?? 0.75;
    this.outputReserve = options.outputReserve ?? 4000;
    this.minimumSummaryWords = 24;
  }

  /**
   * S + T + H + R + M <= W must hold. Returns the verdict plus numbers
   * so callers can log and emit precise diagnostics.
   */
  evaluate(snapshot: ContextSnapshot, contextWindow: number, safetyMargin = 1000): CompactionDecision {
    const totalTokens = snapshot.usage.totalTokens;
    const reserve = Math.max(this.outputReserve, Math.ceil(contextWindow * 0.1));
    const budgetTokens = Math.floor(contextWindow * this.threshold) - reserve - safetyMargin;
    if (totalTokens >= budgetTokens) {
      return {
        shouldCompact: true,
        reason: `context tokens ${totalTokens} >= budget ${budgetTokens} (window ${contextWindow})`,
        totalTokens,
        budgetTokens,
      };
    }
    return { shouldCompact: false, reason: "within budget", totalTokens, budgetTokens };
  }

  assessSummaryQuality(summary: string): CompactionQuality {
    const normalized = summary.trim();
    const words = normalized ? normalized.split(/\s+/).filter(Boolean).length : 0;
    const weak = words < this.minimumSummaryWords || normalized.length < 120;
    return {
      isWeak: weak,
      reason: weak ? `summary is too weak: ${words} words / ${normalized.length} chars` : "summary has sufficient detail",
      minimumWords: this.minimumSummaryWords,
      observedWords: words,
    };
  }

  /**
   * Summarize everything on the active path up to the current leaf.
   * If a previous checkpoint exists, it is fed back in so the new
   * summary is an update, not a lossy rewrite from scratch.
   */
  async compact(sessions: SessionManager, model: ModelAdapter, instructions?: string): Promise<{ summary: string; replacesThroughId: string }> {
    const path = sessions.getActivePath();
    const messageEntries = path.filter((e) => e.type === "message");
    if (messageEntries.length === 0) {
      throw new Error("Nothing to compact: no messages on active path");
    }
    const replacesThroughId = messageEntries[messageEntries.length - 1]!.id;

    const previous = sessions.lastCompaction();
    const conversation = messageEntries
      .map((e) => {
        if (e.type !== "message") return "";
        return `--- ${e.message.role} (${e.id}) ---\n${renderMessage(e.message)}`;
      })
      .join("\n\n");

    const userText = [
      previous ? `Previous checkpoint (update it, do not discard its facts unless superseded):\n${previous.summary}` : null,
      `Conversation to compress:\n${conversation}`,
      instructions ? `Additional instructions:\n${instructions}` : null,
    ]
      .filter((s): s is string => s !== null)
      .join("\n\n");

    const assembler = new AssistantMessageAssembler();
    for await (const event of model.stream({
      systemPrompt: COMPACTION_SYSTEM_PROMPT,
      messages: [{ role: "user", content: [{ type: "text", text: userText }], timestamp: new Date().toISOString() }],
      tools: [],
      maxOutputTokens: this.outputReserve,
    })) {
      assembler.apply(event);
    }
    const message = assembler.finalize();
    const summary = message.content
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim();
    if (!summary) {
      throw new Error("Compaction produced an empty summary");
    }
    const quality = this.assessSummaryQuality(summary);
    if (quality.isWeak) {
      throw new Error(`Compaction produced a weak summary: ${quality.reason}`);
    }
    this.logger.info("compacted", { replacesThroughId, summaryChars: summary.length, quality: quality.reason });
    return { summary, replacesThroughId };
  }
}

function renderMessage(message: ChatMessage): string {
  const parts: string[] = [];
  for (const block of message.content) {
    if (block.type === "text") parts.push(block.text);
    else if (block.type === "reasoning") parts.push(`[thinking: ${block.text.slice(0, 500)}]`);
    else if (block.type === "tool_call") parts.push(`[tool call ${block.name} ${JSON.stringify(block.arguments ?? "").slice(0, 2000)}]`);
    else if (block.type === "tool_result") {
      const text = block.content.map((c) => c.text).join("\n").slice(0, 4000);
      parts.push(`[tool result${block.isError ? " ERROR" : ""}: ${text}]`);
    }
  }
  return parts.join("\n");
}
