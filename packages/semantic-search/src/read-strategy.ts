import type { RepoIndex, RepoFileRecord } from "@kern/repo-index";
import type { SymbolStore } from "@kern/symbol-store";

export type TaskKind = "bugfix" | "feature" | "refactor" | "explore" | "test";

export interface ReadPlan {
  taskType: TaskKind;
  rationale: string;
  files: string[];
  tests: string[];
  symbols: string[];
  readOrder: string[];
}

export interface ReadStrategyInput {
  query: string;
  taskType?: TaskKind;
  fileHints?: string[];
  symbolHints?: string[];
}

export class ReadStrategy {
  constructor(
    private readonly repoIndex: RepoIndex,
    private readonly symbolStore: SymbolStore,
  ) {}

  async plan(input: ReadStrategyInput): Promise<ReadPlan> {
    await this.repoIndex.ensureLoaded();
    await this.symbolStore.indexRepo();

    const query = input.query.trim();
    const taskType = this.detectTaskType(query, input.taskType);
    const fileHints = (input.fileHints ?? []).map((hint) => hint.trim()).filter(Boolean);
    const symbolHints = (input.symbolHints ?? []).map((hint) => hint.trim()).filter(Boolean);

    const scored = new Map<string, { file: RepoFileRecord; score: number; reasons: string[] }>();
    for (const file of this.repoIndex.all()) {
      const score = this.scoreFile(file, query, taskType);
      if (score > 0) scored.set(file.path, { file, score, reasons: [this.fileReason(file, query, taskType)] });
    }

    for (const hint of fileHints) {
      for (const file of this.repoIndex.searchByName(hint)) {
        const entry = scored.get(file.path) ?? { file, score: 0, reasons: [] };
        entry.score += 25;
        entry.reasons.push(`hint:${hint}`);
        scored.set(file.path, entry);
      }
    }

    for (const symbol of symbolHints) {
      for (const match of this.symbolStore.findByName(symbol)) {
        const file = this.repoIndex.byPath(match.file);
        if (!file) continue;
        const entry = scored.get(file.path) ?? { file, score: 0, reasons: [] };
        entry.score += 35;
        entry.reasons.push(`symbol:${match.name}`);
        scored.set(file.path, entry);
      }
    }

    const ordered = [...scored.values()].sort((a, b) => b.score - a.score);
    const files = ordered.map((entry) => entry.file.path);
    const tests = files.filter((path) => /(?:^|\/)(?:test|tests|__tests__)/.test(path) || /\.(test|spec)\.[jt]sx?$/.test(path));
    const symbols = [...new Set(
      ordered.flatMap((entry) => this.symbolStore.findByFile(entry.file.path).map((symbol) => symbol.name)).slice(0, 25),
    )];

    return {
      taskType,
      rationale: this.describeTask(taskType, query),
      files: files.slice(0, 8),
      tests: tests.slice(0, 5),
      symbols,
      readOrder: [...new Set([...files.slice(0, 5), ...tests.slice(0, 3)])],
    };
  }

  private detectTaskType(query: string, taskType?: TaskKind): TaskKind {
    if (taskType) return taskType;
    const lower = query.toLowerCase();
    if (/bug|error|fail|crash|null|exception|stack trace|broken|regression/.test(lower)) return "bugfix";
    if (/test|spec|assert|coverage/.test(lower)) return "test";
    if (/refactor|cleanup|simplify|rename|extract/.test(lower)) return "refactor";
    if (/add|implement|create|build|feature/.test(lower)) return "feature";
    return "explore";
  }

  private fileReason(file: RepoFileRecord, query: string, taskType: TaskKind): string {
    const lower = file.path.toLowerCase();
    if (taskType === "test" && /test|spec/.test(lower)) return "test-target";
    if (/(src|packages)/.test(lower)) return "source-area";
    if (query.toLowerCase().split(/\s+/).some((part) => lower.includes(part))) return "query-match";
    return "repo-shape";
  }

  private scoreFile(file: RepoFileRecord, query: string, taskType: TaskKind): number {
    const lower = file.path.toLowerCase();
    const q = query.toLowerCase();
    let score = 0;

    if (lower.includes(q)) score += 40;
    if (taskType === "test" && /test|spec/.test(lower)) score += 30;
    if (/src|packages/.test(lower)) score += 10;
    if (file.imports?.some((value) => value.toLowerCase().includes(q))) score += 20;
    if (file.exports?.some((value) => value.toLowerCase().includes(q))) score += 15;
    if (/test|spec/.test(lower)) score += 5;
    return score;
  }

  private describeTask(taskType: TaskKind, query: string): string {
    switch (taskType) {
      case "bugfix":
        return `Bug-fix task centered on the failing behavior described by: ${query}`;
      case "feature":
        return `Feature work likely spanning implementation and validation around: ${query}`;
      case "refactor":
        return `Refactor task for code structure and API boundaries in: ${query}`;
      case "test":
        return `Validation task around tests and expected behavior for: ${query}`;
      default:
        return `Exploration task for repository context related to: ${query}`;
    }
  }
}
