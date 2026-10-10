/**
 * @kern/protocol — Zod schemas for runtime validation.
 * All session entries, messages, events must validate against these.
 */

import { z } from "zod";
import type { SessionEntry } from "./core.js";
import type { ModelStreamEvent } from "./model.js";

/** Text block */
export const TextBlockSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

/** Reasoning block */
export const ReasoningBlockSchema = z.object({
  type: z.literal("reasoning"),
  text: z.string(),
  signature: z.string().optional(),
});

/** Tool call block */
export const ToolCallBlockSchema = z.object({
  type: z.literal("tool_call"),
  id: z.string(),
  name: z.string(),
  arguments: z.unknown(),
});

/** Tool result details */
export const ToolResultDetailsSchema = z.object({
  durationMs: z.number().int().nonnegative().optional(),
  exitCode: z.number().int().optional(),
  truncated: z.boolean().optional(),
  stdoutTruncated: z.boolean().optional(),
  stderrTruncated: z.boolean().optional(),
  changedPaths: z.array(z.string()).optional(),
}).passthrough();

/** Tool result block */
export const ToolResultBlockSchema = z.object({
  type: z.literal("tool_result"),
  toolCallId: z.string(),
  content: z.array(TextBlockSchema),
  isError: z.boolean(),
  details: ToolResultDetailsSchema.optional(),
});

/** Content block union */
export const ContentBlockSchema = z.union([
  TextBlockSchema,
  ReasoningBlockSchema,
  ToolCallBlockSchema,
  ToolResultBlockSchema,
]);

/** Chat message roles */
export const RoleSchema = z.enum(["user", "assistant", "tool"]);

/** Chat message */
export const ChatMessageSchema = z.object({
  role: RoleSchema,
  content: z.array(ContentBlockSchema),
  timestamp: z.string().datetime(),
});

// ---------------------------------------------------------------------------
// Token counts
// ---------------------------------------------------------------------------

export const TokenCountsSchema = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative().optional(),
  cacheWrite: z.number().int().nonnegative().optional(),
});

// ---------------------------------------------------------------------------
// Session entries
// ---------------------------------------------------------------------------

export const BaseEntrySchema = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  timestamp: z.string().datetime(),
});

/** Session header */
export const SessionHeaderEntrySchema = BaseEntrySchema.extend({
  type: z.literal("session_header"),
  version: z.number().int().positive(),
  sessionId: z.string(),
  cwd: z.string(),
  createdAt: z.string().datetime(),
  meta: z.record(z.unknown()).optional(),
});

/** Message entry */
export const MessageEntrySchema = BaseEntrySchema.extend({
  type: z.literal("message"),
  message: ChatMessageSchema,
});

/** Compaction entry */
export const CompactionEntrySchema = BaseEntrySchema.extend({
  type: z.literal("compaction"),
  summary: z.string(),
  replacesThroughId: z.string(),
  tokensAfter: TokenCountsSchema.optional(),
});

/** Model change entry */
export const ModelChangeEntrySchema = BaseEntrySchema.extend({
  type: z.literal("model_change"),
  provider: z.string(),
  model: z.string(),
  thinkingLevel: z.string().optional(),
});

/** Label entry */
export const LabelEntrySchema = BaseEntrySchema.extend({
  type: z.literal("label"),
  targetId: z.string(),
  label: z.string(),
});

/** Branch entry */
export const BranchEntrySchema = BaseEntrySchema.extend({
  type: z.literal("branch"),
  forkedFromId: z.string(),
  note: z.string().optional(),
});

/** Branch summary */
export const BranchSummaryEntrySchema = BaseEntrySchema.extend({
  type: z.literal("branch_summary"),
  fromId: z.string(),
  summary: z.string(),
});

/** Session naming */
export const SessionNameEntrySchema = BaseEntrySchema.extend({
  type: z.literal("session_name"),
  name: z.string(),
});

/** Extension entry */
export const ExtensionEntrySchema = BaseEntrySchema.extend({
  type: z.literal("extension"),
  extensionName: z.string(),
  event: z.string(),
  payload: z.unknown(),
});

/** Diagnostic codes */
export const DiagnosticCodeSchema = z.enum([
  "E_MODEL_AUTH",
  "E_MODEL_RATE_LIMIT",
  "E_MODEL_TIMEOUT",
  "E_MODEL_NETWORK",
  "E_MODEL_OVERLOADED",
  "E_CONTEXT_OVERFLOW",
  "E_MODEL_MALFORMED",
  "E_MODEL_REQUEST",
  "E_TOOL_UNKNOWN",
  "E_TOOL_INVALID_ARGS",
  "E_TOOL_DENIED",
  "E_TOOL_TIMEOUT",
  "E_TOOL_FAILED",
  "E_SESSION_PARSE",
  "E_SESSION_MIGRATION",
  "E_RESOURCE_LOAD",
  "E_EXTENSION_LOAD",
  "E_EXTENSION_CRASH",
  "E_COMPACTION_FAILED",
  "E_CANCELLED",
  "E_INTERNAL",
]);

/** Diagnostic entry */
export const DiagnosticEntrySchema = BaseEntrySchema.extend({
  type: z.literal("diagnostic"),
  severity: z.enum(["info", "warning", "error"]),
  code: DiagnosticCodeSchema,
  message: z.string(),
  details: z.record(z.unknown()).optional(),
});

/** Session entry union */
export const SessionEntrySchema = z.discriminatedUnion("type", [
  SessionHeaderEntrySchema,
  MessageEntrySchema,
  CompactionEntrySchema,
  ModelChangeEntrySchema,
  LabelEntrySchema,
  BranchEntrySchema,
  BranchSummaryEntrySchema,
  SessionNameEntrySchema,
  ExtensionEntrySchema,
  DiagnosticEntrySchema,
]);

// ---------------------------------------------------------------------------
// Events (minimal runtime validation where useful)
// ---------------------------------------------------------------------------

export const StopReasonSchema = z.enum([
  "stop",
  "tool_use",
  "max_tokens",
  "length",
  "content_filter",
  "cancelled",
  "error",
]);

/** Model stream events */
export const ModelStreamEventSchema: z.ZodType<ModelStreamEvent> = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text_delta"), delta: z.string() }),
  z.object({ type: z.literal("reasoning_delta"), delta: z.string() }),
  z.object({ type: z.literal("tool_call_delta"), callId: z.string(), delta: z.string() }),
  z.object({ type: z.literal("tool_call_complete"), call: ToolCallBlockSchema }),
  z.object({
    type: z.literal("usage"),
    usage: TokenCountsSchema,
    contextTokens: z.number().int().nonnegative().optional(),
  }),
  z.object({ type: z.literal("finished"), reason: StopReasonSchema }),
]);

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

export function validateSessionEntry(data: unknown): z.infer<typeof SessionEntrySchema> {
  return SessionEntrySchema.parse(data);
}

export function safeValidateSessionEntry(data: unknown): { success: true; data: z.infer<typeof SessionEntrySchema> } | { success: false; error: z.ZodError } {
  const result = SessionEntrySchema.safeParse(data);
  if (result.success) return { success: true, data: result.data };
  return { success: false, error: result.error };
}

export function validateModelStreamEvent(data: unknown): z.infer<typeof ModelStreamEventSchema> {
  return ModelStreamEventSchema.parse(data);
}

export function safeValidateModelStreamEvent(data: unknown): { success: true; data: z.infer<typeof ModelStreamEventSchema> } | { success: false; error: z.ZodError } {
  const result = ModelStreamEventSchema.safeParse(data);
  if (result.success) return { success: true, data: result.data };
  return { success: false, error: result.error };
}
