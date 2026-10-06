import { createLogger, newId, now, type Logger } from "@kern/protocol";
import type { SessionEntry, MessageEntry, CompactionEntry, DiagnosticEntry, LabelEntry, BranchEntry, ExtensionEntry, ModelChangeEntry, ChatMessage } from "@kern/protocol";
import { isMessageEntry, isCompactionEntry } from "@kern/protocol";
import type { SessionStore, SessionFile } from "./jsonl-store.js";

export interface SessionState {
  entries: Map<string, SessionEntry>;
  children: Map<string, string[]>;
  activeLeafId: string;
  headerId: string;
  lastSeq: number;
}

export interface LoadResult {
  filePath: string;
  state: SessionState;
  header: SessionEntry;
}

export class SessionManager {
  private readonly store: SessionStore;
  private readonly logger: Logger;
  private state: SessionState | null = null;
  private filePath: string | null = null;

  constructor(store: SessionStore, logger: Logger = createLogger("info")) {
    this.store = store;
    this.logger = logger;
  }

  static async create(store: SessionStore, cwd: string, meta?: Record<string, unknown>): Promise<SessionManager> {
    const mgr = new SessionManager(store, store["logger"] as Logger ?? createLogger("info"));
    const { filePath, header } = await store.createSession({ cwd, meta });
    mgr.state = {
      entries: new Map([[header.id, header]]),
      children: new Map(),
      activeLeafId: header.id,
      headerId: header.id,
      lastSeq: 0,
    };
    mgr.filePath = filePath;
    return mgr;
  }

  static async resume(store: SessionStore, cwd: string, sessionFile?: string): Promise<SessionManager> {
    const mgr = new SessionManager(store, store["logger"] as Logger ?? createLogger("info"));
    let file: SessionFile | null = null;
    if (sessionFile) {
      file = { filePath: sessionFile, sessionId: "", createdAt: now(), mtimeMs: 0, size: 0 };
    } else {
      file = await store.findMostRecent(cwd);
    }
    if (!file) return SessionManager.create(store, cwd);
    await mgr.loadFromFile(file.filePath);
    return mgr;
  }

  private async loadFromFile(filePath: string): Promise<void> {
    const entries = new Map<string, SessionEntry>();
    const children = new Map<string, string[]>();
    let header: SessionEntry | null = null;
    let lastId: string | null = null;
    for await (const entry of this.store.readAll(filePath)) {
      entries.set(entry.id, entry);
      if (entry.parentId !== null) {
        const arr = children.get(entry.parentId) ?? [];
        if (!arr.includes(entry.id)) arr.push(entry.id);
        children.set(entry.parentId, arr);
      } else {
        header = entry;
      }
      lastId = entry.id;
    }
    if (!header || lastId === null) {
      throw new Error(`Session file missing header: ${filePath}`);
    }
    let lastSeq = 0;
    for (const e of entries.values()) {
      if (typeof e.seq === "number" && e.seq > lastSeq) lastSeq = e.seq;
    }
    this.state = { entries, children, activeLeafId: lastId, headerId: header.id, lastSeq };
    const { validateInvariants } = await import("./invariants.js");
    const inv = validateInvariants(this.state);
    if (!inv.valid) {
      throw new Error(`Session invariants failed: ${inv.errors.join("; ")}`);
    }
    this.filePath = filePath;
    this.logger.info("session_loaded", { filePath, entries: entries.size, leafId: lastId });
  }

  get activeLeafId(): string {
    if (!this.state) throw new Error("SessionManager not initialized");
    return this.state.activeLeafId;
  }

  getEntry(id: string): SessionEntry | undefined {
    if (!this.state) throw new Error("SessionManager not initialized");
    return this.state.entries.get(id);
  }

  getActivePath(): SessionEntry[] {
    if (!this.state) throw new Error("SessionManager not initialized");
    const path: SessionEntry[] = [];
    let currentId: string | null = this.state.activeLeafId;
    const seen = new Set<string>();
    while (currentId !== null && !seen.has(currentId)) {
      seen.add(currentId);
      const entry = this.state.entries.get(currentId);
      if (!entry) break;
      path.push(entry);
      currentId = entry.parentId;
    }
    return path.reverse();
  }

  getActiveMessages(): MessageEntry[] {
    return this.getActivePath().filter(isMessageEntry);
  }

  lastCompaction(): CompactionEntry | null {
    const path = this.getActivePath();
    for (let i = path.length - 1; i >= 0; i--) {
      const e = path[i];
      if (e && isCompactionEntry(e)) return e;
    }
    return null;
  }

  branchTo(targetId: string): void {
    if (!this.state) throw new Error("SessionManager not initialized");
    if (!this.state.entries.has(targetId)) throw new Error(`Unknown entry ${targetId}`);
    this.state.activeLeafId = targetId;
    this.logger.info("session_branch", { targetId });
  }

  private nextSeq(): number {
    if (!this.state) throw new Error("SessionManager not initialized");
    this.state.lastSeq += 1;
    return this.state.lastSeq;
  }

  async appendUserMessage(text: string): Promise<MessageEntry> {
    if (!this.state || !this.filePath) throw new Error("SessionManager not initialized");
    const msg: ChatMessage = { role: "user", content: [{ type: "text", text }], timestamp: now() };
    const parentId = this.state.activeLeafId;
    const entry: MessageEntry = { id: newId("m"), parentId, timestamp: now(), type: "message", message: msg, seq: this.nextSeq() };
    await this.store.append(this.filePath, entry);
    this.state.entries.set(entry.id, entry);
    const arr = this.state.children.get(parentId) ?? [];
    arr.push(entry.id);
    this.state.children.set(parentId, arr);
    this.state.activeLeafId = entry.id;
    return entry;
  }

  async appendAssistantMessage(msg: ChatMessage): Promise<MessageEntry> {
    if (!this.state || !this.filePath) throw new Error("SessionManager not initialized");
    const parentId = this.state.activeLeafId;
    const entry: MessageEntry = { id: newId("m"), parentId, timestamp: now(), type: "message", message: msg, seq: this.nextSeq() };
    await this.store.append(this.filePath, entry);
    this.state.entries.set(entry.id, entry);
    const arr = this.state.children.get(parentId) ?? [];
    arr.push(entry.id);
    this.state.children.set(parentId, arr);
    this.state.activeLeafId = entry.id;
    return entry;
  }

  async appendToolResult(msg: ChatMessage): Promise<MessageEntry> {
    return this.appendAssistantMessage(msg);
  }

  async appendCompaction(summary: string, replacesThroughId: string): Promise<CompactionEntry> {
    if (!this.state || !this.filePath) throw new Error("SessionManager not initialized");
    const parentId = this.state.activeLeafId;
    const entry: CompactionEntry = { id: newId("c"), parentId, timestamp: now(), type: "compaction", summary, replacesThroughId, seq: this.nextSeq() };
    await this.store.append(this.filePath, entry);
    this.state.entries.set(entry.id, entry);
    const arr = this.state.children.get(parentId) ?? [];
    arr.push(entry.id);
    this.state.children.set(parentId, arr);
    this.state.activeLeafId = entry.id;
    return entry;
  }

  async appendDiagnostic(d: Omit<DiagnosticEntry, "id" | "parentId" | "timestamp" | "type" | "seq">): Promise<DiagnosticEntry> {
    if (!this.state || !this.filePath) throw new Error("SessionManager not initialized");
    const parentId = this.state.activeLeafId;
    const entry: DiagnosticEntry = { id: newId("d"), parentId, timestamp: now(), type: "diagnostic", seq: this.nextSeq(), ...d };
    await this.store.append(this.filePath, entry);
    this.state.entries.set(entry.id, entry);
    const arr = this.state.children.get(parentId) ?? [];
    arr.push(entry.id);
    this.state.children.set(parentId, arr);
    this.state.activeLeafId = entry.id;
    return entry;
  }

  async appendModelChange(provider: string, model: string, thinkingLevel?: string): Promise<ModelChangeEntry> {
    if (!this.state || !this.filePath) throw new Error("SessionManager not initialized");
    const parentId = this.state.activeLeafId;
    const entry: ModelChangeEntry = { id: newId("mc"), parentId, timestamp: now(), type: "model_change", provider, model, seq: this.nextSeq() };
    if (thinkingLevel !== undefined) entry.thinkingLevel = thinkingLevel;
    await this.store.append(this.filePath, entry);
    this.state.entries.set(entry.id, entry);
    const arr = this.state.children.get(parentId) ?? [];
    arr.push(entry.id);
    this.state.children.set(parentId, arr);
    this.state.activeLeafId = entry.id;
    return entry;
  }

  async appendBranch(note?: string): Promise<BranchEntry> {
    if (!this.state || !this.filePath) throw new Error("SessionManager not initialized");
    const forkedFromId = this.state.activeLeafId;
    const entry: BranchEntry = { id: newId("b"), parentId: forkedFromId, timestamp: now(), type: "branch", forkedFromId, note, seq: this.nextSeq() };
    await this.store.append(this.filePath, entry);
    this.state.entries.set(entry.id, entry);
    const arr = this.state.children.get(forkedFromId) ?? [];
    arr.push(entry.id);
    this.state.children.set(forkedFromId, arr);
    this.state.activeLeafId = entry.id;
    return entry;
  }
}