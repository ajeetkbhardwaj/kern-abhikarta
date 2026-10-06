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
import { createLogger, type Logger, type ModelAdapter, type ModelInfo, type AgentEventListener, type ToolResult } from "@kern/protocol";
import type { BudgetLimits, ContextUsage } from "@kern/agent-core";

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
  /** Manual compaction. Resolves null when there is nothing to compact. */
  compact(instructions?: string): Promise<{ summary: string; replacesThroughId: string } | null>;
  /** Token usage of the most recent context build. */
  contextUsage(): ContextUsage | null;
  approvalMode(): string;
  setApprovalMode(mode: "ask" | "never" | "auto-allowlist"): boolean;
  allowToolForSession(toolName: string): boolean;
  toolNames(): string[];
  callToolAsUser(name: string, args: unknown, signal?: AbortSignal): Promise<ToolResult>;
}

export async function createAgentSession(
  options: CreateAgentSessionOptions,
): Promise<{ session: AgentSession; manager: SessionManager }> {
  const logger = options.logger ?? createLogger("info");
  const policyConfig = { ...DEFAULT_POLICY_CONFIG, ...(options.policy ?? {}) };
  const store = new SessionStore({ storageRoot: options.storageRoot, logger });
  const manager = options.resume
    ? await SessionManager.resume(store, options.cwd)
    : await SessionManager.create(store, options.cwd);

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
  const contextBuilder = new ContextBuilder({
    baseSystemPrompt: "You are Kern, a minimal coding agent. Use tools when needed.",
    toolRegistry: tools,
    logger,
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
    requestApproval: options.requestApproval,
  });

  const session: AgentSession = {
    prompt: (text, opts) => runtime.runUserTurn(text, opts ?? {}),
    subscribe: (l) => events.subscribe(l),
    budgetUsage: () => runtime.budgetUsage(),
    isBusy: () => runtime.isBusy(),
    setModel: (adapter) => runtime.setModel(adapter),
    modelInfo: () => runtime.modelInfo(),
    compact: (instructions) => runtime.compactNow(instructions),
    contextUsage: () => runtime.contextUsage(),
    approvalMode: () => runtime.approvalMode(),
    setApprovalMode: (mode) => runtime.setApprovalMode(mode),
    allowToolForSession: (toolName) => runtime.allowToolForSession(toolName),
    toolNames: () => runtime.toolNames(),
    callToolAsUser: (name, args, signal) => runtime.callToolAsUser(name, args, signal),
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
