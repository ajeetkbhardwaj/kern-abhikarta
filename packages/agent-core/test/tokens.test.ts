import { describe, expect, it } from "vitest";
import { countContextTokens, estimateTokens } from "../src/tokens.js";

describe("token estimator", () => {
  it("counts simple text as at least one token", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("hello")).toBeGreaterThan(0);
  });

  it("produces larger estimates for code-heavy content than plain prose", () => {
    const prose = "This is a short sentence in plain English.";
    const code = "const x = createTool({ name: 'demo', args: { user: 'a', forced: true }, enabled: false });";
    expect(estimateTokens(code)).toBeGreaterThan(estimateTokens(prose));
  });

  it("counts context usage deterministically for a mixed prompt", () => {
    const usage = countContextTokens(
      "You are a coding agent.",
      [{ name: "read", description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }],
      [
        { role: "user", timestamp: "2026-01-01T00:00:00.000Z", content: [{ type: "text", text: "Please inspect the workspace." }] },
      ],
    );

    expect(usage.totalTokens).toBeGreaterThan(usage.systemTokens);
    expect(usage.totalTokens).toBeGreaterThan(0);
    expect(usage.messagesTokens).toBeGreaterThan(0);
  });
});
