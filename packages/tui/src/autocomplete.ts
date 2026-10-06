/**
 * @kern/tui — slash-command + file autocomplete provider.
 *
 * Completes a leading or mid-prompt `/command` and `@file` tokens against
 * the command list and a cached workspace file walk. Ghost text shows the
 * top match; Tab inserts it.
 */

import { readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { AutocompleteProvider } from "./editor.js";

export interface CommandDef {
  name: string;
  description: string;
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  "coverage",
  "__pycache__",
  ".venv",
  "target",
]);

export class KernAutocomplete implements AutocompleteProvider {
  private files: string[] = [];
  private filesAt = 0;

  constructor(
    private readonly commands: CommandDef[],
    private readonly cwd: string,
  ) {}

  async refreshFiles(): Promise<void> {
    try {
      this.files = await walkFiles(this.cwd);
      this.filesAt = Date.now();
    } catch {
      // keep the old cache
    }
  }

  fileList(): string[] {
    return this.files;
  }

  private topSlash(prefix: string): string | null {
    const names = this.commands.map((c) => "/" + c.name);
    return names.find((n) => n.startsWith(prefix) && n !== prefix) ?? null;
  }

  private topFile(prefix: string): string | null {
    const lower = prefix.toLowerCase();
    return this.files.find((f) => f.toLowerCase().startsWith(lower)) ?? null;
  }

  complete(beforeCursor: string): { insert: string; dropdown: null } | null {
    const slash = beforeCursor.match(/(^|\s)(\/[A-Za-z-]*)$/);
    if (slash) {
      const prefix = slash[2] ?? "";
      const match = this.topSlash(prefix);
      if (match) return { insert: match.slice(prefix.length) + " ", dropdown: null };
      return null;
    }
    const mention = beforeCursor.match(/(^|\s)@([^\s]*)$/);
    if (mention) {
      const prefix = mention[2] ?? "";
      const match = this.topFile(prefix);
      if (match) {
        const rest = match.slice(prefix.length);
        return { insert: (rest.length > 0 ? rest : "") + " ", dropdown: null };
      }
    }
    return null;
  }

  ghost(beforeCursor: string): string {
    const slash = beforeCursor.match(/(^|\s)(\/[A-Za-z-]*)$/);
    if (slash) {
      const prefix = slash[2] ?? "";
      const names = this.commands.map((c) => "/" + c.name);
      const matches = names.filter((n) => n.startsWith(prefix) && n !== prefix);
      if (matches.length > 0) {
        const extra = matches.length > 1 ? `  (+${matches.length - 1})` : "";
        return (matches[0] ?? "").slice(prefix.length) + extra;
      }
      return "";
    }
    const mention = beforeCursor.match(/(^|\s)@([^\s]*)$/);
    if (mention) {
      const prefix = (mention[2] ?? "").toLowerCase();
      const matches = this.files.filter((f) => f.toLowerCase().startsWith(prefix)).slice(0, 4);
      if (matches.length > 0) return (matches[0] ?? "").slice(prefix.length);
    }
    return "";
  }
}

async function walkFiles(cwd: string, limit = 3000): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (out.length >= limit || depth > 6) return;
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const name of entries.sort()) {
      if (out.length >= limit) return;
      if (name.startsWith(".")) {
        if (name !== ".agents" && name !== ".kern") continue;
      }
      if (SKIP_DIRS.has(name)) continue;
      const abs = join(dir, name);
      let st;
      try {
        st = await stat(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) await walk(abs, depth + 1);
      else if (st.isFile()) out.push(relative(cwd, abs).split(sep).join("/"));
    }
  };
  await walk(cwd, 0);
  return out;
}
