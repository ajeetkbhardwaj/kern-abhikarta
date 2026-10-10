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

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
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
  /** Human-friendly label for pickers (falls back to the provider key). */
  displayName?: string;
  /** Model ids to hide (applied after whitelist, to configured + live ids). */
  blacklist?: string[];
  /** When non-empty, only these model ids are shown (configured + live). */
  whitelist?: string[];
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

export const PROVIDER_PRESETS: Array<{ name: string; baseUrl: string; apiKeyEnv: string; hint: string }> = [
  { name: "openai", baseUrl: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY", hint: "cloud · key required" },
  { name: "openrouter", baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY", hint: "cloud · key required" },
  { name: "ollama", baseUrl: "http://localhost:11434/v1", apiKeyEnv: "", hint: "local · no key" },
  { name: "lmstudio", baseUrl: "http://localhost:1234/v1", apiKeyEnv: "", hint: "local · no key" },
  { name: "llamacpp", baseUrl: "http://localhost:8080/v1", apiKeyEnv: "", hint: "local · llama-server, no key" },
  { name: "nvidia", baseUrl: "https://integrate.api.nvidia.com/v1", apiKeyEnv: "NVIDIA_API_KEY", hint: "cloud · key required" },
];

export function userModelsFile(): string {
  return join(homedir(), ".kern", "models.json");
}

export interface ProviderAuth {
  apiKey?: string;
}

export function authFilePath(): string {
  return join(homedir(), ".kern", "auth.json");
}

function lastUsedFilePath(): string {
  return join(homedir(), ".kern", "last-used.json");
}

/** Process-local cache so resolveApiKey doesn't re-read auth.json per call. */
let authCache: Record<string, ProviderAuth> | null = null;

/** Missing file → `{}`; corrupt JSON throws E_RESOURCE_LOAD. */
export async function loadAuth(): Promise<Record<string, ProviderAuth>> {
  const path = authFilePath();
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return {};
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new KernError("E_RESOURCE_LOAD", `Invalid JSON in ${path}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new KernError("E_RESOURCE_LOAD", `Invalid JSON in ${path}`);
  }
  return parsed as Record<string, ProviderAuth>;
}

/** Merge one key into ~/.kern/auth.json (dir 0700, file 0600). */
export async function saveAuthKey(provider: string, apiKey: string): Promise<void> {
  await mkdir(join(homedir(), ".kern"), { recursive: true, mode: 0o700 });
  let existing: Record<string, ProviderAuth> = {};
  try {
    existing = await loadAuth();
  } catch {
    existing = {};
  }
  const next = { ...existing, [provider]: { ...(existing[provider] ?? {}), apiKey } };
  const path = authFilePath();
  await writeFile(path, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  try {
    await chmod(path, 0o600);
  } catch {
    // best effort (non-POSIX fs)
  }
  authCache = next;
}

export async function clearAuthKey(provider: string): Promise<void> {
  let existing: Record<string, ProviderAuth> = {};
  try {
    existing = await loadAuth();
  } catch {
    existing = {};
  }
  if (!(provider in existing)) {
    authCache = existing;
    return;
  }
  const next = { ...existing };
  delete next[provider];
  await mkdir(join(homedir(), ".kern"), { recursive: true, mode: 0o700 });
  const path = authFilePath();
  await writeFile(path, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  try {
    await chmod(path, 0o600);
  } catch {
    // best effort (non-POSIX fs)
  }
  authCache = next;
}

export async function recordLastUsed(provider: string, model: string): Promise<void> {
  await mkdir(join(homedir(), ".kern"), { recursive: true, mode: 0o700 });
  const path = lastUsedFilePath();
  await writeFile(path, JSON.stringify({ provider, model }) + "\n", { mode: 0o600 });
  try {
    await chmod(path, 0o600);
  } catch {
    // best effort (non-POSIX fs)
  }
}

export async function readLastUsed(): Promise<{ provider: string; model: string } | null> {
  let text: string;
  try {
    text = await readFile(lastUsedFilePath(), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as { provider?: unknown; model?: unknown };
    if (typeof parsed?.provider !== "string" || typeof parsed?.model !== "string") return null;
    return { provider: parsed.provider, model: parsed.model };
  } catch {
    return null;
  }
}

/** Test a base URL + key, returning friendly failures (never throws raw). */
export async function testProvider(
  baseUrl: string,
  apiKey: string | undefined,
  options?: ListModelsOptions,
): Promise<{ ok: true; models: string[] } | { ok: false; message: string }> {
  const opts = options ?? {};
  const timeoutS = Math.round((opts.timeoutMs ?? 10_000) / 1000);
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(normalized)) {
    return { ok: false, message: `Bad URL ${JSON.stringify(baseUrl)} — must start with http:// or https://.` };
  }
  try {
    const models = await listRemoteModels(normalized, apiKey, { timeoutMs: 10_000, ...opts });
    if (models.length === 0) {
      return {
        ok: false,
        message: `Unexpected response body from ${normalized} (no models listed). You can still add a model id manually.`,
      };
    }
    return { ok: true, models };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (/ENOTFOUND|ECONNREFUSED|EHOSTUNREACH/i.test(msg)) {
      return { ok: false, message: `Can't reach ${normalized}. Is the server running?` };
    }
    const status = msg.match(/HTTP (401|403)\b/)?.[1];
    if (status === "401" || status === "403") {
      return { ok: false, message: `Key rejected (HTTP ${status}). Check the key, $VAR, or command output.` };
    }
    if (/abort|timeout|timed out/i.test(msg)) {
      return { ok: false, message: `Timed out after ${timeoutS}s — behind a proxy/VPN, or wrong host?` };
    }
    if (/not valid JSON|unexpected token|unexpected end|\bparse\b/i.test(msg)) {
      return {
        ok: false,
        message: `Unexpected response body from ${normalized} (${msg.slice(0, 120)}). You can still add a model id manually.`,
      };
    }
    return { ok: false, message: msg.slice(0, 200) };
  }
}

export function maskKey(raw: string): string {
  const t = raw.trim();
  if (t.startsWith("!") || t.startsWith("$")) return t;
  if (t.length <= 8) return "••••";
  return `${t.slice(0, 3)}…${t.slice(-4)}`;
}

/**
 * Save (or replace) one provider in ~/.kern/models.json. Creates ~/.kern
 * (0700). Literal secrets are NEVER written here — a literal `apiKey` is
 * moved to ~/.kern/auth.json (0600) via saveAuthKey; only `!command` /
 * `$VAR` references stay in the models file. Masks keys in the returned
 * summary — never log raw secrets.
 */
export async function saveProviderToUserFile(
  name: string,
  cfg: ProviderConfig,
  opts?: { makeDefault?: boolean },
): Promise<{ path: string; summary: string }> {
  if (!/^[a-z0-9.-]{1,32}$/.test(name)) {
    throw new KernError("E_MODEL_REQUEST", `Bad provider name ${JSON.stringify(name)} — use [a-z0-9.-], max 32 chars.`);
  }
  if (!/^https?:\/\//i.test(cfg.baseUrl.trim())) {
    throw new KernError("E_MODEL_REQUEST", `Bad baseUrl ${JSON.stringify(cfg.baseUrl)}.`);
  }
  const { apiKey: rawKey, ...rest } = cfg;
  const trimmed = rawKey?.trim() ?? "";
  const isReference = trimmed.startsWith("!") || trimmed.startsWith("$");
  const storedCfg: ProviderConfig = { ...rest };
  let keyNote: string;
  if (rawKey !== undefined && trimmed !== "" && !isReference) {
    await saveAuthKey(name, trimmed);
    keyNote = `key ${maskKey(trimmed)} (stored in auth.json)`;
  } else if (rawKey !== undefined && isReference) {
    storedCfg.apiKey = rawKey;
    keyNote = `key ${maskKey(rawKey)}`;
  } else {
    keyNote = cfg.apiKeyEnv ? `env ${cfg.apiKeyEnv}` : "no key";
  }
  const path = userModelsFile();
  await mkdir(join(homedir(), ".kern"), { recursive: true, mode: 0o700 });
  let file: ModelsFile = {};
  try {
    file = JSON.parse(await readFile(path, "utf8")) as ModelsFile;
  } catch {
    file = {};
  }
  file.providers = { ...(file.providers ?? {}), [name]: storedCfg };
  if (opts?.makeDefault) {
    file.defaultProvider = name;
    const first = storedCfg.models?.[0]?.id;
    if (first) file.defaultModel = first;
  }
  await writeFile(path, JSON.stringify(file, null, 2) + "\n");
  return { path, summary: `${name} → ${cfg.baseUrl} (${keyNote})` };
}

const WELL_KNOWN: Record<string, { baseUrl: string; apiKeyEnv: string }> = {
  openai: { baseUrl: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY" },
  ollama: { baseUrl: "http://localhost:11434/v1", apiKeyEnv: "" },
  lmstudio: { baseUrl: "http://localhost:1234/v1", apiKeyEnv: "" },
  nvidia: { baseUrl: "https://integrate.api.nvidia.com/v1", apiKeyEnv: "NVIDIA_API_KEY" },
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
 * Credential precedence: explicit arg > auth.json entry > `!command` /
 * `$VAR` / literal in config > provider env var > loopback-localhost
 * without a key.
 */
export async function resolveApiKey(
  providerName: string,
  cfg: ProviderConfig,
  explicit?: string,
): Promise<string | undefined> {
  if (explicit) return explicit;
  if (!authCache) {
    try {
      authCache = await loadAuth();
    } catch {
      authCache = {};
    }
  }
  const stored = authCache[providerName]?.apiKey;
  if (stored) return stored;
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
 * can show-but-disable them (Pi's rule). A provider's whitelist (when
 * non-empty) narrows the id set first, then its blacklist removes ids —
 * applied to both configured and live ids.
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
    const configuredById = new Map(configured.map((m) => [m.id, m]));
    const seen = new Set<string>();
    for (const id of applyModelFilters([...configuredById.keys()], cfg)) {
      const m = configuredById.get(id);
      if (!m) continue;
      seen.add(id);
      out.push({
        provider: name,
        id: m.id,
        contextWindow: m.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
        source: "configured",
        authenticated: key !== undefined || isLoopback(baseUrl),
      });
    }
    for (const id of applyModelFilters(live, cfg)) {
      if (seen.has(id)) continue;
      out.push({ provider: name, id, contextWindow: DEFAULT_CONTEXT_WINDOW, source: "live", authenticated: key !== undefined || isLoopback(baseUrl) });
    }
  }
  return out;
}

/** Whitelist narrows first, then blacklist removes. Empty whitelist = no narrowing. */
function applyModelFilters(ids: string[], cfg: ProviderConfig): string[] {
  let out = ids;
  if (cfg.whitelist && cfg.whitelist.length > 0) {
    const allow = new Set(cfg.whitelist);
    out = out.filter((id) => allow.has(id));
  }
  if (cfg.blacklist && cfg.blacklist.length > 0) {
    const deny = new Set(cfg.blacklist);
    out = out.filter((id) => !deny.has(id));
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

export async function createModelRuntime(
  file: ModelsFile,
  input: SelectionInput = {},
  logger: Logger = nullLogger,
): Promise<ModelAdapter> {
  const providerName = input.provider ?? file.defaultProvider;
  const modelId = input.model ?? file.defaultModel;

  if (providerName && modelId) {
    return createAdapterFor(file, providerName, modelId, input, logger);
  }

  if (input.baseUrl && modelId) {
    const provider = providerName ?? "custom";
    const key = await resolveApiKey(provider, { baseUrl: input.baseUrl }, input.apiKey);
    return createOpenAIAdapter({
      provider,
      modelId,
      baseUrl: input.baseUrl,
      apiKey: key,
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      maxOutputTokens: DEFAULT_MAX_OUTPUT,
      logger,
    });
  }

  throw new KernError("E_MODEL_REQUEST", "No model selected. Provide --provider/--model or a baseUrl + model.");
}
