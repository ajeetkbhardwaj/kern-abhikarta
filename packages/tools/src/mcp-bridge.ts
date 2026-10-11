/**
 * @kern/tools — opt-in MCP bridge (plugin, not core).
 *
 * Core stays minimal (read/write/edit/bash only). Users who want MCP add
 * a file (mcp.json / .mcp.json / .vscode/mcp.json, or ~/.kern/mcp.json)
 * or set KERN_MCP_URL / KERN_MCP_COMMAND. Four generic tools then work
 * with ANY server: mcp_inventory, mcp_read, mcp_call_read, mcp_call.
 * No per-server tools are registered. Fail-closed: any protocol error
 * yields zero tools (core runs unchanged).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { ToolDefinition, ToolResult } from "@kern/protocol";
import { boundText, textResult } from "@kern/protocol";

interface McpToolSchema {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
}


class McpStdioClient {
  private proc: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(private command: string) {
    this.proc = spawn("sh", ["-c", command], { stdio: ["pipe", "pipe", "inherit"] });
    this.proc.on("error", (err) => this.failAll(err instanceof Error ? err : new Error(String(err))));
    this.proc.on("exit", () => this.failAll(new Error("MCP server exited")));
    const rl = createInterface({ input: this.proc.stdout! });
    rl.on("line", (line) => this.onLine(line));
    const kill = () => {
      try { this.proc.kill("SIGTERM"); } catch { /* already dead */ }
    };
    process.once("exit", kill);
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      msg = JSON.parse(trimmed) as typeof msg;
    } catch {
      return;
    }
    if (typeof msg.id !== "number") return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(msg.error.message ?? "MCP error"));
    else p.resolve(msg.result);
  }

  request(method: string, params?: unknown, timeoutMs = 30_000): Promise<unknown> {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }) + "\n";
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.proc.stdin!.write(payload, (err) => {
        if (err) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
  }

  notify(method: string, params?: unknown): void {
    try {
      this.proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method, params: params ?? {} }) + "\n");
    } catch { /* fail-closed: server reads what it gets */ }
  }

  dispose(): void {
    try { this.proc.kill("SIGTERM"); } catch { /* already dead */ }
    this.failAll(new Error("MCP client disposed"));
  }
}

/** Single tools/call over a short-lived stdio connection. Fail-closed. */
async function mcpStdioCall(command: string, tool: string, args: unknown, timeoutMs: number): Promise<{ content?: unknown; isError?: unknown }> {
  const client = new McpStdioClient(command);
  try {
    await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "kern", version: "0.0.1" },
    }, Math.min(timeoutMs, 15_000));
    client.notify("notifications/initialized", {});
    return await client.request("tools/call", { name: tool, arguments: args ?? {} }, timeoutMs) as { content?: unknown; isError?: unknown };
  } finally {
    client.dispose();
  }
}

/** Connect, handshake, list tools. Throws fail-closed (caller logs, core continues). */
export async function listMcpStdioTools(command: string, timeoutMs = 30_000): Promise<McpToolSchema[]> {
  const client = new McpStdioClient(command);
  try {
    await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "kern", version: "0.0.1" },
    }, timeoutMs);
    client.notify("notifications/initialized", {});
    const result = await client.request("tools/list", {}, timeoutMs) as { tools?: McpToolSchema[] };
    const tools = Array.isArray(result?.tools) ? result.tools : [];
    return tools.filter((t) => typeof t?.name === "string" && t.name.length > 0);
  } finally {
    client.dispose();
  }
}

function toToolResult(content: unknown, isError: unknown): ToolResult {
  const blocks: Array<{ type: "text"; text: string }> = [];
  if (Array.isArray(content)) {
    for (const item of content as Array<{ type?: string; text?: unknown; resource?: { text?: unknown; uri?: unknown } }>) {
      if (typeof item?.text === "string" && item.text.length > 0) blocks.push({ type: "text", text: item.text });
      else if (item?.resource && typeof item.resource.text === "string" && item.resource.text.length > 0) {
        blocks.push({ type: "text", text: `[${String(item.resource.uri ?? "resource")}]\n${item.resource.text}` });
      } else if (item?.type === "image" || item?.type === "audio") blocks.push({ type: "text", text: `[${item.type} content omitted — not text]` });
    }
  }
  const joined = blocks.map((b) => b.text).join("\n") || "(empty MCP result)";
  const bounded = boundText(joined);
  return {
    content: [{ type: "text", text: bounded.text }],
    isError: isError === true,
    details: bounded.truncated ? { truncated: true } : undefined,
  };
}


// ---------------------------------------------------------------------------
// Streamable HTTP transport (e.g. https://ai.engineer/mcp).
// Stateless POST-per-request; parses SSE (`data:`) or plain JSON.
// ---------------------------------------------------------------------------

/** Extract the JSON-RPC payload from an SSE or plain-JSON body. */
function parseMcpHttpBody(body: string): { result?: unknown; error?: { message?: string } } {
  const trimmed = body.trim();
  if (!trimmed) throw new Error("Empty MCP HTTP response");
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return JSON.parse(trimmed) as { result?: unknown; error?: { message?: string } };
  }
  const dataLines = trimmed
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim())
    .filter((d) => d && d !== "[DONE]");
  if (dataLines.length === 0) throw new Error("No data in MCP SSE response");
  return JSON.parse(dataLines[dataLines.length - 1]!) as { result?: unknown; error?: { message?: string } };
}

async function mcpHttpRpc(url: string, method: string, params: unknown, id: number, timeoutMs: number, headers: Record<string, string> = {}): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`MCP HTTP ${res.status} on ${method}`);
    const parsed = parseMcpHttpBody(await res.text());
    if (parsed.error) throw new Error(parsed.error.message ?? `MCP ${method} error`);
    return parsed.result;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error(`MCP request timed out: ${method}`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Paginated list helper: follows cursor, caps 200 items. Fail-closed like RPC. */
async function mcpHttpList(url: string, method: string, key: string, headers: Record<string, string>, timeoutMs: number): Promise<unknown[]> {
  const items: unknown[] = [];
  let cursor: unknown = undefined;
  let id = 100;
  for (let page = 0; page < 5 && items.length < 200; page++) {
    const result = await mcpHttpRpc(url, method, cursor === undefined ? {} : { cursor }, id++, timeoutMs, headers) as { [k: string]: unknown; nextCursor?: unknown };
    const chunk = result?.[key];
    if (Array.isArray(chunk)) items.push(...chunk.slice(0, 200 - items.length));
    if (typeof result?.nextCursor === "string" && result.nextCursor.length > 0) cursor = result.nextCursor;
    else break;
  }
  return items;
}

// ---------------------------------------------------------------------------
// Workspace mcp.json discovery (editor convention).
//
// Files (first hit wins per server name, user-level wins over project):
//   <cwd>/mcp.json, <cwd>/.mcp.json, <cwd>/.vscode/mcp.json  (project, shared)
//   ~/.kern/mcp.json                                          (user, private)
// Shapes (both accepted, VS Code `servers` + portable `mcpServers`):
//   { "servers":    { "name": { "url": "https://…" } } }
//   { "servers":    { "name": { "command": "npx", "args": [...] } } }
//   { "mcpServers": { "name": { ...same... } } }
//
// Trust rule (workspace trust): project files are untrusted, so stdio
// servers from project files are REFUSED with a warning — a cloned repo
// must not execute local commands. http(s) servers are safe to auto-load.
// stdio belongs in ~/.kern/mcp.json or KERN_MCP_COMMAND.
// ---------------------------------------------------------------------------

export interface McpServerDef {
  name: string;
  url?: string;
  command?: string;
  /** Extra HTTP headers (e.g. Authorization). Never logged — redacted at the logger. */
  headers?: Record<string, string>;
  /** Origin determines trust: project files never run local commands. */
  origin: "project" | "user" | "env";
}

function shellJoin(command: string, args: unknown): string {
  const parts = [command];
  if (Array.isArray(args)) {
    for (const a of args) {
      const s = String(a);
      parts.push(/^[A-Za-z0-9_./:=-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
    }
  }
  return parts.join(" ");
}

function parseMcpJsonFile(text: string, origin: McpServerDef["origin"]): McpServerDef[] {
  let parsed: { servers?: Record<string, Record<string, unknown>>; mcpServers?: Record<string, Record<string, unknown>> };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    return [];
  }
  const table = { ...(parsed.servers ?? {}), ...(parsed.mcpServers ?? {}) };
  const defs: McpServerDef[] = [];
  for (const [name, cfg] of Object.entries(table)) {
    if (!cfg || typeof cfg !== "object") continue;
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) continue;
    const url = typeof cfg["url"] === "string" ? (cfg["url"] as string).trim() : undefined;
    const headers = parseHeaders(cfg["headers"]);
    if (url && /^https?:\/\//i.test(url)) {
      defs.push({ name, url, headers, origin });
      continue;
    }
    const command = typeof cfg["command"] === "string" ? (cfg["command"] as string).trim() : undefined;
    if (command) {
      defs.push({ name, command: shellJoin(command, cfg["args"]), headers, origin });
    }
  }
  return defs;
}

function parseHeaders(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string" && v.length > 0 && v.length <= 2000) out[k.slice(0, 128)] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Load server defs: env (highest trust) + user file + project files. */
export async function loadMcpServerDefs(cwd: string): Promise<{ defs: McpServerDef[]; warnings: string[] }> {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { homedir } = await import("node:os");
  const defs: McpServerDef[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();

  const take = (list: McpServerDef[]) => {
    for (const d of list) {
      if (seen.has(d.name)) continue;
      if (d.origin === "project" && d.command) {
        warnings.push(`mcp.json: stdio server "${d.name}" from project file refused (untrusted) — move it to ~/.kern/mcp.json to run it.`);
        continue;
      }
      seen.add(d.name);
      defs.push(d);
    }
  };

  // Env first (explicit user intent wins per name).
  const envCommand = process.env["KERN_MCP_COMMAND"]?.trim();
  if (envCommand) take([{ name: "env", command: envCommand, origin: "env" }]);
  const envUrl = process.env["KERN_MCP_URL"]?.trim();
  if (envUrl && /^https?:\/\//i.test(envUrl)) take([{ name: "env", url: envUrl, origin: "env" }]);

  // User file (private, trusted for stdio).
  try {
    const text = await readFile(join(homedir(), ".kern", "mcp.json"), "utf8");
    take(parseMcpJsonFile(text, "user"));
  } catch { /* absent = no user servers */ }

  // Project files (shared, untrusted: http(s) only).
  for (const rel of ["mcp.json", ".mcp.json", ".vscode/mcp.json"]) {
    try {
      const text = await readFile(join(cwd, rel), "utf8");
      take(parseMcpJsonFile(text, "project"));
    } catch { /* absent = skip */ }
  }
  return { defs, warnings };
}

/** Discover + register the generic MCP layer. No per-server tools: 4 tools work with ANY server. Fail-closed per server. */
export async function discoverMcpFileTools(cwd: string, opts: { timeoutMs?: number } = {}): Promise<{ tools: ToolDefinition[]; warnings: string[] }> {
  const { defs, warnings } = await loadMcpServerDefs(cwd);
  if (defs.length === 0) return { tools: [], warnings };
  const timeoutMs = opts.timeoutMs ?? 30_000;
  // Cached tool catalogs per server (annotations included) for read-gating.
  const catalog = new Map<string, McpToolSchema[] | null>();
  const getCatalog = async (def: McpServerDef): Promise<McpToolSchema[]> => {
    const hit = catalog.get(def.name);
    if (hit) return hit;
    try {
      const list = def.url
        ? await mcpHttpList(def.url, "tools/list", "tools", def.headers ?? {}, Math.min(timeoutMs, 15_000)) as McpToolSchema[]
        : await listMcpStdioTools(def.command!, Math.min(timeoutMs, 15_000));
      const clean = list.filter((t) => typeof t?.name === "string" && t.name.length > 0);
      catalog.set(def.name, clean);
      return clean;
    } catch {
      catalog.set(def.name, []);
      return [];
    }
  };
  const findDef = (name: string) => defs.find((d) => d.name === name);
  const serverNames = () => defs.map((d) => d.name).join(", ");

  const inventory: ToolDefinition<{ server?: string; query?: string; kind?: string }> = {
    name: "mcp_inventory",
    description: `List MCP servers (${serverNames()}) and their tools/resources/prompts, optionally filtered by query. Use first to find the right capability before calling it.`,
    inputSchema: {
      type: "object",
      properties: {
        server: { type: "string" },
        query: { type: "string" },
        kind: { type: "string" },
      },
      required: [],
    },
    sideEffect: "read",
    async execute(args) {
      const q = (args.query ?? "").toLowerCase();
      const kind = (args.kind ?? "all").toLowerCase();
      const rows: string[] = [];
      for (const def of defs) {
        if (args.server && def.name !== args.server) continue;
        rows.push(`server ${def.name} (${def.url ? "http" : "stdio"})`);
        try {
          if (kind === "all" || kind === "tool") {
            for (const t of await getCatalog(def)) {
              const line = `  tool ${def.name}/${t.name} — ${String(t.description ?? "").slice(0, 120)}`;
              if (!q || line.toLowerCase().includes(q)) rows.push(line);
            }
          }
          if ((kind === "all" || kind === "resource" || kind === "prompt") && def.url) {
            const res = await mcpHttpList(def.url, "resources/list", "resources", def.headers ?? {}, Math.min(timeoutMs, 15_000)).catch((): unknown[] => []);
            for (const r of res as Array<{ uri?: unknown; name?: unknown }>) {
              const line = `  resource ${def.name}/${String(r.uri ?? r.name)}`;
              if (!q || line.toLowerCase().includes(q)) rows.push(line);
            }
            const prm = await mcpHttpList(def.url, "prompts/list", "prompts", def.headers ?? {}, Math.min(timeoutMs, 15_000)).catch((): unknown[] => []);
            for (const p of prm as Array<{ name?: unknown; description?: unknown }>) {
              const line = `  prompt ${def.name}/${String(p.name)} — ${String(p.description ?? "").slice(0, 120)}`;
              if (!q || line.toLowerCase().includes(q)) rows.push(line);
            }
          }
        } catch (error) {
          rows.push(`  (list failed: ${error instanceof Error ? error.message : String(error)})`);
        }
      }
      const text = rows.length > 0 ? rows.slice(0, 100).join("\n") : "(no MCP servers)";
      const bounded = boundText(text);
      return { content: [{ type: "text", text: bounded.text }], isError: false };
    },
  };

  const read: ToolDefinition<{ server: string; kind: string; uri: string; params?: unknown }> = {
    name: "mcp_read",
    description: "Read an MCP resource (kind resource, uri is the resource URI) or get an MCP prompt (kind prompt, uri is the prompt name, params its arguments object). Read-only, any http server.",
    inputSchema: {
      type: "object",
      properties: {
        server: { type: "string" },
        kind: { type: "string" },
        uri: { type: "string" },
        params: { type: "object" },
      },
      required: ["server", "kind", "uri"],
    },
    sideEffect: "read",
    async execute(args, ctx) {
      const def = findDef(args.server);
      if (!def) return textResult(`Unknown MCP server: ${args.server} (known: ${serverNames()})`, true, { code: "E_TOOL_UNKNOWN" });
      if (!def.url) return textResult(`mcp_read supports http servers; "${def.name}" is stdio — use mcp_call`, true, { code: "E_TOOL_FAILED" });
      if (ctx.signal.aborted) return textResult(`mcp_read aborted`, true, { code: "E_TOOL_FAILED" });
      try {
        const kind = args.kind.toLowerCase();
        const out = kind === "prompt"
          ? await mcpHttpRpc(def.url, "prompts/get", { name: args.uri, arguments: args.params ?? {} }, Date.now() % 100000, timeoutMs, def.headers ?? {}) as { content?: unknown; isError?: unknown }
          : await mcpHttpRpc(def.url, "resources/read", { uri: args.uri }, Date.now() % 100000, timeoutMs, def.headers ?? {}) as { content?: unknown; isError?: unknown };
        return toToolResult(out?.content, out?.isError);
      } catch (error) {
        return textResult(`mcp_read failed: ${error instanceof Error ? error.message : String(error)}`, true, { code: "E_TOOL_FAILED" });
      }
    },
  };

  const callRead: ToolDefinition<{ server: string; tool: string; params?: unknown }> = {
    name: "mcp_call_read",
    description: "Call a read-only MCP tool (any server). Refuses tools not annotated readOnlyHint. Free like read; for anything else use mcp_call (asks approval).",
    inputSchema: {
      type: "object",
      properties: {
        server: { type: "string" },
        tool: { type: "string" },
        params: { type: "object" },
      },
      required: ["server", "tool"],
    },
    sideEffect: "read",
    async execute(args, ctx) {
      const def = findDef(args.server);
      if (!def) return textResult(`Unknown MCP server: ${args.server} (known: ${serverNames()})`, true, { code: "E_TOOL_UNKNOWN" });
      if (!def.url) return textResult(`mcp_call_read supports http servers; "${def.name}" is stdio — use mcp_call`, true, { code: "E_TOOL_FAILED" });
      if (ctx.signal.aborted) return textResult(`mcp_call_read aborted`, true, { code: "E_TOOL_FAILED" });
      const entry = (await getCatalog(def)).find((t) => t.name === args.tool);
      if (!entry) return textResult(`Unknown tool: ${args.server}/${args.tool} — use mcp_inventory to list`, true, { code: "E_TOOL_UNKNOWN" });
      if (entry.annotations?.readOnlyHint !== true) {
        return textResult(`Tool ${args.server}/${args.tool} is not read-only — use mcp_call (asks approval)`, true, { code: "E_TOOL_DENIED" });
      }
      try {
        const out = await mcpHttpRpc(def.url, "tools/call", { name: args.tool, arguments: args.params ?? {} }, Date.now() % 100000, timeoutMs, def.headers ?? {}) as { content?: unknown; isError?: unknown };
        return toToolResult(out?.content, out?.isError);
      } catch (error) {
        return textResult(`mcp_call_read failed: ${error instanceof Error ? error.message : String(error)}`, true, { code: "E_TOOL_FAILED" });
      }
    },
  };

  const call: ToolDefinition<{ server: string; tool: string; params?: unknown }> = {
    name: "mcp_call",
    description: "Call any MCP tool on any server (http or stdio). Asks approval first like bash; denied headless. Prefer mcp_call_read for read-only tools (no prompt).",
    inputSchema: {
      type: "object",
      properties: {
        server: { type: "string" },
        tool: { type: "string" },
        params: { type: "object" },
      },
      required: ["server", "tool"],
    },
    sideEffect: "execute",
    async execute(args, ctx) {
      const def = findDef(args.server);
      if (!def) return textResult(`Unknown MCP server: ${args.server} (known: ${serverNames()})`, true, { code: "E_TOOL_UNKNOWN" });
      if (ctx.signal.aborted) return textResult(`mcp_call aborted`, true, { code: "E_TOOL_FAILED" });
      try {
        const out = def.url
          ? await mcpHttpRpc(def.url, "tools/call", { name: args.tool, arguments: args.params ?? {} }, Date.now() % 100000, timeoutMs, def.headers ?? {}) as { content?: unknown; isError?: unknown }
          : await mcpStdioCall(def.command!, args.tool, args.params ?? {}, timeoutMs);
        return toToolResult(out?.content, out?.isError);
      } catch (error) {
        return textResult(`mcp_call failed: ${error instanceof Error ? error.message : String(error)}`, true, { code: "E_TOOL_FAILED" });
      }
    },
  };

  return { tools: [inventory, read, callRead, call], warnings };
}

