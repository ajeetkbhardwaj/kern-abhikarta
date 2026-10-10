/**
 * @kern/protocol — shared contracts.
 *
 * This package has NO dependencies and NO runtime behaviour. It is the single
 * source of truth for the shapes that cross package boundaries: messages,
 * session entries, events, tool contracts, model contracts and errors.
 *
 * Rule: if two packages need to agree on a shape, that shape lives here.
 */

/** Conversation roles. `system` is never persisted as a message entry. */
export type Role = "user" | "assistant" | "tool";

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ReasoningBlock {
  type: "reasoning";
  /** Provider-extracted chain-of-thought. Never required for correctness. */
  text: string;
  signature?: string;
}

export interface ToolCallBlock {
  type: "tool_call";
  /** Provider-assigned id. Unique within one assistant message. */
  id: string;
  name: string;
  arguments?: unknown;
}

export interface ToolResultBlock {
  type: "tool_result";
  /** Discriminator. Present on every ContentBlock so narrowing is uniform. */
  /** Must match a preceding `tool_call` id on the active branch. */
  toolCallId: string;
  content: TextBlock[];
  isError: boolean;
  details?: ToolResultDetails;
}

export type ContentBlock = TextBlock | ReasoningBlock | ToolCallBlock | ToolResultBlock;

export interface ChatMessage {
  role: Role;
  content: ContentBlock[];
  /** ISO-8601. Set by the runtime at persist time, never by the provider. */
  timestamp: string;
}

export interface ToolResultDetails {
  durationMs?: number;
  exitCode?: number;
  truncated?: boolean;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  changedPaths?: string[];
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Session entries — the durable event log
// ---------------------------------------------------------------------------

export const SESSION_ENTRY_VERSION = 1;

export interface BaseEntry {
  /** Unique, monotonic-ish, sortable: <prefix>_<counter>. */
  id: string;
  /** Causal parent. `null` only for the session header. Enables the tree. */
  parentId: string | null;
  /** ISO-8601. */
  timestamp: string;
  /** Monotonic sequence index (assigned on append). */
  seq?: number;
}

export interface SessionHeaderEntry extends BaseEntry {
  type: "session_header";
  version: number;
  sessionId: string;
  cwd: string;
  createdAt: string;
  /** Free-form provenance: pi version, kern version, host application. */
  meta?: Record<string, unknown>;
}

export interface MessageEntry extends BaseEntry {
  type: "message";
  message: ChatMessage;
}

export interface CompactionEntry extends BaseEntry {
  type: "compaction";
  /** Structured checkpoint summary that replaces history up to this entry. */
  summary: string;
  /** The last entry id covered by `summary`. */
  replacesThroughId: string;
  /** Token counts as measured after compaction, if known. */
  tokensAfter?: TokenCounts;
}

export interface ModelChangeEntry extends BaseEntry {
  type: "model_change";
  provider: string;
  model: string;
  thinkingLevel?: string;
}

export interface LabelEntry extends BaseEntry {
  type: "label";
  targetId: string;
  label: string;
}

export interface BranchEntry extends BaseEntry {
  type: "branch";
  /** The entry that became the active leaf before this branch was created. */
  forkedFromId: string;
  note?: string;
}

export interface BranchSummaryEntry extends BaseEntry {
  type: "branch_summary";
  /** The branch being abandoned. */
  fromId: string;
  /** Human-readable summary of the abandoned path. */
  summary: string;
}

export interface SessionNameEntry extends BaseEntry {
  type: "session_name";
  name: string;
}

export interface ExtensionEntry extends BaseEntry {
  type: "extension";
  extensionName: string;
  event: string;
  payload: unknown;
}

export interface DiagnosticEntry extends BaseEntry {
  type: "diagnostic";
  severity: "info" | "warning" | "error";
  code: DiagnosticCode;
  message: string;
  details?: Record<string, unknown>;
}

export type SessionEntry =
  | SessionHeaderEntry
  | MessageEntry
  | CompactionEntry
  | ModelChangeEntry
  | LabelEntry
  | BranchEntry
  | BranchSummaryEntry
  | SessionNameEntry
  | ExtensionEntry
  | DiagnosticEntry;

export type SessionEntryType = SessionEntry["type"];

export type DiagnosticCode =
  | "E_MODEL_AUTH"
  | "E_MODEL_RATE_LIMIT"
  | "E_MODEL_TIMEOUT"
  | "E_MODEL_NETWORK"
  | "E_MODEL_OVERLOADED"
  | "E_CONTEXT_OVERFLOW"
  | "E_MODEL_MALFORMED"
  | "E_MODEL_REQUEST"
  | "E_TOOL_UNKNOWN"
  | "E_TOOL_INVALID_ARGS"
  | "E_TOOL_DENIED"
  | "E_TOOL_TIMEOUT"
  | "E_TOOL_FAILED"
  | "E_SESSION_PARSE"
  | "E_SESSION_MIGRATION"
  | "E_RESOURCE_LOAD"
  | "E_EXTENSION_LOAD"
  | "E_EXTENSION_CRASH"
  | "E_COMPACTION_FAILED"
  | "E_CANCELLED"
  | "E_INTERNAL";

export function isMessageEntry(entry: SessionEntry): entry is MessageEntry {
  return entry.type === "message";
}

export function isCompactionEntry(entry: SessionEntry): entry is CompactionEntry {
  return entry.type === "compaction";
}

export function isBranchSummaryEntry(entry: SessionEntry): entry is BranchSummaryEntry {
  return entry.type === "branch_summary";
}

export function isSessionNameEntry(entry: SessionEntry): entry is SessionNameEntry {
  return entry.type === "session_name";
}

// ---------------------------------------------------------------------------
// Token accounting
// ---------------------------------------------------------------------------

export interface TokenCounts {
  input: number;
  output: number;
  /** Prompt tokens served from provider cache. Part of context occupancy. */
  cacheRead?: number;
  /** Prompt tokens written to provider cache. Part of context occupancy. */
  cacheWrite?: number;
}

/**
 * Total tokens the provider will consider "in context" on the next call.
 * Cache reads/writes are billed differently but still occupy the window,
 * so Pi-style accounting sums all four fields.
 */
export function totalContextTokens(usage: TokenCounts): number {
  return usage.input + usage.output + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
}

// ---------------------------------------------------------------------------
// Events — the observation surface (TUI, extensions, RPC, logging)
// ---------------------------------------------------------------------------

export type AgentEvent =
  | { type: "session_start"; sessionId: string; sessionFile?: string }
  | { type: "turn_start"; turn: number }
  | { type: "message_start"; message: { role: Role } }
  | { type: "text_delta"; delta: string }
  | { type: "reasoning_delta"; delta: string }
  | { type: "message_end"; message: ChatMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; arguments: unknown }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; delta: string }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; isError: boolean; result?: ToolResultBlock }
  | { type: "auto_compaction_start"; phase: CompactionPhase }
  | { type: "auto_compaction_end"; summary: string; replacedThroughId: string }
  | { type: "auto_retry_start"; attempt: number; reason: string; delayMs: number }
  | { type: "auto_retry_end"; attempt: number; success: boolean; reason?: string }
  | { type: "agent_start" }
  | { type: "agent_end"; reason: "final_response" | "aborted" | "queued_work_remaining" }
  | { type: "agent_error"; error: SerializedError }
  | { type: "agent_settled" }
  | { type: "session_diagnostic"; diagnostic: DiagnosticEntry };

export type CompactionPhase = "before_prompt" | "after_agent_end";

export type AgentEventType = AgentEvent["type"];

export type Unsubscribe = () => void;

export type AgentEventListener = (event: AgentEvent) => void;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export interface SerializedError {
  name: string;
  message: string;
  code: DiagnosticCode;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export type ModelErrorKind =
  | "auth"
  | "rate_limit"
  | "timeout"
  | "network"
  | "overloaded"
  | "context_length"
  | "invalid_request"
  | "malformed_response"
  | "cancelled"
  | "unknown";

const RETRYABLE_MODEL_KINDS: ReadonlySet<ModelErrorKind> = new Set([
  "rate_limit",
  "timeout",
  "network",
  "overloaded",
  "invalid_request",
  "malformed_response",
]);

export function isRetryableModelError(kind: ModelErrorKind): boolean {
  return RETRYABLE_MODEL_KINDS.has(kind);
}

export function classifyModelError(error: unknown): ModelErrorKind {
  if (error instanceof KernError && error.kind) return error.kind;
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (/unauthorized|forbidden|401|invalid api key|auth/i.test(message)) return "auth";
    if (/429|rate limit|too many requests/i.test(message)) return "rate_limit";
    if (/timeout|timed out|econnreset|esockettimedout|deadline exceeded/i.test(message)) return "timeout";
    if (/network|fetch failed|econnrefused|enotfound|socket hang up|dns|reset by peer|connection refused/i.test(message)) return "network";
    if (/overloaded|temporarily unavailable|service unavailable|bad gateway|gateway timeout|503|504/i.test(message)) return "overloaded";
    if (/context.*(length|window)|token.*limit|maximum context|too many tokens/i.test(message)) return "context_length";
    if (/invalid request|400|bad request|malformed.*request|unsupported.*parameter/i.test(message)) return "invalid_request";
    if (/malformed|parse.*json|unexpected token|invalid json|response.*format/i.test(message)) return "malformed_response";
    if (/abort|cancelled|aborted/i.test(message)) return "cancelled";
  }
  return "unknown";
}

const DIAGNOSTIC_BY_MODEL_KIND: Record<ModelErrorKind, DiagnosticCode> = {
  auth: "E_MODEL_AUTH",
  rate_limit: "E_MODEL_RATE_LIMIT",
  timeout: "E_MODEL_TIMEOUT",
  network: "E_MODEL_NETWORK",
  overloaded: "E_MODEL_OVERLOADED",
  context_length: "E_CONTEXT_OVERFLOW",
  invalid_request: "E_MODEL_REQUEST",
  malformed_response: "E_MODEL_MALFORMED",
  cancelled: "E_CANCELLED",
  unknown: "E_INTERNAL",
};

export function diagnosticCodeForModelError(kind: ModelErrorKind): DiagnosticCode {
  return DIAGNOSTIC_BY_MODEL_KIND[kind];
}

/**
 * The one error type that crosses package boundaries. Anything thrown inside a
 * tool, adapter or store is normalized into this before it escapes the runtime.
 */
export class KernError extends Error {
  readonly code: DiagnosticCode;
  readonly retryable: boolean;
  readonly kind?: ModelErrorKind;
  readonly details?: Record<string, unknown>;

  constructor(
    code: DiagnosticCode,
    message: string,
    options: { retryable?: boolean; kind?: ModelErrorKind; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "KernError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    if (options.kind !== undefined) this.kind = options.kind;
    if (options.details !== undefined) this.details = options.details;
  }

  static model(kind: ModelErrorKind, message: string, details?: Record<string, unknown>): KernError {
    return new KernError(diagnosticCodeForModelError(kind), message, {
      kind,
      retryable: isRetryableModelError(kind),
      details,
    });
  }

  static cancelled(message = "Operation cancelled"): KernError {
    return new KernError("E_CANCELLED", message, { kind: "cancelled" });
  }

  serialize(): SerializedError {
    const out: SerializedError = {
      name: this.name,
      message: this.message,
      code: this.code,
      retryable: this.retryable,
    };
    if (this.details) out.details = this.details;
    return out;
  }
}

export function serializeError(error: unknown): SerializedError {
  if (error instanceof KernError) return error.serialize();
  if (error instanceof Error) {
    return { name: error.name, message: error.message, code: "E_INTERNAL", retryable: false };
  }
  return { name: "Error", message: String(error), code: "E_INTERNAL", retryable: false };
}