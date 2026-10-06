import type { EventBus } from "./event-bus.js";
import { ContextBuilder } from "./context-builder.js";
import { Compactor } from "./compaction.js";
import { BudgetTracker, type BudgetLimits } from "./budgets.js";
import { withRetry, DEFAULT_RETRY_CONFIG, type RetryConfig } from "./retry.js";
import type {
  Logger,
  ModelAdapter,
  ChatMessage,
  ToolResultBlock,
  ToolCallBlock,
  ModelErrorKind,
  CompactionPhase,
} from "@kern/protocol";
import {
  nullLogger,
  AssistantMessageAssembler,
  getToolCalls,
  now,
  serializeError,
  KernError,
} from "@kern/protocol";
import { SessionManager } from "@kern/session-store";
import { ToolRegistry } from "@kern/tools";

export interface AgentRuntimeOptions {
  model: ModelAdapter;
  tools: ToolRegistry;
  sessions: SessionManager;
  contextBuilder: ContextBuilder;
  events: EventBus;
  logger?: Logger;
  budgets?: Partial<BudgetLimits>;
  compactor?: Compactor | null;
  retry?: RetryConfig;
  /** Called when policy demands approval. Absent = deny. */
  requestApproval?: (prompt: string) => Promise<boolean>;
}

export interface RunTurnOptions {
  signal?: AbortSignal;
}

export class AgentRuntime {
  private model: ModelAdapter;
  private readonly tools: ToolRegistry;
  private readonly sessions: SessionManager;
  private readonly contextBuilder: ContextBuilder;
  private readonly events: EventBus;
  private readonly logger: Logger;
  private readonly budgets: BudgetTracker;
  private readonly compactor: Compactor | null;
  private readonly retry: RetryConfig;
  private readonly requestApproval?: (prompt: string) => Promise<boolean>;
  private turn = 0;

  constructor(options: AgentRuntimeOptions) {
    this.model = options.model;
    this.tools = options.tools;
    this.sessions = options.sessions;
    this.contextBuilder = options.contextBuilder;
    this.events = options.events;
    this.logger = options.logger ?? nullLogger;
    this.budgets = new BudgetTracker(options.budgets ?? {});
    this.compactor = options.compactor === undefined ? new Compactor({ logger: this.logger }) : options.compactor;
    this.retry = options.retry ?? DEFAULT_RETRY_CONFIG;
    if (options.requestApproval !== undefined) this.requestApproval = options.requestApproval;
  }

  budgetUsage() {
    return this.budgets.usage();
  }

  /** Hot-swap the model adapter mid-session (drives `/model`). Persisted. */
  async setModel(adapter: ModelAdapter): Promise<void> {
    this.model = adapter;
    await this.sessions.appendModelChange(adapter.info.provider, adapter.info.modelId);
    this.logger.info("model_switched", { provider: adapter.info.provider, model: adapter.info.modelId });
  }

  /** Manual compaction (e.g. `/compact`). Independent of the auto gate. */
  async compact(instructions?: string, signal?: AbortSignal): Promise<{ summary: string; replacesThroughId: string }> {
    if (!this.compactor) throw new Error("Compaction is disabled for this session");
    this.throwIfAborted(signal);
    this.events.emit({ type: "auto_compaction_start", phase: "before_prompt" });
    try {
      const result = await this.compactor.compact(this.sessions, this.model, instructions);
      this.throwIfAborted(signal);
      await this.sessions.appendCompaction(result.summary, result.replacesThroughId);
      this.events.emit({ type: "auto_compaction_end", summary: result.summary, replacedThroughId: result.replacesThroughId });
      return result;
    } catch (error) {
      const serialized = serializeError(error);
      await this.sessions.appendDiagnostic({
        severity: "error",
        code: "E_COMPACTION_FAILED",
        message: `Manual compaction failed: ${serialized.message}`,
        details: serialized.details,
      });
      throw error;
    }
  }

  async runUserTurn(userText: string, opts: RunTurnOptions = {}): Promise<void> {
    const signal = opts.signal;
    this.throwIfAborted(signal);
    this.events.emit({ type: "agent_start" });
    this.turn = 0;
    try {
      await this.sessions.appendUserMessage(userText);
      await this.ensureCompactIfNeeded("before_prompt", signal);

      while (true) {
        this.throwIfAborted(signal);
        this.turn += 1;
        this.budgets.checkTurn(this.turn);
        this.events.emit({ type: "turn_start", turn: this.turn });

        const ctx = await this.contextBuilder.build(this.sessions);
        const request = {
          systemPrompt: ctx.systemPrompt,
          messages: ctx.messages,
          tools: ctx.tools,
          maxOutputTokens: this.model.info.maxOutputTokens,
          signal,
        };
        const assistant = await this.streamModel(request, signal);
        this.throwIfAborted(signal);
        await this.sessions.appendAssistantMessage(assistant);

        const toolCalls = getToolCalls(assistant);
        if (toolCalls.length === 0) {
          this.events.emit({ type: "agent_end", reason: "final_response" });
          await this.ensureCompactIfNeeded("after_agent_end", signal);
          this.events.emit({ type: "agent_settled" });
          return;
        }
        this.budgets.checkToolBatch(toolCalls.length);
        for (const call of toolCalls) {
          this.throwIfAborted(signal);
          const toolMsg = await this.executeTool(call, signal);
          this.throwIfAborted(signal);
          await this.sessions.appendToolResult(toolMsg);
        }
        this.budgets.recordToolCalls(toolCalls.length);
      }
    } catch (error) {
      if (isCancelled(error, signal)) {
        await this.sessions.appendDiagnostic({
          severity: "warning",
          code: "E_CANCELLED",
          message: "Turn aborted by user",
        });
        this.events.emit({ type: "agent_end", reason: "aborted" });
        this.events.emit({ type: "agent_settled" });
        return;
      }
      const serialized = serializeError(error);
      await this.sessions.appendDiagnostic({
        severity: "error",
        code: serialized.code,
        message: serialized.message,
        details: serialized.details,
      });
      this.events.emit({ type: "agent_error", error: serialized });
      this.events.emit({ type: "agent_settled" });
      throw error;
    }
  }

  private async ensureCompactIfNeeded(phase: CompactionPhase, signal?: AbortSignal): Promise<void> {
    if (!this.compactor) return;
    const snapshot = await this.contextBuilder.build(this.sessions);
    const decision = this.compactor.evaluate(snapshot, this.model.info.contextWindow);
    if (!decision.shouldCompact) return;
    this.events.emit({ type: "auto_compaction_start", phase });
    try {
      const { summary, replacesThroughId } = await this.compactor.compact(this.sessions, this.model);
      this.throwIfAborted(signal);
      await this.sessions.appendCompaction(summary, replacesThroughId);
      this.events.emit({ type: "auto_compaction_end", summary, replacedThroughId: replacesThroughId });
    } catch (error) {
      const serialized = serializeError(error);
      await this.sessions.appendDiagnostic({
        severity: "error",
        code: "E_COMPACTION_FAILED",
        message: `Compaction failed (${phase}): ${serialized.message}`,
        details: serialized.details,
      });
      // Fail open here: keep existing context rather than aborting the turn.
      this.logger.warn("compaction_failed", { phase, error: serialized.message });
    }
  }

  private async streamModel(request: Parameters<ModelAdapter["stream"]>[0], signal?: AbortSignal): Promise<ChatMessage> {
    return withRetry(
      async () => {
        const assembler = new AssistantMessageAssembler();
        this.events.emit({ type: "message_start", message: { role: "assistant" } });
        for await (const event of this.model.stream(request)) {
          this.throwIfAborted(signal);
          switch (event.type) {
            case "text_delta":
              this.events.emit({ type: "text_delta", delta: event.delta });
              break;
            case "reasoning_delta":
              this.events.emit({ type: "reasoning_delta", delta: event.delta });
              break;
            case "tool_call_complete":
            case "tool_call_delta":
            case "usage":
            case "finished":
              break;
          }
          assembler.apply(event);
        }
        const message = assembler.finalize(now());
        this.events.emit({ type: "message_end", message });
        return message;
      },
      classifyError,
      this.retry,
      {
        onRetry: (attempt, kind, delayMs) => {
          this.events.emit({ type: "auto_retry_start", attempt, reason: kind, delayMs });
        },
        onSettled: (attempt, success) => {
          if (!success) return;
          // Only emit the end marker if at least one retry happened.
          if (attempt > 1) this.events.emit({ type: "auto_retry_end", attempt, success });
        },
      },
    );
  }

  private async executeTool(call: ToolCallBlock, signal?: AbortSignal): Promise<ChatMessage> {
    this.events.emit({
      type: "tool_execution_start",
      toolCallId: call.id,
      toolName: call.name,
      arguments: call.arguments,
    });
    const effectiveSignal = signal ?? new AbortController().signal;
    const result = await this.tools.execute(call.name, call.arguments, effectiveSignal, {
      origin: "model",
      requestApproval: this.requestApproval,
    });
    const block: ToolResultBlock = {
      type: "tool_result",
      toolCallId: call.id,
      content: result.content,
      isError: result.isError,
      details: result.details,
    };
    this.events.emit({
      type: "tool_execution_end",
      toolCallId: call.id,
      toolName: call.name,
      isError: result.isError,
      result: block,
    });
    return { role: "tool", content: [block], timestamp: now() };
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw KernError.cancelled();
  }
}

function classifyError(error: unknown): ModelErrorKind {
  if (error instanceof KernError && error.kind) return error.kind;
  if (error instanceof Error && error.name === "AbortError") return "cancelled";
  return "unknown";
}

function isCancelled(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (error instanceof KernError && error.code === "E_CANCELLED") return true;
  if (error instanceof Error && error.name === "AbortError") return true;
  return false;
}
