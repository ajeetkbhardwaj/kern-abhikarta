import { describe, expect, it } from "vitest";
import { chooseValidationTargets, summarizeValidationResult, shouldRetryValidation } from "../src/validation.js";

describe("validation orchestration", () => {
  it("prefers task-specific tests when affected files are test files", () => {
    const targets = chooseValidationTargets("fix session invariant", ["packages/session-store/test/invariants.test.ts"]);
    expect(targets[0]?.kind).toBe("vitest");
    expect(targets[0]?.args).toContain("run");
  });

  it("falls back to project typecheck for non-test tasks", () => {
    const targets = chooseValidationTargets("harden retry flow", ["packages/agent-core/src/retry.ts"]);
    expect(targets[0]?.kind).toBe("tsc");
  });

  it("summarizes failed validation clearly", () => {
    const summary = summarizeValidationResult([
      { target: { kind: "vitest", command: "pnpm", args: ["vitest", "run"], reason: "unit test", files: [] }, exitCode: 1, stdout: "", stderr: "failed", ok: false },
    ]);
    expect(summary).toContain("Validation failed");
  });

  it("retries validation for flaky unit-target failures", () => {
    const results = [{
      target: { kind: "vitest" as const, command: "pnpm", args: ["vitest", "run"], reason: "unit test", files: [] },
      exitCode: 1,
      stdout: "",
      stderr: "failed",
      ok: false,
    }];
    expect(shouldRetryValidation(results)).toBe(true);
  });
});
