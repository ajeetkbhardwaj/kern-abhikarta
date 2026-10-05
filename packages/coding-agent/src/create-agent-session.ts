import { AgentRuntime, ContextBuilder, EventBus } from "@kern/agent-core";
import { SessionManager, SessionStore } from "@kern/session-store";
import { ToolRegistry, createReadTool, createWriteTool, createEditTool, createBashTool } from "@kern/tools";
import { createLogger, type Logger, type ModelAdapter, type AgentEventListener } from "@kern/protocol";
import { ModelInfo } from "@kern/protocol";

export interface CreateAgentSessionOptions {
  cwd: string;
  logger?: Logger;
  storageRoot?: string;
}

export interface AgentSession {
  prompt(text: string): Promise<void>;
  subscribe(listener: AgentEventListener): () => void;
}

export async function createAgentSession(options: CreateAgentSessionOptions): Promise<{ session: AgentSession; manager: SessionManager }> {
  const logger = options.logger ?? createLogger("info");
  const store = new SessionStore({ storageRoot: options.storageRoot, logger });
  const manager = await SessionManager.create(store, options.cwd);
  const tools = new ToolRegistry({ workspaceRoot: options.cwd });
  tools.register(createReadTool(options.cwd));
  tools.register(createWriteTool(options.cwd));
  tools.register(createEditTool(options.cwd));
  tools.register(createBashTool(options.cwd));
  const events = new EventBus(logger);
  const contextBuilder = new ContextBuilder({ baseSystemPrompt: "You are Kern, a minimal coding agent. Use tools when needed.", toolRegistry: tools, logger });
  const model = createFakeModel();
  const runtime = new AgentRuntime({ model, tools, sessions: manager, contextBuilder, events, logger });
  const session: AgentSession = {
    prompt: (text: string) => runtime.runUserTurn(text),
    subscribe: (l) => events.subscribe(l),
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