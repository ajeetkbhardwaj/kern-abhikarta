/**
 * @kern/model — OpenAI-compatible chat completions adapter.
 *
 * Speaks the `POST {baseUrl}/chat/completions` dialect with SSE streaming.
 * This one dialect covers OpenAI, Ollama, LM Studio, vLLM, SGLang, OpenRouter
 * (chat), and most proxies — which is why it is the first and default adapter.
 *
 * Provider quirks are absorbed here so agent-core only sees normalized
 * `ModelStreamEvent`s. All failures throw `KernError.model(...)` with a
 * classified kind for the retry policy.
 */

import type {
  ChatMessage,
  Logger,
  ModelAdapter,
  ModelInfo,
  ModelRequest,
  ModelStreamEvent,
  ModelToolSchema,
  StopReason,
  TokenCounts,
  ToolCallBlock,
} from "@kern/protocol";
import { KernError, nullLogger } from "@kern/protocol";

export interface OpenAIAdapterOptions {
  provider: string;
  modelId: string;
  baseUrl: string;
  apiKey?: string;
  contextWindow: number;
  maxOutputTokens: number;
  temperature?: number;
  supportsThinking?: boolean;
  logger?: Logger;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface SSEChoice {
  delta?: {
    content?: string | null;
    reasoning_content?: string | null;
    tool_calls?: Array<{
      index: number;
      id?: string;
      function?: { name?: string; arguments?: string };
    }>;
  };
  finish_reason?: string | null;
}

interface SSEChunk {
  choices?: SSEChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
  };
}

export function createOpenAIAdapter(options: OpenAIAdapterOptions): ModelAdapter {
  const logger = options.logger ?? nullLogger;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const baseUrl = options.baseUrl.replace(/\/+$/, "");

  const info: ModelInfo = {
    provider: options.provider,
    modelId: options.modelId,
    contextWindow: options.contextWindow,
    maxOutputTokens: options.maxOutputTokens,
    supportsParallelToolCalls: true,
  };
  if (options.supportsThinking !== undefined) info.supportsThinking = options.supportsThinking;

  return {
    info,
    async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
      const ctrl = new AbortController();
      const onAbort = () => ctrl.abort();
      if (request.signal?.aborted) ctrl.abort();
      else request.signal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      if (typeof timer.unref === "function") timer.unref();

      try {
        yield* doStream();
      } finally {
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", onAbort);
      }

      async function* doStream(): AsyncIterable<ModelStreamEvent> {
        const body = toOpenAIBody(request, options);
        let res: Response;
        try {
          res = await fetchImpl(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
            },
            body: JSON.stringify(body),
            signal: ctrl.signal,
          });
        } catch (error) {
          throw toKernError(error, undefined, options);
        }

        if (!res.ok || !res.body) {
          const text = await readErrorBody(res);
          throw toKernError(new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`), res.status, options);
        }

        const pending = new Map<number, { id: string; name: string; args: string }>();
        let finishReason: string | null = null;

        for await (const eventText of sseEvents(res.body)) {
          if (eventText === "[DONE]") break;
          let chunk: SSEChunk;
          try {
            chunk = JSON.parse(eventText) as SSEChunk;
          } catch {
            continue; // blank / keepalive / non-JSON frame
          }
          if (chunk.usage) {
            yield { type: "usage", usage: toTokenCounts(chunk.usage) };
          }
          const choice = chunk.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta;
          if (typeof delta?.content === "string" && delta.content.length > 0) {
            yield { type: "text_delta", delta: delta.content };
          }
          const reasoning = delta?.reasoning_content;
          if (typeof reasoning === "string" && reasoning.length > 0) {
            yield { type: "reasoning_delta", delta: reasoning };
          }
          for (const tc of delta?.tool_calls ?? []) {
            const slot = pending.get(tc.index) ?? { id: "", name: "", args: "" };
            if (tc.id) slot.id = tc.id;
            if (tc.function?.name) slot.name = tc.function.name;
            if (typeof tc.function?.arguments === "string") {
              slot.args += tc.function.arguments;
              yield { type: "tool_call_delta", callId: slot.id || `idx:${tc.index}`, delta: tc.function.arguments };
            }
            pending.set(tc.index, slot);
          }
          if (choice.finish_reason) finishReason = choice.finish_reason;
        }

        for (const [, slot] of [...pending.entries()].sort(([a], [b]) => a - b)) {
          const call: ToolCallBlock = {
            type: "tool_call",
            id: slot.id || `call_${Math.random().toString(36).slice(2, 10)}`,
            name: slot.name,
            arguments: parseArgs(slot.args),
          };
          yield { type: "tool_call_complete", call };
        }
        yield { type: "finished", reason: mapStopReason(finishReason, pending.size > 0) };
      }
    },
  };
}

function toOpenAIBody(request: ModelRequest, options: OpenAIAdapterOptions): Record<string, unknown> {
  return {
    model: options.modelId,
    messages: [{ role: "system", content: request.systemPrompt }, ...request.messages.map(toOpenAIMessage)],
    tools: request.tools.map(toOpenAITool),
    tool_choice: request.tools.length > 0 ? "auto" : undefined,
    stream: true,
    stream_options: { include_usage: true },
    max_completion_tokens: request.maxOutputTokens ?? options.maxOutputTokens,
    temperature: request.temperature ?? options.temperature ?? 0.2,
  };
}

function toOpenAIMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === "tool") {
    const block = message.content.find((b) => b.type === "tool_result");
    return {
      role: "tool",
      tool_call_id: block && block.type === "tool_result" ? block.toolCallId : "",
      content:
        block && block.type === "tool_result"
          ? block.content.map((c) => c.text).join("\n")
          : "",
    };
  }
  const texts: string[] = [];
  const toolCalls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> = [];
  for (const block of message.content) {
    if (block.type === "text") texts.push(block.text);
    else if (block.type === "tool_call") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: {
          name: block.name,
          arguments: typeof block.arguments === "string" ? block.arguments : JSON.stringify(block.arguments ?? {}),
        },
      });
    }
  }
  const out: Record<string, unknown> = { role: message.role, content: texts.join("\n") };
  if (toolCalls.length > 0) out["tool_calls"] = toolCalls;
  return out;
}

function toOpenAITool(tool: ModelToolSchema): Record<string, unknown> {
  return {
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  };
}

function parseArgs(raw: string): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return { _raw: raw }; // malformed JSON still reaches validation as invalid args
  }
}

function toTokenCounts(usage: NonNullable<SSEChunk["usage"]>): TokenCounts {
  const counts: TokenCounts = {
    input: usage.prompt_tokens ?? 0,
    output: usage.completion_tokens ?? 0,
  };
  if (usage.prompt_cache_hit_tokens !== undefined) counts.cacheRead = usage.prompt_cache_hit_tokens;
  if (usage.prompt_cache_miss_tokens !== undefined) counts.cacheWrite = usage.prompt_cache_miss_tokens;
  return counts;
}

function mapStopReason(finish: string | null, hasToolCalls: boolean): StopReason {
  if (hasToolCalls) return "tool_use";
  switch (finish) {
    case "stop":
      return "stop";
    case "tool_calls":
      return "tool_use";
    case "length":
      return "length";
    case "content_filter":
      return "content_filter";
    default:
      return "stop";
  }
}

async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        for (const line of part.split("\n")) {
          const text = line.trim();
          if (text.startsWith("data:")) {
            const payload = text.slice(5).trim();
            if (payload) yield payload;
          }
        }
      }
    }
    const tail = buffer.trim();
    if (tail.startsWith("data:")) {
      const payload = tail.slice(5).trim();
      if (payload) yield payload;
    }
  } finally {
    reader.releaseLock();
  }
}

async function readErrorBody(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return res.statusText;
  }
}

function toKernError(error: unknown, status: number | undefined, options: OpenAIAdapterOptions): KernError {
  if (error instanceof KernError) return error;
  if (error instanceof Error && error.name === "AbortError") {
    return KernError.model("cancelled", "Model request aborted");
  }
  if (status === 401 || status === 403) {
    return KernError.model("auth", `Authentication failed for provider ${options.provider} (HTTP ${status})`, { status });
  }
  if (status === 429) {
    return KernError.model("rate_limit", `Rate limited by provider ${options.provider}`, { status });
  }
  if (status !== undefined && status >= 500) {
    return KernError.model("overloaded", `Provider ${options.provider} unavailable (HTTP ${status})`, { status });
  }
  if (status === 400 || status === 404 || status === 422) {
    return KernError.model("invalid_request", `Invalid request to provider ${options.provider} (HTTP ${status}): ${error instanceof Error ? error.message : String(error)}`, { status });
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed|network/i.test(message)) {
    return KernError.model("network", `Cannot reach ${options.baseUrl}: ${message}`);
  }
  return KernError.model("unknown", `Model call failed: ${message}`);
}
