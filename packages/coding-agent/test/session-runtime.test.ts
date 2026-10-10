import { describe, expect, it } from "vitest";
import { createAgentSession, SettingsManager } from "../src/index.js";

describe("Phase 5 session runtime + settings", () => {
  it("loads project settings and keeps them mergeable", async () => {
    const cwd = process.cwd();
    const settings = await SettingsManager.load(cwd, { thinkingLevel: "low" });
    expect(settings.thinkingLevel).toBe("low");
  });

  it("creates a session and exposes runtime ops", async () => {
    const { session } = await createAgentSession({ cwd: process.cwd(), loadResources: false, enableCompaction: false });
    expect(typeof session.prompt).toBe("function");
    expect(typeof session.thinkingMode).toBe("function");
    expect(typeof session.setThinkingLevel).toBe("function");
    session.dispose();
  });
});
