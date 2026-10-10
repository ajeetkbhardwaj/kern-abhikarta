import type { Logger, ModelToolSchema, ChatMessage } from "@kern/protocol";
import { nullLogger } from "@kern/protocol";
import { SessionManager } from "@kern/session-store";
import { ToolRegistry } from "@kern/tools";
import { countContextTokens, type ContextUsage } from "./tokens.js";

export interface RepoContextIntegration {
  query?: string;
  likelyFiles?: string[];
  projectNotes?: string[];
  relevantSymbols?: string[];
}

export interface RepoAwareContext {
  query?: string;
  likelyFiles?: string[];
  projectNotes?: string[];
  relevantSymbols?: string[];
}

export interface ContextSnapshot {
  systemPrompt: string;
  messages: ChatMessage[];
  tools: ModelToolSchema[];
  usage: ContextUsage;
}

export interface ContextBuilderOptions {
  baseSystemPrompt: string;
  toolRegistry: ToolRegistry;
  logger?: Logger;
  /** Extra system sections appended after the base prompt (AGENTS.md, skills catalog). */
  systemExtra?: string;
  repoContext?: RepoAwareContext;
  repoResolver?: (query: string) => Promise<RepoAwareContext>;
}

export class ContextBuilder {
  private readonly baseSystemPrompt: string;
  private readonly toolRegistry: ToolRegistry;
  private readonly logger: Logger;
  private systemExtra: string;
  private repoContext: RepoAwareContext;
  private readonly repoResolver?: (query: string) => Promise<RepoAwareContext>;

  constructor(options: ContextBuilderOptions) {
    this.baseSystemPrompt = options.baseSystemPrompt;
    this.toolRegistry = options.toolRegistry;
    this.logger = options.logger ?? nullLogger;
    this.systemExtra = options.systemExtra ?? "";
    this.repoContext = options.repoContext ?? {};
    this.repoResolver = options.repoResolver;
  }

  setSystemExtra(text: string): void {
    this.systemExtra = text;
  }

  setRepoContext(repoContext: RepoAwareContext): void {
    this.repoContext = { ...this.repoContext, ...repoContext };
  }

  async enrichForQuery(query: string): Promise<void> {
    if (!this.repoResolver || !query.trim()) return;
    const next = await this.repoResolver(query.trim());
    if (next) this.setRepoContext(next);
  }

  private deriveTaskQuery(sessions: SessionManager): string {
    const active = sessions.getActivePath();
    for (let i = active.length - 1; i >= 0; i--) {
      const entry = active[i];
      if (entry?.type !== "message") continue;
      const text = entry.message.content
        .filter((block) => block.type === "text")
        .map((block) => (block.type === "text" ? block.text : ""))
        .join(" ");
      if (text.trim()) return text.trim();
    }
    return "project context";
  }

  systemPrompt(): string {
    const base = this.systemExtra ? `${this.baseSystemPrompt}\n\n${this.systemExtra}` : this.baseSystemPrompt;
    if (!this.repoContext.likelyFiles && !this.repoContext.projectNotes && !this.repoContext.relevantSymbols) return base;
    const sections: string[] = [base];
    const likelyFiles = this.repoContext.likelyFiles?.length ? this.repoContext.likelyFiles : [];
    const notes = this.repoContext.projectNotes?.length ? this.repoContext.projectNotes : [];
    const symbols = this.repoContext.relevantSymbols?.length ? this.repoContext.relevantSymbols : [];

    if (likelyFiles.length > 0) {
      sections.push(`\n[Repo context: likely relevant files]\n${likelyFiles.map((p) => `- ${p}`).join("\n")}`);
    }
    if (symbols.length > 0) {
      sections.push(`\n[Repo context: relevant symbols]\n${symbols.map((s) => `- ${s}`).join("\n")}`);
    }
    if (notes.length > 0) {
      sections.push(`\n[Project memory]\n${notes.map((n) => `- ${n}`).join("\n")}`);
    }
    return sections.join("\n");
  }

  async build(sessions: SessionManager): Promise<ContextSnapshot> {
    const taskQuery = this.deriveTaskQuery(sessions);
    if (this.repoResolver && taskQuery && !this.repoContext.query) {
      await this.enrichForQuery(taskQuery);
    }
    const systemPrompt = this.systemPrompt();
    const compaction = sessions.lastCompaction();
    const messages: ChatMessage[] = [];
    if (compaction) {
      messages.push({
        role: "user",
        content: [{ type: "text", text: `[COMPACTED SUMMARY]\n${compaction.summary}` }],
        timestamp: compaction.timestamp,
      });
    }
    const active = sessions.getActivePath();
    const cutoff = compaction ? sessions.getEntry(compaction.replacesThroughId) : undefined;
    const cutoffSeq = cutoff?.seq;
    for (const entry of active) {
      if (entry.type !== "message") continue;
      if (compaction && isCoveredByCompaction(entry.id, entry.seq, compaction.replacesThroughId, cutoffSeq)) continue;
      messages.push(entry.message);
    }
    if (!this.repoContext.likelyFiles && !this.repoContext.projectNotes && !this.repoContext.relevantSymbols) {
      const taskQuery = this.deriveTaskQuery(sessions);
      if (taskQuery) {
        this.repoContext = { ...this.repoContext, query: taskQuery };
      }
    }
    const tools = this.toolRegistry.listModelSchemas();
    const usage = countContextTokens(systemPrompt, tools, messages);
    return { systemPrompt, messages, tools, usage };
  }
}

function isCoveredByCompaction(
  entryId: string,
  entrySeq: number | undefined,
  replacesThroughId: string,
  cutoffSeq: number | undefined,
): boolean {
  if (entrySeq !== undefined && cutoffSeq !== undefined) {
    return entrySeq <= cutoffSeq;
  }
  return entryId <= replacesThroughId;
}
