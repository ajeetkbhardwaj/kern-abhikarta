import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type ValidationKind = "vitest" | "tsc" | "custom";

export interface ValidationTarget {
  kind: ValidationKind;
  command: string;
  args: string[];
  reason: string;
  files: string[];
}

export interface ValidationOutcome {
  target: ValidationTarget;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  ok: boolean;
}

export function chooseValidationTargets(objective: string, files: string[] = []): ValidationTarget[] {
  const normalized = files.map((file) => file.trim()).filter(Boolean);
  const testFiles = normalized.filter((file) => /(?:^|\/)(?:test|tests|__tests__)\b|\.(?:test|spec)\.[jt]sx?$/.test(file));
  const sourceFiles = normalized.filter((file) => !testFiles.includes(file));

  if (testFiles.length > 0) {
    return testFiles.slice(0, 3).map((file) => ({
      kind: "vitest",
      command: "pnpm",
      args: ["vitest", "run", file],
      reason: `task-specific test coverage for ${objective}`,
      files: [file],
    }));
  }

  if (sourceFiles.length > 0) {
    return [{
      kind: "tsc",
      command: "pnpm",
      args: ["tsc", "-p", "tsconfig.json", "--noEmit"],
      reason: `project type-check after ${objective}`,
      files: sourceFiles,
    }];
  }

  return [{
    kind: "tsc",
    command: "pnpm",
    args: ["tsc", "-p", "tsconfig.json", "--noEmit"],
    reason: `default safety check for ${objective}`,
    files: [],
  }];
}

export async function runValidationTargets(targets: ValidationTarget[]): Promise<ValidationOutcome[]> {
  const results: ValidationOutcome[] = [];
  for (const target of targets) {
    try {
      const { stdout, stderr } = await execFileAsync(target.command, target.args, { shell: false, env: process.env });
      results.push({
        target,
        exitCode: 0,
        stdout,
        stderr,
        ok: true,
      });
    } catch (error) {
      const execError = error as { stdout?: string; stderr?: string; code?: number };
      results.push({
        target,
        exitCode: execError.code ?? 1,
        stdout: execError.stdout ?? "",
        stderr: execError.stderr ?? "",
        ok: false,
      });
    }
  }
  return results;
}

export function summarizeValidationResult(results: ValidationOutcome[]): string {
  if (results.length === 0) return "No validation targets were run.";
  const failed = results.filter((result) => !result.ok);
  if (failed.length === 0) {
    return `Validation passed for ${results.length} target(s).`;
  }
  return `Validation failed on ${failed.length}/${results.length} target(s): ${failed.map((result) => result.target.reason).join("; ")}`;
}

export function shouldRetryValidation(results: ValidationOutcome[]): boolean {
  return results.some((result) => !result.ok && result.target.kind !== "tsc");
}
