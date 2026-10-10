import { describe, expect, it, vi } from "vitest";
import { withRetry } from "../src/retry.js";
import { KernError } from "@kern/protocol";

describe("retry policy", () => {
  it("retries transient network failures and succeeds on a later attempt", async () => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts += 1;
        if (attempts < 2) throw KernError.model("network", "temporary outage");
        return "ok";
      },
      (err) => (err instanceof KernError ? err.kind ?? "unknown" : "unknown"),
      { maxAttempts: 3, initialDelayMs: 0, maxDelayMs: 0, multiplier: 2, jitter: 0 },
    );
    expect(result).toBe("ok");
    expect(attempts).toBe(2);
  });

  it("does not retry cancelled operations", async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts += 1;
          throw KernError.cancelled("stop");
        },
        (err) => (err instanceof KernError ? err.kind ?? "unknown" : "unknown"),
        { maxAttempts: 3, initialDelayMs: 0, maxDelayMs: 0, multiplier: 2, jitter: 0 },
      ),
    ).rejects.toThrow("stop");
    expect(attempts).toBe(1);
  });

  it("does not retry after exhausting the retry budget", async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts += 1;
          throw KernError.model("rate_limit", "too many requests");
        },
        (err) => (err instanceof KernError ? err.kind ?? "unknown" : "unknown"),
        { maxAttempts: 2, initialDelayMs: 0, maxDelayMs: 0, multiplier: 2, jitter: 0 },
      ),
    ).rejects.toThrow("too many requests");
    expect(attempts).toBe(2);
  });
});
