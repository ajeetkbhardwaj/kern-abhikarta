import { readFile } from "node:fs/promises";
import type { RepoIndex } from "@kern/repo-index";
import { extractSymbolsFromText, type SymbolRecord } from "./ts-parser.js";

export interface SymbolQueryResult {
  matches: SymbolRecord[];
  score: number;
}

export class SymbolStore {
  private readonly repoIndex: RepoIndex;
  private cache = new Map<string, SymbolRecord[]>();

  constructor(repoIndex: RepoIndex) {
    this.repoIndex = repoIndex;
  }

  async indexRepo(): Promise<void> {
    await this.repoIndex.ensureLoaded();
    this.cache.clear();
    for (const file of this.repoIndex.all()) {
      if (!file.path.endsWith(".ts") && !file.path.endsWith(".tsx") && !file.path.endsWith(".js") && !file.path.endsWith(".mjs")) continue;
      try {
        const source = await readFile(file.path, "utf8");
        this.cache.set(file.path, extractSymbolsFromText(source, file.path));
      } catch {
        this.cache.set(file.path, []);
      }
    }
  }

  findByName(name: string): SymbolRecord[] {
    const needle = name.toLowerCase();
    const results: SymbolRecord[] = [];
    for (const list of this.cache.values()) {
      for (const symbol of list) {
        if (symbol.name.toLowerCase() === needle || symbol.name.toLowerCase().includes(needle)) {
          results.push(symbol);
        }
      }
    }
    return results;
  }

  findByFile(file: string): SymbolRecord[] {
    return this.cache.get(file) ?? [];
  }

  related(name: string): SymbolRecord[] {
    return this.findByName(name);
  }
}
