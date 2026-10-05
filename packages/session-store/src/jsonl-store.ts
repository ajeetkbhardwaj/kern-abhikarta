import { createLogger, newId, newSessionId, now, type Logger } from "@kern/protocol";
import type { SessionEntry, SessionHeaderEntry, MessageEntry, CompactionEntry, DiagnosticEntry, LabelEntry, BranchEntry, ExtensionEntry, ModelChangeEntry } from "@kern/protocol";
import { SESSION_ENTRY_VERSION } from "@kern/protocol";
import { mkdir, readFile, appendFile, stat, readdir, writeFile } from "node:fs/promises";
import { join, dirname, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { existsSync, createReadStream } from "node:fs";
import { createInterface } from "node:readline";

export interface SessionStoreOptions {
  /** Override default storage root (~/.kern/agent/sessions) */
  storageRoot?: string;
  /** Override session directory layout mapping (defaults to cwd path encoding). */
  sessionDirEncoder?: (cwd: string) => string;
  logger?: Logger;
}

export interface CreateSessionOptions {
  cwd: string;
  meta?: Record<string, unknown>;
}

export interface LoadSessionOptions {
  cwd: string;
  sessionId?: string;
  recent?: boolean;
}

export interface SessionFile {
  filePath: string;
  sessionId: string;
  createdAt: string;
  mtimeMs: number;
  size: number;
}

export interface SessionManifestEntry {
  filePath: string;
  sessionId: string;
  createdAt: string;
  mtimeMs: number;
  size: number;
  cwd: string;
  leafId?: string;
}

export class SessionStore {
  private readonly storageRoot: string;
  private readonly logger: Logger;
  private readonly sessionDirEncoder: (cwd: string) => string;

  constructor(options: SessionStoreOptions = {}) {
    this.storageRoot = options.storageRoot ?? join(homedir(), ".kern", "agent", "sessions");
    this.logger = options.logger ?? createLogger("info");
    this.sessionDirEncoder = options.sessionDirEncoder ?? encodeSessionDir;
  }

  async ensureRoot(): Promise<void> {
    await mkdir(this.storageRoot, { recursive: true });
  }

  sessionDirFor(cwd: string): string {
    const encoded = this.sessionDirEncoder(cwd);
    return join(this.storageRoot, encoded);
  }

  async createSession(options: CreateSessionOptions): Promise<{ filePath: string; header: SessionHeaderEntry }> {
    const { cwd, meta } = options;
    const sessionId = newSessionId();
    const createdAt = now();
    const dir = this.sessionDirFor(cwd);
    await mkdir(dir, { recursive: true });
    const fileName = `${createdAt.replace(/[:.]/g, "")}_${sessionId}.jsonl`;
    const filePath = join(dir, fileName);
    const header: SessionHeaderEntry = {
      id: "root",
      parentId: null,
      timestamp: createdAt,
      type: "session_header",
      version: SESSION_ENTRY_VERSION,
      sessionId,
      cwd,
      createdAt,
      meta,
    };
    await appendJsonl(filePath, header);
    this.logger.info("session_created", { sessionId, filePath, cwd });
    return { filePath, header };
  }

  async append(filePath: string, entry: SessionEntry): Promise<void> {
    await appendJsonl(filePath, entry);
  }

  async *readAll(filePath: string): AsyncIterable<SessionEntry> {
    if (!existsSync(filePath)) return;
    const stream = createReadStream(filePath, { encoding: "utf8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        const parsed = JSON.parse(trimmed) as SessionEntry;
        yield parsed;
      } catch (error) {
        this.logger.warn("jsonl_malformed_line", { filePath, error });
        continue;
      }
    }
  }

  async listSessions(cwd: string, options: { limit?: number } = {}): Promise<SessionFile[]> {
    const dir = this.sessionDirFor(cwd);
    try {
      const names = await readdir(dir);
    } catch {
      return [];
    }
    const names = await readdir(dir).catch(() => []);
    const files: SessionFile[] = [];
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const filePath = join(dir, name);
      const st = await stat(filePath).catch(() => null);
      if (!st || !st.isFile()) continue;
      const sid = extractSessionId(name);
      const sessionId = sid === null || sid === undefined ? "" : sid;
      const createdAtRaw = extractCreatedAt(name);
      const createdAt = createdAtRaw === null ? st.mtime.toISOString() : createdAtRaw;
      const sid2 = extractSessionId(name);
      const sessionIdOut = sid2 === null ? "" : sid2;
      files.push({ filePath, sessionId: sessionIdOut, createdAt, mtimeMs: st.mtimeMs, size: st.size });
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    if (options.limit) return files.slice(0, options.limit);
    return files;
  }

  async findMostRecent(cwd: string): Promise<SessionFile | null> {
    const list = await this.listSessions(cwd, { limit: 1 });
    return list[0] ?? null;
  }
}

async function appendJsonl(filePath: string, entry: SessionEntry): Promise<void> {
  const line = JSON.stringify(entry) + "\n";
  await mkdir(dirname(filePath), { recursive: true });
  await appendFile(filePath, line, { encoding: "utf8" });
}

function encodeSessionDir(cwd: string): string {
  const abs = resolve(cwd);
  if (abs.startsWith(homedir())) {
    const rel = relative(homedir(), abs).replaceAll(sep, "-");
    return rel.length === 0 ? "-home" : `-home-${rel.replaceAll(/[^A-Za-z0-9._-]/g, "-")}`;
  }
  return abs.replaceAll(sep, "-").replaceAll(/[^A-Za-z0-9._-]/g, "-") || "-root";
}

function extractSessionId(name: string): string | null {
  const m = name.match(/_(s_[a-f0-9]{12})\.jsonl$/);
  if (!m) return null;
  const s = m[1];
  return s ?? null;
}

function extractCreatedAt(name: string): string | null {
  const m = name.match(/^(\d{8}T\d{6}Z)_/);
  if (!m) return null;
  const s = m[1];
  if (!s) return null;
  return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,11)}:${s.slice(11,13)}:${s.slice(13,15)}.000Z`;
}