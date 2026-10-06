import { KernError } from "@kern/protocol";

export interface BudgetLimits {
  maxTurns: number;
  maxToolCallsPerTurn: number;
  maxTotalToolCalls: number;
  maxWallTimeMs: number;
}

export const DEFAULT_BUDGET_LIMITS: BudgetLimits = {
  maxTurns: 50,
  maxToolCallsPerTurn: 30,
  maxTotalToolCalls: 200,
  maxWallTimeMs: 10 * 60 * 1000,
};

export interface BudgetUsage {
  turns: number;
  totalToolCalls: number;
  wallTimeMs: number;
}

/**
 * Hard caps on consumable resources. Throws KernError when exceeded;
 * the runtime converts these into diagnostics and aborts the turn.
 */
export class BudgetTracker {
  private readonly limits: BudgetLimits;
  private readonly startedAt = Date.now();
  private turns = 0;
  private totalToolCalls = 0;

  constructor(limits: Partial<BudgetLimits> = {}) {
    this.limits = { ...DEFAULT_BUDGET_LIMITS, ...limits };
  }

  get limitsSnapshot(): BudgetLimits {
    return { ...this.limits };
  }

  usage(): BudgetUsage {
    return { turns: this.turns, totalToolCalls: this.totalToolCalls, wallTimeMs: Date.now() - this.startedAt };
  }

  checkTurn(nextTurn: number): void {
    this.turns = nextTurn;
    this.checkWallTime();
    if (nextTurn > this.limits.maxTurns) {
      throw new KernError("E_INTERNAL", `Turn budget exceeded (${nextTurn} > ${this.limits.maxTurns})`, {
        details: { budget: "maxTurns", ...this.usage() },
      });
    }
  }

  checkToolBatch(size: number): void {
    this.checkWallTime();
    if (size > this.limits.maxToolCallsPerTurn) {
      throw new KernError("E_INTERNAL", `Per-turn tool-call budget exceeded (${size} > ${this.limits.maxToolCallsPerTurn})`, {
        details: { budget: "maxToolCallsPerTurn", ...this.usage() },
      });
    }
    if (this.totalToolCalls + size > this.limits.maxTotalToolCalls) {
      throw new KernError("E_INTERNAL", `Total tool-call budget exceeded (${this.totalToolCalls + size} > ${this.limits.maxTotalToolCalls})`, {
        details: { budget: "maxTotalToolCalls", ...this.usage() },
      });
    }
  }

  recordToolCalls(n: number): void {
    this.totalToolCalls += n;
  }

  checkWallTime(): void {
    const elapsed = Date.now() - this.startedAt;
    if (elapsed > this.limits.maxWallTimeMs) {
      throw new KernError("E_INTERNAL", `Wall-time budget exceeded (${elapsed}ms > ${this.limits.maxWallTimeMs}ms)`, {
        details: { budget: "maxWallTimeMs", ...this.usage() },
      });
    }
  }
}
