/**
 * @kern/model — OpenAI-compatible chat-completions adapter.
 *
 * Works against OpenAI, NVIDIA (`https://integrate.api.nvidia.com/v1`),
 * and any local OpenAI-compatible server (llama.cpp, vLLM, Ollama, …).
 * Zero dependencies: uses global fetch + manual SSE parsing.
 */

import type {
  ChatMessage,
  Logger,
  ModelAdapter,
  ModelInfo,
  ModelRequest,
  ModelStreamEvent,
  StopReason,
  TokenCounts,
} from "@kern/protocol";
import { KernError, nullLogger } from "@kern/protocol";

export interface OpenAICompatibleOptions {
  apiKey: string;
  baseURL: string;
  model: string;
  /** Label shown in diagnostics (nvidia, openai, local, …). */
  providerLabel?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  temperature?: number;
  /** Passed as `reasoning_budget` when the endpoint supports it (e.g. NVIDIA). */
  reasoningBudget?: number;
  /** Passed as `chat_template_kwargs.enable_thinking` (e.g. NVIDIA). */
  enableThinking?: boolean;
  /** Extra body fields merged into every chat-completions request. */
  extraBody?: Record<string, unknown>;
  logger?: Logger;
}

export interface ResolvedModelConfig extends OpenAICompatibleOptions {
  source: string;
}

const DEFAULT_CONTEXT_WINDOW = 128_000;

function trimURL(baseURL: string): string {
  return baseURL.replace(/\/+$/, "");
}

/**
 * Resolve model configuration from explicit flags, then environment.
 * Returns null when no API key is available (caller falls back to fake).
 *
 * Env: KERN_MODEL, KERN_API_KEY / OPENAI_API_KEY / NVIDIA_API_KEY,
 *      KERN_BASE_URL / OPENAI_BASE_URL, KERN_CONTEXT_WINDOW.
 */
export function resolveModelConfig(flags: {
  model?: string;
  apiKey?: string;
  baseURL?: string;
  contextWindow?: number;
} = {}): ResolvedModelConfig | null {
  const apiKey = flags.apiKey ?? process.env["KERN_API_KEY"] ?? process.env["OPENAI_API_KEY"] ?? process.env["NVIDIA_API_KEY"];
  if (!apiKey) return null;
  const baseURL = flags.baseURL ?? process.env["KERN_BASE_URL"] ?? process.env["OPENAI_BASE_URL"] ?? "https://api.openai.com/v1";
  const model = flags.model ?? process.env["KERN_MODEL"] ?? "";
  if (!model) return null;
  const contextWindow =
    flags.contextWindow ?? (process.env["KERN_CONTEXT_WINDOW"] ? Number(process.env["KERN_CONTEXT_WINDOW"]) : NaN);
  return {
    apiKey,
    baseURL: trimURL(baseURL),
    model,
    providerLabel: inferLabel(baseURL),
    contextWindow: Number.isFinite(contextWindow) && (contextWindow as number) > 0 ? (contextWindow as number) : DEFAULT_CONTEXT_WINDOW,
    source: flags.model ? "flag" : "env",
  };
}

function inferLabel(baseURL: string): string {
  if (baseURL.includes("integrate.api.nvidia.com")) return "nvidia";
  if (baseURL.includes("api.openai.com")) return "openai";
  if (/localhost|127\.0\.0\.1|0\.0\.0\.0|192\.168\.|10\./.test(baseURL)) return "local";
  try {
    return new URL(baseURL).hostname;
  } catch {
    return "openai-compatible";
  }
}

/** List model ids via GET {baseURL}/models (drives `/model` selection). */
export async function listModels(apiKey: string, baseURL: string, signal?: AbortSignal): Promise<string[]> {
  let response: Response;
  try {
    response = await fetch(`${trimURL(baseURL)}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal,
    });
  } catch (error) {
    throw toKernError(error, "listing models");
  }
  if (!response.ok) {
    throw await httpToKernError(response, "listing models");
  }
  const body = (await response.json()) as { data?: Array<{ id?: string }> };
  const ids = (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string");
  return [...new Set(ids)].sort();
}

export class OpenAICompatibleAdapter implements ModelAdapter {
  readonly info: ModelInfo;
  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly temperature?: number;
  private readonly reasoningBudget?: number;
  private readonly enableThinking?: boolean;
  private readonly extraBody: Record<string, unknown>;
  private readonly logger: Logger;

  constructor(options: OpenAICompatibleOptions) {
    this.apiKey = options.apiKey;
    this.baseURL = trimURL(options.baseURL);
    this.temperature = options.temperature;
    this.reasoningBudget = options.reasoningBudget;
    this.enableThinking = options.enableThinking;
    this.extraBody = options.extraBody ?? {};
    this.logger = options.logger ?? nullLogger;
    const info: ModelInfo = {
      provider: options.providerLabel ?? inferLabel(this.baseURL),
      modelId: options.model,
      contextWindow: options.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      maxOutputTokens: options.maxOutputTokens ?? 4096,
      supportsThinking: options.reasoningBudget !== undefined || options.enableThinking !== undefined,
      supportsParallelToolCalls: true,
    };
    this.info = info;
  }

  /** Re-target the adapter at another model id (used by `/model`). */
  withModel(modelId: string): OpenAICompatibleAdapter {
    return new OpenAICompatibleAdapter({
      apiKey: this.apiKey,
      baseURL: this.baseURL,
      model: modelId,
      providerLabel: this.info.provider,
      contextWindow: this.info.contextWindow,
      maxOutputTokens: this.info.maxOutputTokens,
      temperature: this.temperature,
      reasoningBudget: this.reasoningBudget,
      enableThinking: this.enableThinking,
      extraBody: this.extraBody,
      logger: this.logger,
    });
  }

  get credentials(): { apiKey: string; baseURL: string } {
    return { apiKey: this.apiKey, baseURL: this.baseURL };
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const body = this.buildBody(request);
    let response: Response;
    try {
      response = await fetch(`${this.baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: request.signal,
      });
    } catch (error) {
      throw toKernError(error, "sending request", request.signal);
    }
    if (!response.ok || !response.body) {
      throw await httpToKernError(response, "chat completion");
    }

    const pending = new Map<number, { id: string; name: string; args: string }>();
    const indexToId = new Map<number, string>();
    let sawToolCall = false;
    let finishReason: string | null = null;

    interface WireChoice {
      delta?: {
        content?: string | null;
        reasoning_content?: string | null;
        tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
      };
      finish_reason?: string | null;
    }
    interface WireChunk {
      choices?: WireChoice[];
      usage?: Record<string, unknown>;
    }

    try {
      for await (const raw of readSSE(response.body)) {
        if (request.signal?.aborted) throw KernError.cancelled();
        const chunk = raw as WireChunk;
        const choice = chunk.choices?.[0];
        const delta = choice?.delta;
        if (!delta) {
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          const chunkUsage = readUsage(chunk);
          if (chunkUsage) yield { type: "usage", usage: chunkUsage.usage, contextTokens: chunkUsage.total };
          continue;
        }
        if (typeof delta.content === "string" && delta.content.length > 0) {
          yield { type: "text_delta", delta: delta.content };
        }
        if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
          yield { type: "reasoning_delta", delta: delta.reasoning_content };
        }
        for (const tc of delta.tool_calls ?? []) {
          const index = tc.index ?? 0;
          let slot = pending.get(index);
          if (!slot) {
            slot = { id: tc.id ?? `call_${index}`, name: tc.function?.name ?? "", args: "" };
            pending.set(index, slot);
            indexToId.set(index, slot.id);
          }
          if (tc.id) {
            slot.id = tc.id;
            indexToId.set(index, tc.id);
          }
          if (tc.function?.name) slot.name = tc.function.name;
          if (typeof tc.function?.arguments === "string" && tc.function.arguments.length > 0) {
            slot.args += tc.function.arguments;
            yield { type: "tool_call_delta", callId: slot.id, delta: tc.function.arguments };
          }
        }
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        const chunkUsage = readUsage(chunk);
        if (chunkUsage) yield { type: "usage", usage: chunkUsage.usage, contextTokens: chunkUsage.total };
      }
    } catch (error) {
      if (request.signal?.aborted) throw KernError.cancelled();
      throw toKernError(error, "reading stream", request.signal);
    }

    for (const [, slot] of [...pending.entries()].sort(([a], [b]) => a - b)) {
      sawToolCall = true;
      yield {
        type: "tool_call_complete",
        call: { type: "tool_call", id: slot.id, name: slot.name, arguments: parseArgs(slot.args) },
      };
    }
    yield { type: "finished", reason: mapStopReason(finishReason, sawToolCall) };
  }

  private buildBody(request: ModelRequest): Record<string, unknown> {
    const messages: Record<string, unknown>[] = [{ role: "system", content: request.systemPrompt }];
    for (const message of request.messages) {
      const converted = convertMessage(message);
      if (converted) messages.push(converted);
    }
    const body: Record<string, unknown> = {
      model: this.info.modelId,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      ...this.extraBody,
    };
    if (request.tools.length > 0) {
      body["tools"] = request.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      }));
    }
    const maxTokens = request.maxOutputTokens ?? this.info.maxOutputTokens;
    if (maxTokens) body["max_tokens"] = maxTokens;
    if (request.temperature ?? this.temperature) body["temperature"] = request.temperature ?? this.temperature;
    const budget = this.reasoningBudget ?? thinkingToBudget(request.thinkingLevel);
    if (budget) body["reasoning_budget"] = budget;
    if (this.enableThinking !== undefined) body["chat_template_kwargs"] = { enable_thinking: this.enableThinking };
    return body;
  }
}

function thinkingToBudget(level: ModelRequest["thinkingLevel"]): number | undefined {
  switch (level) {
    case "low":
      return 2048;
    case "medium":
      return 8192;
    case "high":
      return 16384;
    default:
      return undefined;
  }
}

function convertMessage(message: ChatMessage): Record<string, unknown> | null {
  if (message.role === "user") {
    const text = message.content
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    return { role: "user", content: text };
  }
  if (message.role === "assistant") {
    const text = message.content
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    const toolCalls = message.content.filter((b) => b.type === "tool_call");
    const out: Record<string, unknown> = { role: "assistant", content: text };
    if (toolCalls.length > 0) {
      out["tool_calls"] = toolCalls.map((b) => {
        const call = b.type === "tool_call" ? b : null;
        return {
          id: call?.id ?? "",
          type: "function",
          function: {
            name: call?.name ?? "",
            arguments: typeof call?.arguments === "string" ? call.arguments : JSON.stringify(call?.arguments ?? {}),
          },
        };
      });
    }
    return out;
  }
  // role === "tool": one wire message per tool result block.
  // Kern never merges multiple results into one message on send; the loop
  // appends one tool message per call, but defensively handle several.
  const results = message.content.filter((b) => b.type === "tool_result");
  if (results.length === 0) return null;
  if (results.length === 1) {
    const r = results[0]!;
    if (r.type !== "tool_result") return null;
    return {
      role: "tool",
      tool_call_id: r.toolCallId,
      content: r.content.map((c) => c.text).join(""),
    };
  }
  // Multiple results: providers accept only one tool message per call id,
  // so keep the first and fold the rest in as extra text (rare path).
  const first = results[0]!;
  if (first.type !== "tool_result") return null;
  const extra = results
    .slice(1)
    .filter((b) => b.type === "tool_result")
    .map((b) => (b.type === "tool_result" ? b.content.map((c) => c.text).join("") : ""))
    .join("\n");
  return {
    role: "tool",
    tool_call_id: first.toolCallId,
    content: first.content.map((c) => c.text).join("") + (extra ? `\n${extra}` : ""),
  };
}

function parseArgs(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    // Malformed args: pass through so the tool layer rejects with a
    // structured E_TOOL_INVALID_ARGS the model can recover from.
    return trimmed;
  }
}

function mapStopReason(finish: string | null, sawToolCall: boolean): StopReason {
  if (sawToolCall || finish === "tool_calls") return "tool_use";
  switch (finish) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "content_filter":
      return "content_filter";
    default:
      return finish === null ? "stop" : "error";
  }
}

function readUsage(chunk: { usage?: Record<string, unknown> }): { usage: TokenCounts; total: number } | null {
  const u = chunk.usage;
  if (!u || typeof u !== "object") return null;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);
  const details = u["prompt_tokens_details"] as Record<string, unknown> | undefined;
  const usage: TokenCounts = {
    input: num(u["prompt_tokens"]),
    output: num(u["completion_tokens"]),
  };
  const cached = details && num(details["cached_tokens"]);
  if (cached) usage.cacheRead = cached;
  const total = num(u["total_tokens"]) || usage.input + usage.output + (usage.cacheRead ?? 0);
  return { usage, total };
}

async function* readSSE(body: ReadableStream<Uint8Array>): AsyncIterable<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      if (done) break;
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") return;
        if (!payload) continue;
        try {
          yield JSON.parse(payload) as Record<string, unknown>;
        } catch {
          // Skip malformed SSE lines; the stream carries on.
        }
      }
    }
    const tail = (buffer + decoder.decode()).trim();
    if (tail.startsWith("data:")) {
      const payload = tail.slice(5).trim();
      if (payload && payload !== "[DONE]") {
        try {
          yield JSON.parse(payload) as Record<string, unknown>;
        } catch {
          // ignore trailing garbage
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function toKernError(error: unknown, phase: string, signal?: AbortSignal): KernError {
  if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
    return KernError.cancelled();
  }
  if (error instanceof KernError) return error;
  if (error instanceof TypeError) {
    // fetch throws TypeError on DNS/refused/timeout at connect.
    return KernError.model("network", `Network error ${phase}: ${error.message}`);
  }
  if (error instanceof Error) {
    return KernError.model("unknown", `Error ${phase}: ${error.message}`);
  }
  return KernError.model("unknown", `Error ${phase}: ${String(error)}`);
}

async function httpToKernError(response: Response, phase: string): Promise<KernError> {
  const status = response.status;
  let detail = "";
  let retryAfterMs: number | undefined;
  try {
    detail = (await response.text()).slice(0, 2000);
  } catch {
    detail = "";
  }
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs)) retryAfterMs = secs * 1000;
  }
  const details: Record<string, unknown> = { status };
  if (detail) details["body"] = detail;
  if (retryAfterMs !== undefined) details["retryAfterMs"] = retryAfterMs;

  if (status === 401 || status === 403) {
    return KernError.model("auth", `Authentication failed ${phase} (HTTP ${status}). Check your API key.`, details);
  }
  if (status === 429) {
    return KernError.model("rate_limit", `Rate limited ${phase} (HTTP 429).`, details);
  }
  if (status === 408) {
    return KernError.model("timeout", `Request timed out ${phase} (HTTP 408).`, details);
  }
  if (status >= 500) {
    return KernError.model("overloaded", `Provider error ${phase} (HTTP ${status}).`, details);
  }
  if (status === 400 && /context|too long|maximum|tokens/i.test(detail)) {
    return KernError.model("context_length", `Context too long ${phase}: ${detail}`, details);
  }
  return KernError.model("invalid_request", `Request failed ${phase} (HTTP ${status}): ${detail}`, details);
}
