/**
 * @kern/protocol — tool contracts.
 *
 * A tool is a capability granted to the model. The registry is the ONLY place
 * where capability and policy are decided; the agent core never special-cases
 * tool names.
 */

import type { JsonSchema, ModelToolSchema } from "./model.js";
import type { TextBlock, ToolResultBlock } from "./core.js";

/** Side-effect classification. Drives the default policy table. */
export type SideEffect = "read" | "write" | "execute" | "network";

export type PolicyDecision =
  | { decision: "allow" }
  | { decision: "deny"; reason: string }
  | { decision: "require_approval"; prompt: string };

export interface ToolContext {
  cwd: string;
  workspaceRoot: string;
  signal: AbortSignal;
  /** Approval request sink. Absent in fully headless/read-only deployments. */
  requestApproval?: (prompt: string, meta?: { toolName: string; origin: string }) => Promise<boolean | "session">;
  emitProgress: (delta: string) => void;
}

export interface ToolResult {
  content: TextBlock[];
  isError: boolean;
  details?: Record<string, unknown>;
}

export interface ToolDefinition<TArgs = unknown> {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  sideEffect: SideEffect;
  /** Rendered into the system prompt so the model knows what it may do. */
  instructions?: string;
  execute(args: TArgs, ctx: ToolContext): Promise<ToolResult>;
  /** Convert to the provider-facing schema. Override for dialect differences. */
  toModelSchema?(): ModelToolSchema;
}

export function defaultModelSchema(tool: ToolDefinition): ModelToolSchema {
  return {
    name: tool.name,
    description: tool.instructions ? `${tool.description}\n\n${tool.instructions}` : tool.description,
    inputSchema: tool.inputSchema,
  };
}

/** Policy input. `origin` matters: user-initiated calls bypass model pressure. */
export interface PolicyInput {
  toolName: string;
  arguments: unknown;
  cwd: string;
  origin: "model" | "user" | "extension";
}

export interface ToolPolicyEngine {
  evaluate(input: PolicyInput): Promise<PolicyDecision>;
}

/** Caps on tool output before it enters model context. */
export interface OutputBudget {
  maxBytes: number;
  maxLines: number;
  /** Rough characters-per-token used only when no tokenizer is available. */
  charsPerToken?: number;
}

export const DEFAULT_OUTPUT_BUDGET: OutputBudget = {
  maxBytes: 30_000,
  maxLines: 400,
  charsPerToken: 4,
};

/**
 * Truncate text to the budget, keeping the head and tail — the head explains
 * what ran, the tail usually contains the error. Records what was dropped.
 */
export function boundText(
  text: string,
  budget: OutputBudget = DEFAULT_OUTPUT_BUDGET,
): { text: string; truncated: boolean; droppedLines: number; droppedChars: number } {
  const lines = text.split("\n");
  let out = text;
  let truncated = false;
  let droppedLines = 0;

  if (lines.length > budget.maxLines) {
    droppedLines = lines.length - budget.maxLines;
    out = lines.slice(0, budget.maxLines).join("\n");
    truncated = true;
  }

  let droppedChars = 0;
  if (out.length > budget.maxBytes) {
    droppedChars = out.length - budget.maxBytes;
    // Keep head and tail within the byte budget.
    const head = Math.floor(budget.maxBytes * 0.6);
    const tail = budget.maxBytes - head;
    out = `${out.slice(0, head)}\n\n[... ${droppedChars} characters truncated ...]\n\n${out.slice(out.length - tail)}`;
    truncated = true;
  }

  return { text: out, truncated, droppedLines, droppedChars };
}

export function toolResultToBlock(result: ToolResult, toolCallId: string): ToolResultBlock {
  return {
    type: "tool_result",
    toolCallId,
    content: result.content,
    isError: result.isError,
    details: result.details,
  };
}

export function textResult(text: string, isError = false, details?: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text }], isError, details };
}