import type { JsonSchema, ToolContext, ToolDefinition, ToolResult, ModelToolSchema, SideEffect, PolicyDecision, PolicyInput, ToolPolicyEngine } from "@kern/protocol";
import { boundText, defaultModelSchema, textResult, now } from "@kern/protocol";
import { readFile, writeFile, stat, readdir, mkdir } from "node:fs/promises";
import { resolve, dirname, isAbsolute, relative, normalize } from "node:path";
import { spawn } from "node:child_process";

export class AllowAllPolicy implements ToolPolicyEngine {
  async evaluate(): Promise<PolicyDecision> {
    return { decision: "allow" };
  }
}

export interface ToolRegistryOptions {
  policy?: ToolPolicyEngine;
  workspaceRoot: string;
}

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();
  private policy: ToolPolicyEngine;
  private workspaceRoot: string;

  constructor(options: ToolRegistryOptions) {
    this.policy = options.policy ?? new AllowAllPolicy();
    this.workspaceRoot = resolve(options.workspaceRoot);
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

  async execute(name: string, args: unknown, signal: AbortSignal): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) return textResult(`Unknown tool: ${name}`, true);
    const policy = await this.policy.evaluate({ toolName: name, arguments: args, cwd: process.cwd(), origin: "model" });
    if (policy.decision === "deny") return textResult(policy.reason, true);
    if (policy.decision === "require_approval") {
      return textResult(policy.prompt, true);
    }
    try {
      const ctx: ToolContext = {
        cwd: process.cwd(),
        workspaceRoot: this.workspaceRoot,
        signal,
        emitProgress: () => {},
      };
      const res = await tool.execute(args as any, ctx);
      if (res.isError) return res;
      return res;
    } catch (error) {
      return textResult(String(error), true);
    }
  }
}

function safePath(root: string, p: string): string {
  const abs = isAbsolute(p) ? normalize(p) : normalize(resolve(root, p));
  const rel = relative(root, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) return root;
  return abs;
}

export function createReadTool(root: string): ToolDefinition<{ path: string; offset?: number; limit?: number }> {
  return {
    name: "read",
    description: "Read file contents or directory listing",
    inputSchema: { type: "object", properties: { path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } }, required: ["path"] },
    sideEffect: "read",
    async execute(args, ctx) {
      const target = safePath(ctx.workspaceRoot, args.path);
      try {
        const st = await stat(target);
        if (st.isDirectory()) {
          const entries = await readdir(target);
          const text = entries.sort().map((e) => `- ${e}`).join("\n");
          return { content: [{ type: "text", text }], isError: false };
        }
        let text = await readFile(target, "utf8");
        let offset = args.offset ?? 1;
        let limit = args.limit ?? 2000;
        const lines = text.split("\n");
        const start = Math.max(0, offset - 1);
        const end = Math.min(lines.length, start + limit);
        const sliced = lines.slice(start, end).map((l, i) => `${start + i + 1}: ${l}`).join("\n");
        return { content: [{ type: "text", text: sliced.length ? sliced : "" }], isError: false };
      } catch (error) {
        return textResult(String(error), true);
      }
    },
  };
}

export function createWriteTool(root: string): ToolDefinition<{ path: string; content: string; overwrite?: boolean }> {
  return {
    name: "write",
    description: "Create or overwrite a file",
    inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" }, overwrite: { type: "boolean" } }, required: ["path", "content"] },
    sideEffect: "write",
    async execute(args, ctx) {
      const target = safePath(ctx.workspaceRoot, args.path);
      const overwrite = args.overwrite ?? false;
      try {
        const st = await stat(target).catch(() => null);
        if (st && !overwrite) return textResult(`File exists: ${args.path}`, true);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, args.content, "utf8");
        return { content: [{ type: "text", text: `Wrote ${args.path}` }], isError: false };
      } catch (error) {
        return textResult(String(error), true);
      }
    },
  };
}

export function createEditTool(root: string): ToolDefinition<{ path: string; oldText: string; newText: string; replaceAll?: boolean }> {
  return {
    name: "edit",
    description: "Replace exact text in a file",
    inputSchema: { type: "object", properties: { path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" }, replaceAll: { type: "boolean" } }, required: ["path", "oldText", "newText"] },
    sideEffect: "write",
    async execute(args, ctx) {
      const target = safePath(ctx.workspaceRoot, args.path);
      try {
        const text = await readFile(target, "utf8");
        if (!text.includes(args.oldText)) return textResult("oldText not found", true);
        let count = 0;
        let next = text;
        if (args.replaceAll) {
          next = text.replaceAll(args.oldText, args.newText);
          count = (text.match(new RegExp(args.oldText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length;
        } else {
          const idx = text.indexOf(args.oldText);
          if (idx === -1) return textResult("oldText not found", true);
          const before = (text.slice(0, idx).match(/\n/g) || []).length + 1;
          const after = text.indexOf(args.oldText, idx + 1);
          if (after !== -1) return textResult("oldText not unique; add context or set replaceAll", true);
          next = text.replace(args.oldText, args.newText);
          count = 1;
        }
        await writeFile(target, next, "utf8");
        return { content: [{ type: "text", text: `Replaced ${count} occurrence(s) in ${args.path}` }], isError: false };
      } catch (error) {
        return textResult(String(error), true);
      }
    },
  };
}

export function createBashTool(root: string, timeoutMs = 120000): ToolDefinition<{ command: string; timeoutMs?: number }> {
  return {
    name: "bash",
    description: "Execute a shell command in the workspace",
    inputSchema: { type: "object", properties: { command: { type: "string" }, timeoutMs: { type: "number" } }, required: ["command"] },
    sideEffect: "execute",
    async execute(args, ctx) {
      const cmd = args.command;
      const t = args.timeoutMs ?? timeoutMs;
      return await new Promise<ToolResult>((resolve) => {
        const proc = spawn("bash", ["-c", cmd], { cwd: ctx.workspaceRoot, stdio: "pipe" });
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => proc.kill("SIGTERM"), t);
        proc.stdout.on("data", (d) => (stdout += d.toString()));
        proc.stderr.on("data", (d) => (stderr += d.toString()));
        proc.on("close", (code) => {
          clearTimeout(timer);
          const out = boundText(stdout);
          const err = boundText(stderr);
          let text = `Exit code: ${code ?? -1}\n`;
          if (out.text) text += `\nstdout:\n${out.text}`;
          if (err.text) text += `\nstderr:\n${err.text}`;
          resolve({ content: [{ type: "text", text }], isError: code !== 0, details: { exitCode: code, stdoutTruncated: out.truncated, stderrTruncated: err.truncated, timeoutMs: t } });
        });
        proc.on("error", (e) => {
          clearTimeout(timer);
          resolve(textResult(String(e), true));
        });
        ctx.signal.addEventListener("abort", () => proc.kill("SIGTERM"));
      });
    },
  };
}
