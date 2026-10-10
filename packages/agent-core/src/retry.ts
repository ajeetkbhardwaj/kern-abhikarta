import type { ModelErrorKind } from "@kern/protocol";
import { classifyModelError, isRetryableModelError } from "@kern/protocol";

export interface RetryConfig {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  multiplier: number;
  jitter: number;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  initialDelayMs: 250,
  maxDelayMs: 5000,
  multiplier: 2,
  jitter: 0.1,
};

export interface RetryCallbacks {
  onRetry?: (attempt: number, kind: ModelErrorKind, delayMs: number) => void;
  onSettled?: (attempt: number, success: boolean, kind?: ModelErrorKind) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  classify: (err: unknown) => ModelErrorKind = classifyModelError,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
  callbacks: RetryCallbacks = {},
): Promise<T> {
  let delay = config.initialDelayMs;
  let lastErr: unknown;
  let lastKind: ModelErrorKind = "unknown";
  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    try {
      const result = await fn(attempt);
      callbacks.onSettled?.(attempt, true, lastKind);
      return result;
    } catch (err) {
      lastErr = err;
      lastKind = classify(err);
      const isRetryable = isRetryableModelError(lastKind);
      if (!isRetryable || attempt === config.maxAttempts) {
        callbacks.onSettled?.(attempt, false, lastKind);
        throw err;
      }
      const jitter = delay * config.jitter * (Math.random() * 2 - 1);
      const waitMs = Math.max(0, Math.round(delay + jitter));
      callbacks.onRetry?.(attempt, lastKind, waitMs);
      await sleep(waitMs);
      delay = Math.min(config.maxDelayMs, delay * config.multiplier);
    }
  }
  throw lastErr;
}
