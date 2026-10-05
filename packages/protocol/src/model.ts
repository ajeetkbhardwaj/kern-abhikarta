/**
 * @kern/protocol — model contracts.
 *
 * Providers differ in roles, tool-schema dialect, streaming chunking, usage
 * fields and stop reasons. The adapter absorbs ALL of that so the agent core
 * only ever sees the normalized shapes below.
 */

import type { ChatMessage, ContentBlock, ReasoningBlock, TextBlock, ToolCallBlock, ToolResultBlock } from "./core.js";

/** JSON Schema subset. Validators/providers can narrow this further. */
export interface JsonSchema {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  [key: string]: unknown;
}

export interface ModelToolSchema {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface ModelRequest {
  /** Assembled once per context build; providers that lack a system role prepend it. */
  systemPrompt: string;
  messages: ChatMessage[];
  tools: ModelToolSchema[];
  maxOutputTokens?: number;
  temperature?: number;
  /** Optional thinking/reasoning budget for providers that support it. */
  thinkingLevel?: "off" | "low" | "medium" | "high";
  signal?: AbortSignal;
}

export type StopReason =
  | "stop"
  | "tool_use"
  | "max_tokens"
  | "length"
  | "content_filter"
  | "cancelled"
  | "error";

/**
 * Normalized stream events. Adapters emit these; the agent core assembles them
 * into a single assistant `ChatMessage`.
 */
export type ModelStreamEvent =
  | { type: "text_delta"; delta: string }
  | { type: "reasoning_delta"; delta: string }
  | { type: "tool_call_delta"; callId: string; delta: string }
  | { type: "tool_call_complete"; call: ToolCallBlock }
  | { type: "usage"; usage: import("./core.js").TokenCounts; contextTokens?: number }
  | { type: "finished"; reason: StopReason };

export interface ModelInfo {
  provider: string;
  modelId: string;
  /** Total context window in tokens. Required for compaction budgeting. */
  contextWindow: number;
  /** Default output reservation. */
  maxOutputTokens: number;
  supportsThinking?: boolean;
  supportsParallelToolCalls?: boolean;
}

export interface ModelAdapter {
  readonly info: ModelInfo;
  /**
   * Stream one completion. Must throw `KernError.model(...)` for provider
   * failures so the retry policy can classify them.
   */
  stream(request: ModelRequest): AsyncIterable<ModelStreamEvent>;
}

// ---------------------------------------------------------------------------
// Assistant message assembly — shared by every adapter consumer
// ---------------------------------------------------------------------------

/**
 * Accumulates normalized stream events into one assistant message.
 *
 * Providers stream tool-call arguments as arbitrary JSON fragments keyed by
 * index, so the assembler buffers arguments as text and parses once at
 * `finalize()`. Ordering of content blocks is preserved as it arrives.
 */
export class AssistantMessageAssembler {
  private readonly blocks: ContentBlock[] = [];
  private textBuffer = "";
  private reasoningBuffer = "";
  private readonly pendingToolCalls = new Map<string, { name: string; argsText: string }>();

  apply(event: ModelStreamEvent): void {
    switch (event.type) {
      case "text_delta":
        this.textBuffer += event.delta;
        break;
      case "reasoning_delta":
        this.reasoningBuffer += event.delta;
        break;
      case "tool_call_delta": {
        // Argument fragments only. The tool name arrives with tool_call_complete.
        const entry = this.pendingToolCalls.get(event.callId) ?? { name: "", argsText: "" };
        entry.argsText += event.delta;
        this.pendingToolCalls.set(event.callId, entry);
        break;
      }
      case "tool_call_complete": {
        // The authoritative call. Any buffered argument fragments for this id
        // are superseded — providers that stream args also always send this.
        this.commitText();
        this.commitReasoning();
        this.pendingToolCalls.delete(event.call.id);
        this.blocks.push(event.call);
        break;
      }
      case "usage":
      case "finished":
        // Carried alongside the message; the caller decides what to do.
        break;
    }
  }

  /** Stream a plain event object into the assembler. */
  applyAll(events: Iterable<ModelStreamEvent>): void {
    for (const event of events) this.apply(event);
  }

  /** Flush buffered text/reasoning. Safe to call repeatedly. */
  private commitText(): void {
    if (this.textBuffer.length === 0) return;
    const block: TextBlock = { type: "text", text: this.textBuffer };
    this.blocks.push(block);
    this.textBuffer = "";
  }

  private commitReasoning(): void {
    if (this.reasoningBuffer.length === 0) return;
    const block: ReasoningBlock = { type: "reasoning", text: this.reasoningBuffer };
    this.blocks.push(block);
    this.reasoningBuffer = "";
  }

  finalize(timestamp = new Date().toISOString()): ChatMessage {
    this.commitText();
    this.commitReasoning();
    return { role: "assistant", content: [...this.blocks], timestamp };
  }
}

/** Extract tool calls from a finalized assistant message, in emission order. */
export function getToolCalls(message: ChatMessage): ToolCallBlock[] {
  return message.content.filter((block): block is ToolCallBlock => block.type === "tool_call");
}

/** Extract tool result blocks from a finalized tool message. */
export function getToolResults(message: ChatMessage): ToolResultBlock[] {
  return message.content.filter((block): block is ToolResultBlock => block.type === "tool_result");
}