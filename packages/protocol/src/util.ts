/**
 * @kern/protocol — ids, clock, logging, secret redaction.
 * Tiny utilities every package needs; no domain knowledge lives here.
 */

import { randomBytes } from "node:crypto";

const counters = new Map<string, number>();

/**
 * Short, sortable, human-readable id: `m_0017`, `tc_3`.
 * Sortability comes from the zero-padded counter, not from the clock.
 */
export function newId(prefix: string): string {
  const next = (counters.get(prefix) ?? 0) + 1;
  counters.set(prefix, next);
  return `${prefix}_${String(next).padStart(4, "0")}`;
}

export function resetIdCounters(): void {
  counters.clear();
}

export function newSessionId(): string {
  return `s_${randomBytes(6).toString("hex")}`;
}

export function now(): string {
  return new Date().toISOString();
}

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Logs go to stderr. stdout is reserved for machine-readable output (json/rpc). */
export interface Logger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(level: LogLevel = "info", sink: (line: string) => void = (l) => process.stderr.write(l + "\n")): Logger {
  const enabled = LEVEL_ORDER[level];
  const emit = (lvl: LogLevel, message: string, data?: unknown) => {
    if (LEVEL_ORDER[lvl] < enabled) return;
    const payload = data === undefined ? "" : ` ${JSON.stringify(data, jsonReplacer)}`;
    sink(`${now()} ${lvl.toUpperCase().padEnd(5)} ${message}${payload}`);
  };
  return {
    debug: (m, d) => emit("debug", m, d),
    info: (m, d) => emit("info", m, d),
    warn: (m, d) => emit("warn", m, d),
    error: (m, d) => emit("error", m, d),
  };
}

export const nullLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Survives circular structures instead of throwing inside a logger. */
export function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) return { name: value.name, message: value.message };
  return value;
}

// ---------------------------------------------------------------------------
// Secret redaction — applied before anything is persisted or sent to a model
// ---------------------------------------------------------------------------

interface RedactionRule {
  pattern: RegExp;
  replacement: string;
}

const REDACTION_RULES: RedactionRule[] = [
  { pattern: /\b(sk-[A-Za-z0-9_-]{16,})\b/g, replacement: "[REDACTED:api-key]" },
  { pattern: /\b(gh[pousr]_[A-Za-z0-9]{20,})\b/g, replacement: "[REDACTED:github-token]" },
  { pattern: /\b(AKIA[0-9A-Z]{16})\b/g, replacement: "[REDACTED:aws-key]" },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replacement: "[REDACTED:private-key]" },
  { pattern: /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g, replacement: "[REDACTED:slack-token]" },
  { pattern: /((?:api[_-]?key|secret|password|passwd|token)["']?\s*[:=]\s*)["'][^"']{6,}["']/gi, replacement: "$1[REDACTED]" },
  { pattern: /(\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b)/g, replacement: "[REDACTED:email]" },
];

/** Paths never echoed into logs or tool results. */
export const SENSITIVE_PATHS: RegExp[] = [
  /(?:^|\/)\.ssh\//,
  /(?:^|\/)\.aws\//,
  /(?:^|\/)id_(?:rsa|dsa|ecdsa|ed25519)$/,
  /(?:^|\/)\.npmrc$/,
  /(?:^|\/)\.netrc$/,
  /(?:^|\/)\.env(?:\.|$)/,
  /(?:\.pem|\.key|\.p12|\.pfx)$/,
];

export function isSensitivePath(path: string): boolean {
  return SENSITIVE_PATHS.some((re) => re.test(path));
}

export function redact(text: string): string {
  let out = text;
  for (const rule of REDACTION_RULES) out = out.replace(rule.pattern, rule.replacement);
  return out;
}