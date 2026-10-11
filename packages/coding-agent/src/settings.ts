import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BudgetLimits } from "@kern/agent-core";
import type { ThinkingLevel } from "@kern/protocol";
import type { PolicyConfig } from "@kern/tools";

export interface SessionSettings {
  policy?: Partial<PolicyConfig>;
  budgets?: Partial<BudgetLimits>;
  thinkingLevel?: ThinkingLevel;
}

export class SettingsManager {
  static async load(cwd: string, overrides: Partial<SessionSettings> = {}): Promise<SessionSettings> {
    const merged: SessionSettings = {};
    try {
      const text = await readFile(join(homedir(), ".kern", "settings.json"), "utf8");
      deepMergeInto(merged, JSON.parse(text) as Partial<SessionSettings>);
    } catch {
      // Ignore missing or invalid user config; the runtime keeps defaults.
    }
    try {
      const text = await readFile(join(cwd, ".kern", "settings.json"), "utf8");
      const parsed = JSON.parse(text) as Partial<SessionSettings>;
      // Fail-closed: a cloned repo must not loosen safety. Project file may
      // only set thinkingLevel and tighten budgets — never policy.
      if (parsed.thinkingLevel) merged.thinkingLevel = parsed.thinkingLevel;
      if (parsed.budgets) {
        merged.budgets = { ...(merged.budgets ?? {}) };
        for (const [k, v] of Object.entries(parsed.budgets)) {
          const cur = (merged.budgets as Record<string, unknown>)[k];
          if (typeof v === "number" && Number.isFinite(v) && v > 0 && (typeof cur !== "number" || v < cur)) {
            (merged.budgets as Record<string, unknown>)[k] = v;
          }
        }
      }
    } catch {
      // Ignore missing or invalid project config.
    }
    deepMergeInto(merged, overrides);
    return merged;
  }

  static async saveProject(cwd: string, settings: SessionSettings): Promise<string> {
    const path = join(cwd, ".kern", "settings.json");
    await mkdir(join(cwd, ".kern"), { recursive: true, mode: 0o700 });
    await writeFile(path, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
    return path;
  }
}

function deepMergeInto<T>(target: T, source: Partial<T> | undefined): void {
  if (!source || typeof source !== "object") return;
  for (const key of Object.keys(source) as Array<keyof T>) {
    const value = source[key];
    const current = target[key];
    if (value && typeof value === "object" && !Array.isArray(value) && current && typeof current === "object" && !Array.isArray(current)) {
      deepMergeInto(current as Record<string, unknown>, value as Record<string, unknown>);
      continue;
    }
    (target as Record<string, unknown>)[String(key)] = value as unknown;
  }
}
