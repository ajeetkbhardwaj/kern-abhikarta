import { AgentRuntime, ContextBuilder, EventBus, Compactor, ResourceLoader, buildResourceSection } from "@kern/agent-core";
import { SessionManager, SessionStore } from "@kern/session-store";
import {
  ToolRegistry,
  createReadTool,
  createWriteTool,
  createEditTool,
  createBashTool,
  DefaultPolicy,
  DEFAULT_POLICY_CONFIG,
  type PolicyConfig,
} from "@kern/tools";
import { createLogger, type Logger, type ModelAdapter, type ModelInfo, type AgentEventListener, type ToolResult, type ThinkingLevel } from "@kern/protocol";
import type { BudgetLimits, ContextUsage } from "@kern/agent-core";
import { RepoIndex } from "@kern/repo-index";
import { SymbolStore } from "@kern/symbol-store";
import { SemanticSearch } from "@kern/semantic-search";
import { ProjectMemory, ProjectMemoryStore } from "@kern/project-memory";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SettingsManager } from "./settings.js";

export interface CreateAgentSessionOptions {
  cwd: string;
  logger?: Logger;
  storageRoot?: string;
  /** Policy controls. Conservative defaults apply when omitted. */
  policy?: Partial<PolicyConfig>;
  /** Resource budgets. Conservative defaults apply when omitted. */
  budgets?: Partial<BudgetLimits>;
  /** Approval callback for write/exec/destructive ops. Absent = deny. */
  requestApproval?: (prompt: string, meta?: import("@kern/tools").ApprovalMeta) => Promise<boolean | "session">;
  /** Load AGENTS.md + skill catalog into the system prompt. Default true. */
  loadResources?: boolean;
  /** Compact automatically at safe boundaries. Default true. */
  enableCompaction?: boolean;
  /** Inject a real model adapter. Defaults to a no-op fake (final response). */
  model?: ModelAdapter;
  /** Default reasoning mode for the active model. */
  thinkingLevel?: ThinkingLevel;
  /** Resume the most recent session instead of creating a new one. */
  resume?: boolean;
}

export interface AgentSession {
  prompt(text: string, opts?: { signal?: AbortSignal }): Promise<void>;
  subscribe(listener: AgentEventListener): () => void;
  budgetUsage(): { turns: number; totalToolCalls: number; wallTimeMs: number };
  isBusy(): boolean;
  setModel(adapter: ModelAdapter): Promise<void>;
  modelInfo(): ModelInfo;
  /** Current reasoning mode for the active model. */
  thinkingMode(): ThinkingLevel;
  setThinkingLevel(level: ThinkingLevel): Promise<void>;
  /** Manual compaction. Resolves null when there is nothing to compact. */
  compact(instructions?: string): Promise<{ summary: string; replacesThroughId: string } | null>;
  /** Token usage of the most recent context build. */
  contextUsage(): ContextUsage | null;
  approvalMode(): string;
  setApprovalMode(mode: "ask" | "never" | "auto-allowlist"): boolean;
  allowToolForSession(toolName: string): boolean;
  toolNames(): string[];
  callToolAsUser(name: string, args: unknown, signal?: AbortSignal): Promise<ToolResult>;
  dispose(): void;
  isDisposed(): boolean;
  sessionName(): string | null;
  activeLeafId?(): string | null;
  setSessionName?(name: string): Promise<string | null>;
  deleteSession?(): Promise<boolean>;
  steeredPrompt?(text: string, opts?: { signal?: AbortSignal }): Promise<void>;
  followUp?(text: string, opts?: { signal?: AbortSignal }): Promise<void>;
  newSession?(): Promise<{ session: AgentSession; manager: SessionManager }>;
  switchSession?(file: string): Promise<{ session: AgentSession; manager: SessionManager }>;
  fork?(entryId?: string): Promise<{ session: AgentSession; manager: SessionManager }>;
  importFromJsonl?(filePath: string): Promise<{ session: AgentSession; manager: SessionManager }>;
  branchSummary?(fromId: string, summary: string): Promise<string | null>;
  listSessions?(): Promise<string[]>;
}

export interface AgentSessionRuntime {
  session: AgentSession;
  manager: SessionManager;
}

export interface SessionRuntimeOps {
  newSession(): Promise<AgentSessionRuntime>;
  switchSession(file: string): Promise<AgentSessionRuntime>;
  fork(entryId?: string): Promise<AgentSessionRuntime>;
  importFromJsonl(filePath: string): Promise<AgentSessionRuntime>;
}

export async function createAgentSession(
  options: CreateAgentSessionOptions,
): Promise<{ session: AgentSession; manager: SessionManager }> {

  const settings = await SettingsManager.load(options.cwd);
  const effectiveProps: CreateAgentSessionOptions = {
    ...options,
    policy: { ...(settings.policy ?? {}), ...(options.policy ?? {}) },
    budgets: { ...(settings.budgets ?? {}), ...(options.budgets ?? {}) },
    thinkingLevel: options.thinkingLevel ?? settings.thinkingLevel ?? "medium",
  };
  return createSessionRuntime(effectiveProps);
}

async function createSessionRuntime(options: CreateAgentSessionOptions): Promise<{ session: AgentSession; manager: SessionManager }> {
  const logger = options.logger ?? createLogger("info");
  const policyConfig = { ...DEFAULT_POLICY_CONFIG, ...(options.policy ?? {}) };
  const store = new SessionStore({ storageRoot: options.storageRoot, logger });
  const manager = options.resume
    ? await SessionManager.resume(store, options.cwd)
    : await SessionManager.create(store, options.cwd);

  return buildSessionWithRuntime(options, manager, logger);
}

async function buildSessionWithRuntime(
  options: CreateAgentSessionOptions,
  manager: SessionManager,
  logger: Logger,
): Promise<{ session: AgentSession; manager: SessionManager }> {
  const policyConfig = { ...DEFAULT_POLICY_CONFIG, ...(options.policy ?? {}) };
  const policy = new DefaultPolicy(policyConfig);
  const tools = new ToolRegistry({
    workspaceRoot: options.cwd,
    policy,
    maxToolMs: 120_000,
    requestApproval: options.requestApproval,
  });
  tools.register(createReadTool(options.cwd));
  tools.register(createWriteTool(options.cwd));
  tools.register(createEditTool(options.cwd));
  tools.register(createBashTool(options.cwd));

  const events = new EventBus(logger);

  const repoIndex = new RepoIndex({ root: options.cwd });
  const symbolStore = new SymbolStore(repoIndex);
  const semanticSearch = new SemanticSearch(repoIndex, symbolStore);
  const projectMemory = new ProjectMemory(new ProjectMemoryStore({ root: options.cwd }));
  const repoResolver = async (query: string): Promise<import("@kern/agent-core").RepoAwareContext> => {
    const intent = {
      query,
      fileHints: query.split(/\s+/).filter((part) => part.length > 2),
      symbolHints: query.split(/\s+/).filter((part) => /[A-Z]/.test(part) || part.includes("-") || part.includes("_")),
    };
    const hits = await semanticSearch.retrieve(intent);
    const notes = await projectMemory.search(query);
    return {
      query,
      likelyFiles: hits.slice(0, 8).map((hit) => hit.path),
      relevantSymbols: [...new Set(hits.flatMap((hit) => hit.symbolMatches ?? []))].slice(0, 12),
      projectNotes: notes.slice(0, 5).map((note) => `${note.type}: ${note.content}`),
    };
  };

  const contextBuilder = new ContextBuilder({
    baseSystemPrompt: "You are Kern, a minimal coding agent. Use tools when needed.",
    toolRegistry: tools,
    logger,
    repoResolver,
  });

  if (options.loadResources !== false) {
    const loader = new ResourceLoader({ logger });
    const project = await loader.load(options.cwd);
    for (const diagnostic of project.diagnostics) {
      logger.warn("resource_diagnostic", { diagnostic });
    }
    const section = buildResourceSection(project);
    if (section) contextBuilder.setSystemExtra(section);
  }

  const model = options.model ?? createFakeModel();
  const runtime = new AgentRuntime({
    model,
    tools,
    sessions: manager,
    contextBuilder,
    events,
    logger,
    budgets: options.budgets,
    compactor: options.enableCompaction === false ? null : new Compactor({ logger }),
    defaultThinkingLevel: options.thinkingLevel ?? "medium",
    requestApproval: options.requestApproval,
  });

  const session: AgentSession = {
    prompt: (text, opts) => runtime.runUserTurn(text, opts ?? {}),
    subscribe: (l) => events.subscribe(l),
    budgetUsage: () => runtime.budgetUsage(),
    isBusy: () => runtime.isBusy(),
    setModel: (adapter) => runtime.setModel(adapter),
    modelInfo: () => runtime.modelInfo(),
    thinkingMode: () => runtime.thinkingMode(),
    setThinkingLevel: (level) => runtime.setThinkingLevel(level),
    compact: (instructions) => runtime.compactNow(instructions),
    contextUsage: () => runtime.contextUsage(),
    approvalMode: () => runtime.approvalMode(),
    setApprovalMode: (mode) => runtime.setApprovalMode(mode),
    allowToolForSession: (toolName) => runtime.allowToolForSession(toolName),
    toolNames: () => runtime.toolNames(),
    callToolAsUser: (name, args, signal) => runtime.callToolAsUser(name, args, signal),
    dispose: () => runtime.dispose(),
    isDisposed: () => runtime.isDisposed(),
    sessionName: () => manager.sessionName,
    activeLeafId: () => manager.activeLeafId,
    setSessionName: async (name) => {
      const entry = await manager.setSessionName(name);
      return entry.name;
    },
    deleteSession: async () => {
      if (!manager.sessionFile) return false;
      return manager.deleteSession(manager.sessionFile);
    },
    steeredPrompt: (text, opts) => runtime.runUserTurn(text, { ...(opts ?? {}), steer: true }),
    followUp: (text, opts) => runtime.runUserTurn(text, { ...(opts ?? {}), followUp: true }),
    newSession: async () => {
      const nextOptions = { ...options, resume: false };
      return createSessionRuntime(nextOptions);
    },
    switchSession: async (filePath: string) => {
      const nextOptions = { ...options, resume: true };
      const nextStore = new SessionStore({ storageRoot: options.storageRoot, logger });
      const nextManager = await SessionManager.resume(nextStore, options.cwd, filePath);
      return buildSessionWithRuntime(nextOptions, nextManager, logger);
    },
    fork: async (entryId?: string) => {
      const sourcePath = manager.sessionFile;
      if (!sourcePath) throw new Error("No session file to fork");
      const nextPath = join(dirname(sourcePath), `fork-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jsonl`);
      const text = await readFile(sourcePath, "utf8");
      await writeFile(nextPath, text, "utf8");
      const nextStore = new SessionStore({ storageRoot: options.storageRoot, logger });
      const nextManager = await SessionManager.resume(nextStore, options.cwd, nextPath);
      if (entryId) nextManager.branchTo(entryId);
      return buildSessionWithRuntime({ ...options, resume: false }, nextManager, logger);
    },
    importFromJsonl: async (filePath: string) => {
      const nextStore = new SessionStore({ storageRoot: options.storageRoot, logger });
      const nextManager = await SessionManager.resume(nextStore, options.cwd, filePath);
      return buildSessionWithRuntime({ ...options, resume: false }, nextManager, logger);
    },
    branchSummary: async (fromId: string, summary: string) => {
      const entry = await manager.appendBranchSummary(fromId, summary);
      return entry.summary;
    },
    listSessions: async () => manager.listSessions(20),
  };
  return { session, manager };
}

function createFakeModel(): ModelAdapter {
  return {
    info: { provider: "fake", modelId: "fake-v1", contextWindow: 100000, maxOutputTokens: 4000 },
    async *stream() {
      yield { type: "finished", reason: "stop" };
    },
  };
}
