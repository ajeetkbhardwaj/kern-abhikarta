import { describe, expect, it } from "vitest";
import { RepoIndex } from "../src/repo-index.js";

describe("repo index", () => {
  it("indexes the workspace without crashing", async () => {
    const index = new RepoIndex({ root: "/workspaces/mathcode.com" });
    await index.refresh();
    expect(index.all().length).toBeGreaterThan(20);
  });

  it("finds files by name", async () => {
    const index = new RepoIndex({ root: "/workspaces/mathcode.com" });
    await index.refresh();
    const hits = index.searchByName("tokens");
    expect(hits.length).toBeGreaterThan(0);
  });
});
