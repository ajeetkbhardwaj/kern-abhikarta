import type { RepoIndex, RepoFileRecord } from "@kern/repo-index";
import type { SymbolStore } from "@kern/symbol-store";
import { RetrievalRanker, type RetrievalCandidate } from "./retrieval-ranker.js";

export interface SearchIntent {
  query: string;
  taskType?: "bugfix" | "feature" | "refactor" | "explore" | "test";
  fileHints?: string[];
  symbolHints?: string[];
}

export class SemanticSearch {
  constructor(
    private readonly repoIndex: RepoIndex,
    private readonly symbolStore: SymbolStore,
    private readonly ranker: RetrievalRanker = new RetrievalRanker(),
  ) {}

  async retrieve(intent: SearchIntent): Promise<RetrievalCandidate[]> {
    await this.repoIndex.ensureLoaded();
    await this.symbolStore.indexRepo();

    const query = intent.query.toLowerCase();
    const results = new Map<string, RetrievalCandidate>();

    for (const file of this.repoIndex.all()) {
      const score = this.ranker.score(query, file.path, this.lookupSymbols(file.path));
      if (score.score > 0) results.set(file.path, score);
    }

    for (const hint of intent.fileHints ?? []) {
      for (const file of this.repoIndex.searchByName(hint)) {
        const current = results.get(file.path) ?? this.ranker.score(hint, file.path, this.lookupSymbols(file.path));
        current.score += 15;
        current.reasons.push("file hint");
        results.set(file.path, current);
      }
    }

    for (const symbol of intent.symbolHints ?? []) {
      for (const match of this.symbolStore.findByName(symbol)) {
        const current = results.get(match.file) ?? this.ranker.score(symbol, match.file, [match.name]);
        current.score += 25;
        current.symbolMatches = [...new Set([...(current.symbolMatches ?? []), match.name])];
        current.reasons.push("symbol hint");
        results.set(match.file, current);
      }
    }

    return [...results.values()].sort((a, b) => b.score - a.score).slice(0, 25);
  }

  private lookupSymbols(filePath: string): string[] {
    return this.symbolStore.findByFile(filePath).map((symbol) => symbol.name);
  }
}
