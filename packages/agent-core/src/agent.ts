import type { EventBus } from "./event-bus.js";
import { ContextBuilder } from "./context-builder.js";
import type { Logger, ModelAdapter, ModelStreamEvent, ChatMessage, TextBlock, ToolResultBlock, ToolCallBlock } from "@kern/protocol";
import { createLogger, nullLogger, AssistantMessageAssembler, getToolCalls, newId, now, serializeError } from "@kern/protocol";
import { SessionManager } from "@kern/session-store";
import { ToolRegistry } from "@kern/tools";

export interface AgentRuntimeOptions {
  model: ModelAdapter;
  tools: ToolRegistry;
  sessions: SessionManager;
  contextBuilder: ContextBuilder;
  events: any;
  logger?: Logger;
}

export class AgentRuntime {
  private readonly model: ModelAdapter;
  private readonly tools: ToolRegistry;
  private readonly sessions: SessionManager;
  private readonly contextBuilder: ContextBuilder;
  private readonly events: any;
  private readonly logger: Logger;
  private turn = 0;

  constructor(options: AgentRuntimeOptions) {
    this.model = options.model;
    this.tools = options.tools;
    this.sessions = options.sessions;
    this.contextBuilder = options.contextBuilder;
    this.events = options.events as any;
    this.logger = options.logger ?? nullLogger;
  }

  async runUserTurn(userText: string): Promise<void> {
    this.events.emit({ type: "agent_start" });
    this.turn = 0;
    try {
      await this.sessions.appendUserMessage(userText);
      while (true) {
        this.turn += 1;
        this.events.emit({ type: "turn_start", turn: this.turn });
        const ctx = await this.contextBuilder.build(this.sessions);
        const request = {
          systemPrompt: ctx.systemPrompt,
          messages: ctx.messages,
          tools: ctx.tools,
          maxOutputTokens: this.model.info.maxOutputTokens,
          signal: new AbortController().signal,
        };
        const assistant = await this.streamModel(request);
        await this.sessions.appendAssistantMessage(assistant);
        const toolCalls = getToolCalls(assistant);
        if (toolCalls.length === 0) {
          this.events.emit({ type: "agent_end", reason: "final_response" });
          this.events.emit({ type: "agent_settled" });
          return;
        }
        for (const call of toolCalls) {
          const toolMsg = await this.executeTool(call);
          await this.sessions.appendToolResult(toolMsg);
        }
      }
    } catch (error) {
      await this.sessions.appendDiagnostic({ severity: "error", code: "E_INTERNAL", message: String(error) });
      this.events.emit({ type: "agent_error", error: serializeError(error) });
      this.events.emit({ type: "agent_settled" });
      throw error;
    }
  }

  private async streamModel(request: any): Promise<ChatMessage> {
    const asm = new AssistantMessageAssembler();
    this.events.emit({ type: "message_start", message: { role: "assistant" } });
    for await (const ev of this.model.stream(request)) {
      switch (ev.type) {
        case "text_delta":
          this.events.emit({ type: "text_delta", delta: ev.delta });
          break;
        case "reasoning_delta":
          this.events.emit({ type: "reasoning_delta", delta: ev.delta });
          break;
        case "tool_call_complete":
          // no event yet; content blocks captured
          break;
        case "usage":
          break;
        case "finished":
          break;
      }
      asm.apply(ev);
    }
    const msg = asm.finalize(now());
    this.events.emit({ type: "message_end", message: msg });
    return msg;
  }

  private async executeTool(call: ToolCallBlock): Promise<ChatMessage> {
    this.events.emit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, arguments: call.arguments });
    const res = await this.tools.execute(call.name, call.arguments, new AbortController().signal);
    const block: ToolResultBlock = { type: "tool_result", toolCallId: call.id, content: res.content, isError: res.isError, details: res.details };
    this.events.emit({ type: "tool_execution_end", toolCallId: call.id, toolName: call.name, isError: res.isError, result: block });
    return { role: "tool", content: [block], timestamp: now() };
  }
}