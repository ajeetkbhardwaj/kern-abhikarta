import { describe, expect, it } from "vitest";
import { RepoIndex } from "@kern/repo-index";
import { SymbolStore } from "@kern/symbol-store";
import { SemanticSearch } from "../src/searcher.js";
import { RetrievalRanker } from "../src/retrieval-ranker.js";

describe("semantic search", () => {
  it("retrieves relevant files for a task query", async () => {
    const repoIndex = new RepoIndex({ root: "/workspaces/mathcode.com" });
    const symbolStore = new SymbolStore(repoIndex);
    const searcher = new SemanticSearch(repoIndex, symbolStore, new RetrievalRanker());
    const hits = await searcher.retrieve({ query: "session invariants", symbolHints: ["validateInvariants"] });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.path).toContain("session-store");
  });
});
