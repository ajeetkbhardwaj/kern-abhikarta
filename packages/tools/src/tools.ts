import type {
  JsonSchema,
  ToolContext,
  ToolDefinition,
  ToolResult,
  ModelToolSchema,
  SideEffect,
  PolicyDecision,
  PolicyInput,
  ToolPolicyEngine,
} from "@kern/protocol";
import { boundText, defaultModelSchema, textResult } from "@kern/protocol";
import { readFile, writeFile, stat, readdir, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { DefaultPolicy } from "./policy.js";
import { safeResolveSync } from "./path-safety.js";
import { validateArgs } from "./validate-args.js";

export { AllowAllPolicy } from "./policy.js";

/** Hard cap on single write payload. */
const MAX_WRITE_BYTES = 500_000;
/** Stop accumulating subprocess output past this; result is marked truncated. */
const MAX_CAPTURE_BYTES = 1_000_000;

export interface ToolRegistryOptions {
  policy?: ToolPolicyEngine;
  workspaceRoot: string;
  /** Registry-level timeout per tool call. Aborts the tool's signal. */
  maxToolMs?: number;
  /** Fallback approval handler when policy demands approval. */
  requestApproval?: (prompt: string) => Promise<boolean>;
}

export interface ExecuteOptions {
  origin?: PolicyInput["origin"];
  requestApproval?: (prompt: string) => Promise<boolean>;
}

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();
  private policy: ToolPolicyEngine;
  private workspaceRoot: string;
  private maxToolMs: number;
  private requestApproval?: (prompt: string) => Promise<boolean>;

  constructor(options: ToolRegistryOptions) {
    this.policy = options.policy ?? new DefaultPolicy();
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.maxToolMs = options.maxToolMs ?? 120_000;
    if (options.requestApproval !== undefined) this.requestApproval = options.requestApproval;
  }

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  listModelSchemas(): ModelToolSchema[] {
    return Array.from(this.tools.values()).map((t) => (t.toModelSchema ? t.toModelSchema() : defaultModelSchema(t)));
  }

  async execute(name: string, args: unknown, signal: AbortSignal, opts: ExecuteOptions = {}): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return textResult(`Unknown tool: ${name}`, true, { code: "E_TOOL_UNKNOWN" });
    }

    // 1. Validate arguments before policy or execution.
    const argErrors = validateArgs(tool.inputSchema, args);
    if (argErrors.length > 0) {
      return textResult(`Invalid arguments for tool ${name}: ${argErrors.join("; ")}`, true, {
        code: "E_TOOL_INVALID_ARGS",
        errors: argErrors,
      });
    }

    // 2. Policy decision.
    const origin = opts.origin ?? "model";
    const policy = await this.policy.evaluate({
      toolName: name,
      arguments: args,
      cwd: this.workspaceRoot,
      origin,
    });
    if (policy.decision === "deny") {
      return textResult(policy.reason, true, { code: "E_TOOL_DENIED" });
    }
    if (policy.decision === "require_approval") {
      const handler = opts.requestApproval ?? this.requestApproval;
      if (!handler) {
        return textResult(`Approval required: ${policy.prompt}`, true, { code: "E_TOOL_DENIED" });
      }
      let approved = false;
      try {
        approved = await handler(policy.prompt);
      } catch {
        approved = false;
      }
      if (!approved) {
        return textResult(`Denied by approver: ${policy.prompt}`, true, { code: "E_TOOL_DENIED" });
      }
    }

    // 3. Execute with registry-level timeout. Timeout aborts the tool signal.
    const ctrl = new AbortController();
    const onParentAbort = () => ctrl.abort();
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener("abort", onParentAbort, { once: true });

    const ctx: ToolContext = {
      cwd: this.workspaceRoot,
      workspaceRoot: this.workspaceRoot,
      signal: ctrl.signal,
      emitProgress: () => {},
    };
    if (opts.requestApproval ?? this.requestApproval) {
      ctx.requestApproval = opts.requestApproval ?? this.requestApproval;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<ToolResult>((resolveTimeout) => {
      timer = setTimeout(() => {
        ctrl.abort();
        resolveTimeout(
          textResult(`Tool ${name} timed out after ${this.maxToolMs}ms`, true, {
            code: "E_TOOL_TIMEOUT",
            timeoutMs: this.maxToolMs,
          }),
        );
      }, this.maxToolMs);
      if (typeof timer.unref === "function") timer.unref();
    });

    const runPromise = (async (): Promise<ToolResult> => {
      try {
        return await tool.execute(args as never, ctx);
      } catch (error) {
        return textResult(String(error), true, { code: "E_TOOL_FAILED" });
      }
    })();
    // Avoid unhandled rejection when the timeout wins the race.
    runPromise.catch(() => {}).finally(() => {
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", onParentAbort);
    });

    return Promise.race([runPromise, timeoutPromise]);
  }
}

/**
 * Resolve `p` inside `root`, following symlinks. Throws on escape.
 * Fail closed: callers convert this into a tool error, never a silent redirect.
 */
function safePath(root: string, p: string): string {
  return safeResolveSync(root, p);
}

export function createReadTool(root: string): ToolDefinition<{ path: string; offset?: number; limit?: number }> {
  return {
    name: "read",
    description: "Read file contents or directory listing",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } },
      required: ["path"],
    },
    sideEffect: "read",
    async execute(args, ctx) {
      let target: string;
      try {
        target = safePath(ctx.workspaceRoot, args.path);
      } catch (error) {
        return textResult(String(error), true, { code: "E_TOOL_DENIED" });
      }
      try {
        const st = await stat(target);
        if (st.isDirectory()) {
          const entries = await readdir(target);
          const text = entries.sort().map((e) => `- ${e}`).join("\n");
          return { content: [{ type: "text", text }], isError: false };
        }
        const text = await readFile(target, "utf8");
        if (text.includes("\0")) {
          return {
            content: [{ type: "text", text: `Binary file (${st.size} bytes). Refusing to inject into context.` }],
            isError: false,
            details: { binary: true, size: st.size },
          };
        }
        const offset = args.offset ?? 1;
        const limit = Math.min(args.limit ?? 400, 2000);
        const lines = text.split("\n");
        const start = Math.max(0, offset - 1);
        const end = Math.min(lines.length, start + limit);
        const sliced = lines.slice(start, end).map((l, i) => `${start + i + 1}: ${l}`).join("\n");
        const bounded = boundText(sliced.length ? sliced : "");
        return {
          content: [{ type: "text", text: bounded.text }],
          isError: false,
          details: bounded.truncated ? { truncated: true } : undefined,
        };
      } catch (error) {
        return textResult(String(error), true, { code: "E_TOOL_FAILED" });
      }
    },
  };
}

export function createWriteTool(root: string): ToolDefinition<{ path: string; content: string; overwrite?: boolean }> {
  return {
    name: "write",
    description: "Create or overwrite a file",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" }, overwrite: { type: "boolean" } },
      required: ["path", "content"],
    },
    sideEffect: "write",
    async execute(args, ctx) {
      let target: string;
      try {
        target = safePath(ctx.workspaceRoot, args.path);
      } catch (error) {
        return textResult(String(error), true, { code: "E_TOOL_DENIED" });
      }
      if (args.content.length > MAX_WRITE_BYTES) {
        return textResult(`Write payload too large (${args.content.length} > ${MAX_WRITE_BYTES} bytes)`, true, {
          code: "E_TOOL_INVALID_ARGS",
        });
      }
      const overwrite = args.overwrite ?? false;
      try {
        const st = await stat(target).catch(() => null);
        if (st && st.isDirectory()) return textResult(`Path is a directory: ${args.path}`, true);
        if (st && !overwrite) return textResult(`File exists: ${args.path}`, true);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, args.content, "utf8");
        return {
          content: [{ type: "text", text: `Wrote ${args.path}` }],
          isError: false,
          details: { changedPaths: [args.path] },
        };
      } catch (error) {
        return textResult(String(error), true, { code: "E_TOOL_FAILED" });
      }
    },
  };
}

export function createEditTool(
  root: string,
): ToolDefinition<{ path: string; oldText: string; newText: string; replaceAll?: boolean }> {
  return {
    name: "edit",
    description: "Replace exact text in a file",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        oldText: { type: "string" },
        newText: { type: "string" },
        replaceAll: { type: "boolean" },
      },
      required: ["path", "oldText", "newText"],
    },
    sideEffect: "write",
    async execute(args, ctx) {
      let target: string;
      try {
        target = safePath(ctx.workspaceRoot, args.path);
      } catch (error) {
        return textResult(String(error), true, { code: "E_TOOL_DENIED" });
      }
      try {
        const text = await readFile(target, "utf8");
        if (!text.includes(args.oldText)) return textResult("oldText not found", true);
        let next: string;
        let count: number;
        if (args.replaceAll) {
          next = text.replaceAll(args.oldText, args.newText);
          const escaped = args.oldText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          count = (text.match(new RegExp(escaped, "g")) || []).length;
        } else {
          const idx = text.indexOf(args.oldText);
          if (idx === -1) return textResult("oldText not found", true);
          const after = text.indexOf(args.oldText, idx + 1);
          if (after !== -1) return textResult("oldText not unique; add context or set replaceAll", true);
          next = text.replace(args.oldText, args.newText);
          count = 1;
        }
        await writeFile(target, next, "utf8");
        return {
          content: [{ type: "text", text: `Replaced ${count} occurrence(s) in ${args.path}` }],
          isError: false,
          details: { changedPaths: [args.path], replacements: count },
        };
      } catch (error) {
        return textResult(String(error), true, { code: "E_TOOL_FAILED" });
      }
    },
  };
}

/** Kill a whole process group (Unix) or the single process (Windows). */
function killTree(proc: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  try {
    if (process.platform !== "win32" && proc.pid !== undefined) {
      process.kill(-proc.pid, signal);
    } else {
      proc.kill(signal);
    }
  } catch {
    try {
      proc.kill(signal);
    } catch {
      // already dead
    }
  }
}

export function createBashTool(root: string, timeoutMs = 120000): ToolDefinition<{ command: string; timeoutMs?: number }> {
  return {
    name: "bash",
    description: "Execute a shell command in the workspace",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string" }, timeoutMs: { type: "number" } },
      required: ["command"],
    },
    sideEffect: "execute",
    async execute(args, ctx) {
      const cmd = args.command;
      const t = Math.min(args.timeoutMs ?? timeoutMs, 600_000);
      return await new Promise<ToolResult>((resolvePromise) => {
        let settled = false;
        const finish = (result: ToolResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          clearTimeout(killTimer);
          ctx.signal.removeEventListener("abort", onAbort);
          resolvePromise(result);
        };

        const proc = spawn("bash", ["-c", cmd], {
          cwd: ctx.workspaceRoot,
          stdio: "pipe",
          detached: process.platform !== "win32",
          windowsHide: true,
        });
        const startedAt = Date.now();
        let stdout = "";
        let stdoutCapped = false;
        let stderr = "";
        let stderrCapped = false;
        const timer = setTimeout(() => {
          killTree(proc, "SIGTERM");
          killTimer = setTimeout(() => killTree(proc, "SIGKILL"), 2000);
          const durationMs = Date.now() - startedAt;
          const out = boundText(stdout);
          const err = boundText(stderr);
          let text = `Exit code: 124 (timeout after ${t}ms)\nDuration: ${(durationMs / 1000).toFixed(1)}s\n`;
          if (out.text) text += `\nstdout:\n${out.text}`;
          if (err.text) text += `\nstderr:\n${err.text}`;
          finish({
            content: [{ type: "text", text }],
            isError: true,
            details: { code: "E_TOOL_TIMEOUT", exitCode: 124, durationMs, timeoutMs: t },
          });
        }, t);
        let killTimer: ReturnType<typeof setTimeout> | undefined;

        const onAbort = () => {
          killTree(proc, "SIGTERM");
          killTimer = setTimeout(() => killTree(proc, "SIGKILL"), 2000);
        };
        if (ctx.signal.aborted) onAbort();
        else ctx.signal.addEventListener("abort", onAbort, { once: true });

        proc.stdout.on("data", (d: Buffer) => {
          if (stdout.length < MAX_CAPTURE_BYTES) stdout += d.toString();
          else stdoutCapped = true;
        });
        proc.stderr.on("data", (d: Buffer) => {
          if (stderr.length < MAX_CAPTURE_BYTES) stderr += d.toString();
          else stderrCapped = true;
        });
        proc.on("close", (code, signal) => {
          const durationMs = Date.now() - startedAt;
          const out = boundText(stdout);
          const err = boundText(stderr);
          let text = `Exit code: ${code ?? -1}${signal ? ` (signal ${signal})` : ""}\nDuration: ${(durationMs / 1000).toFixed(1)}s\n`;
          if (out.text) text += `\nstdout:\n${out.text}`;
          if (err.text) text += `\nstderr:\n${err.text}`;
          finish({
            content: [{ type: "text", text }],
            isError: code !== 0,
            details: {
              exitCode: code ?? -1,
              durationMs,
              stdoutTruncated: out.truncated || stdoutCapped,
              stderrTruncated: err.truncated || stderrCapped,
              timeoutMs: t,
            },
          });
        });
        proc.on("error", (e) => {
          finish(textResult(String(e), true, { code: "E_TOOL_FAILED" }));
        });
      });
    },
  };
}
