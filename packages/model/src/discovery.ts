/**
 * @kern/model — provider configuration + model auto-discovery.
 *
 * One config shape covers cloud and local endpoints because both speak the
 * OpenAI-compatible dialect:
 *
 * - Cloud: `baseUrl: https://api.openai.com/v1` + API key.
 * - Local: `baseUrl: http://localhost:11434/v1` (Ollama), LM Studio, vLLM…
 *   key optional for plain-http loopback.
 *
 * Discovery is `GET {baseUrl}/models` (the standard OpenAI endpoint every
 * compatible server implements). The TUI `/model` picker lists the union of
 * configured models and live-discovered ids; only entries with resolvable
 * credentials are selectable — same rule as Pi.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { KernError, type Logger } from "@kern/protocol";
import { nullLogger } from "@kern/protocol";
import { createOpenAIAdapter } from "./openai.js";
import type { ModelAdapter } from "@kern/protocol";

export interface ModelEntry {
  id: string;
  contextWindow?: number;
  maxOutputTokens?: number;
}

export interface ProviderConfig {
  baseUrl: string;
  api?: "openai-completions";
  /** Literal key, `$NAME` env interpolation, or leading `!command`. */
  apiKey?: string;
  /** Env var holding the key (default per well-known provider). */
  apiKeyEnv?: string;
  models?: ModelEntry[];
}

export interface ModelsFile {
  providers?: Record<string, ProviderConfig>;
  defaultProvider?: string;
  defaultModel?: string;
}

export interface DiscoveredModel {
  provider: string;
  id: string;
  contextWindow: number;
  source: "configured" | "live";
  authenticated: boolean;
}

export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_OUTPUT = 4_000;

const WELL_KNOWN: Record<string, { baseUrl: string; apiKeyEnv: string }> = {
  openai: { baseUrl: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY" },
  ollama: { baseUrl: "http://localhost:11434/v1", apiKeyEnv: "" },
  lmstudio: { baseUrl: "http://localhost:1234/v1", apiKeyEnv: "" },
};

export function modelsFilePaths(cwd: string): string[] {
  return [join(homedir(), ".kern", "models.json"), join(cwd, ".kern", "models.json")];
}

/** Later files override earlier ones per provider; model lists merge by id. */
export async function loadModelsFile(cwd: string): Promise<ModelsFile> {
  const merged: ModelsFile = {};
  for (const path of modelsFilePaths(cwd)) {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      continue;
    }
    let parsed: ModelsFile;
    try {
      parsed = JSON.parse(text) as ModelsFile;
    } catch {
      throw new KernError("E_RESOURCE_LOAD", `Invalid JSON in ${path}`);
    }
    if (parsed.defaultProvider !== undefined) merged.defaultProvider = parsed.defaultProvider;
    if (parsed.defaultModel !== undefined) merged.defaultModel = parsed.defaultModel;
    for (const [name, cfg] of Object.entries(parsed.providers ?? {})) {
      const prev = merged.providers?.[name];
      merged.providers = { ...merged.providers, [name]: mergeProvider(prev, cfg) };
    }
  }
  return merged;
}

function mergeProvider(prev: ProviderConfig | undefined, next: ProviderConfig): ProviderConfig {
  if (!prev) return next;
  const models = [...(prev.models ?? [])];
  for (const m of next.models ?? []) {
    const i = models.findIndex((x) => x.id === m.id);
    if (i >= 0) models[i] = m;
    else models.push(m);
  }
  return { ...prev, ...next, models };
}

/**
 * Credential precedence: explicit arg > `!command` / `$VAR` / literal in
 * config > provider env var > loopback-localhost without a key.
 */
export async function resolveApiKey(
  providerName: string,
  cfg: ProviderConfig,
  explicit?: string,
): Promise<string | undefined> {
  if (explicit) return explicit;
  if (cfg.apiKey) {
    const raw = cfg.apiKey.trim();
    if (raw.startsWith("!")) {
      const { execFile } = await import("node:child_process");
      const cmd = raw.slice(1);
      return await new Promise<string>((resolve, reject) => {
        execFile("sh", ["-c", cmd], { timeout: 10_000 }, (err, stdout) => {
          if (err) reject(new KernError("E_MODEL_AUTH", `Credential command failed for provider ${providerName}`));
          else resolve(stdout.trim());
        });
      });
    }
    const interpolated = raw.replace(/\$([A-Za-z_][A-Za-z0-9_]*)|\$\{([^}]+)\}/g, (_, a: string, b: string) => {
      return process.env[a ?? b] ?? "";
    });
    if (interpolated) return interpolated;
  }
  const envName = cfg.apiKeyEnv ?? WELL_KNOWN[providerName]?.apiKeyEnv ?? "";
  if (envName) {
    const fromEnv = process.env[envName];
    if (fromEnv) return fromEnv;
  }
  if (isLoopback(cfg.baseUrl)) return undefined; // local servers ignore keys
  return undefined;
}

function isLoopback(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

export interface ListModelsOptions {
  timeoutMs?: number;
  logger?: Logger;
  fetchImpl?: typeof fetch;
}

/** `GET {baseUrl}/models` — implemented by every OpenAI-compatible server. */
export async function listRemoteModels(
  baseUrl: string,
  apiKey: string | undefined,
  options: ListModelsOptions = {},
): Promise<string[]> {
  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), options.timeoutMs ?? 10_000);
  if (typeof timer.unref === "function") timer.unref();
  try {
    const doFetch = options.fetchImpl ?? fetch;
    const res = await doFetch(url, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: ctrl.signal,
    });
    if (!res.ok) {
      throw new KernError("E_MODEL_NETWORK", `Model list failed (HTTP ${res.status}) for ${url}`, {
        details: { status: res.status },
      });
    }
    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    return (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string");
  } catch (error) {
    if (error instanceof KernError) throw error;
    throw new KernError("E_MODEL_NETWORK", `Cannot reach ${url}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

export interface SelectionInput {
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
}

/**
 * Union configured + live models across providers. Entries without
 * resolvable credentials are marked `authenticated: false` so the picker
 * can show-but-disable them (Pi's rule).
 */
export async function discoverModels(
  file: ModelsFile,
  input: SelectionInput = {},
  options: ListModelsOptions = {},
): Promise<DiscoveredModel[]> {
  const logger = options.logger ?? nullLogger;
  const names = input.provider ? [input.provider] : Object.keys(file.providers ?? {});
  const out: DiscoveredModel[] = [];
  for (const name of names) {
    const cfg = file.providers?.[name];
    if (!cfg) continue;
    const baseUrl = input.baseUrl ?? cfg.baseUrl;
    let key: string | undefined;
    try {
      key = await resolveApiKey(name, { ...cfg, baseUrl }, input.apiKey);
    } catch (error) {
      logger.warn("credential_resolve_failed", { provider: name });
      key = undefined;
    }
    const configured = cfg.models ?? [];
    let live: string[] = [];
    try {
      live = await listRemoteModels(baseUrl, key, options);
    } catch (error) {
      logger.warn("model_discovery_failed", { provider: name, error: String(error) });
    }
    const seen = new Set<string>();
    for (const m of configured) {
      seen.add(m.id);
      out.push({
        provider: name,
        id: m.id,
        contextWindow: m.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
        source: "configured",
        authenticated: key !== undefined || isLoopback(baseUrl),
      });
    }
    for (const id of live) {
      if (seen.has(id)) continue;
      out.push({ provider: name, id, contextWindow: DEFAULT_CONTEXT_WINDOW, source: "live", authenticated: key !== undefined || isLoopback(baseUrl) });
    }
  }
  return out;
}

/** Build a streaming adapter for one selected model. */
export async function createAdapterFor(
  file: ModelsFile,
  providerName: string,
  modelId: string,
  input: SelectionInput = {},
  logger: Logger = nullLogger,
): Promise<ModelAdapter> {
  const cfg = file.providers?.[providerName];
  if (!cfg) throw new KernError("E_MODEL_REQUEST", `Unknown provider: ${providerName}`);
  const baseUrl = input.baseUrl ?? cfg.baseUrl;
  const key = await resolveApiKey(providerName, { ...cfg, baseUrl }, input.apiKey);
  const entry = cfg.models?.find((m) => m.id === modelId);
  return createOpenAIAdapter({
    provider: providerName,
    modelId,
    baseUrl,
    apiKey: key,
    contextWindow: entry?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxOutputTokens: entry?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT,
    logger,
  });
}
