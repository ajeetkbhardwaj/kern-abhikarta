import { readdir, stat, readFile } from "node:fs/promises";
import { relative, resolve, dirname, extname } from "node:path";
import { FileGraph } from "./file-graph.js";

export interface RepoFileRecord {
  path: string;
  kind: "file" | "dir";
  extension?: string;
  size?: number;
  modifiedAt?: string;
  imports?: string[];
  exports?: string[];
}

export interface RepoIndexOptions {
  root: string;
  ignoreDirs?: string[];
  ignoreFiles?: RegExp[];
}

export interface RepoIndexQuery {
  path?: string;
  name?: string;
  importName?: string;
}

export class RepoIndex {
  private readonly root: string;
  private readonly ignoreDirs: Set<string>;
  private readonly ignoreFiles: RegExp[];
  private files = new Map<string, RepoFileRecord>();
  private graph = new FileGraph();
  private initialized = false;

  constructor(options: RepoIndexOptions) {
    this.root = resolve(options.root);
    this.ignoreDirs = new Set(["node_modules", ".git", ".next", "dist", "build", "coverage", ".turbo", ...options.ignoreDirs ?? []]);
    this.ignoreFiles = options.ignoreFiles ?? [/^\.env(?:\.|$)/, /session-.*\.md$/i];
  }

  async refresh(): Promise<void> {
    this.files.clear();
    this.graph = new FileGraph();
    await this.walk(this.root);
    this.initialized = true;
  }

  getRoot(): string {
    return this.root;
  }

  async ensureLoaded(): Promise<void> {
    if (!this.initialized) await this.refresh();
  }

  all(): RepoFileRecord[] {
    return [...this.files.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  byPath(path: string): RepoFileRecord | undefined {
    return this.files.get(resolve(path));
  }

  searchByName(name: string): RepoFileRecord[] {
    const needle = name.toLowerCase();
    return this.all().filter((file) => file.path.toLowerCase().includes(needle) || file.path.split("/").at(-1)?.toLowerCase().includes(needle));
  }

  searchByImport(importName: string): RepoFileRecord[] {
    const needle = importName.toLowerCase();
    return this.all().filter((file) => file.imports?.some((entry) => entry.toLowerCase().includes(needle)) || false);
  }

  fileGraph(): FileGraph {
    return this.graph;
  }

  private async walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith("." ) && entry.name !== ".agents" && entry.name !== ".pi") {
        if (entry.isDirectory()) continue;
      }
      if (entry.isDirectory()) {
        if (this.ignoreDirs.has(entry.name)) continue;
        await this.walk(resolve(dir, entry.name));
        continue;
      }

      const fullPath = resolve(dir, entry.name);
      if (this.isIgnoredFile(fullPath)) continue;

      const stats = await stat(fullPath).catch(() => null);
      if (!stats || !stats.isFile()) continue;

      const rel = relative(this.root, fullPath).split("\\").join("/");
      const ext = extname(fullPath) || undefined;
      const imports = await this.collectImports(fullPath);
      const exports = await this.collectExports(fullPath);
      const record: RepoFileRecord = {
        path: fullPath,
        kind: "file",
        extension: ext,
        size: stats.size,
        modifiedAt: stats.mtime.toISOString(),
        imports,
        exports,
      };
      this.files.set(fullPath, record);
      this.graph.add(fullPath, imports, exports);
    }
  }

  private async collectImports(filePath: string): Promise<string[]> {
    try {
      const text = await readFile(filePath, "utf8");
      const matches = [...text.matchAll(/from\s+["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g)];
      const result = new Set<string>();
      for (const match of matches) {
        const value = match[1] ?? match[2];
        if (!value) continue;
        if (value.startsWith(".") || value.startsWith("/") || value.startsWith("@/")) {
          result.add(resolve(dirname(filePath), value));
        } else {
          result.add(value);
        }
      }
      return [...result];
    } catch {
      return [];
    }
  }

  private async collectExports(filePath: string): Promise<string[]> {
    try {
      const text = await readFile(filePath, "utf8");
      const symbols = new Set<string>();
      for (const pattern of [
        /export\s+(?:async\s+)?function\s+(\w+)/g,
        /export\s+class\s+(\w+)/g,
        /export\s+interface\s+(\w+)/g,
        /export\s+type\s+(\w+)/g,
        /export\s+const\s+(\w+)/g,
        /export\s+\{\s*([^}]+)\s*\}/g,
      ]) {
        const matches = text.matchAll(pattern);
        for (const match of matches) {
          const value = match[1];
          if (value) {
            const names = value.split(",").map((n) => n.trim().split(/\s+|\s*as\s*/)[0]).filter((name): name is string => !!name);
            for (const name of names) symbols.add(name);
          }
        }
      }
      return [...symbols];
    } catch {
      return [];
    }
  }

  private isIgnoredFile(filePath: string): boolean {
    const base = filePath.split("/").at(-1) ?? "";
    return this.ignoreFiles.some((re) => re.test(base));
  }
}
