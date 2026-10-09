/**
 * @kern/tui — slash-command + file autocomplete provider.
 *
 * Completes a leading or mid-prompt `/command` and `@file` tokens against
 * the command list and a cached workspace file walk. Ghost text shows the
 * top match; Tab inserts it; `list()` feeds the editor dropdown with fuzzy
 * subsequence-ranked matches (commands before files). Synchronous and fast.
 */

import { readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { AutocompleteProvider, DropdownItem } from "./editor.js";

export interface CommandDef {
  name: string;
  description: string;
}

/** Max dropdown rows returned by list(). Keeps render + scoring cheap. */
export const MAX_SUGGESTIONS = 8;

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
  private filesLower: string[] = [];
  private filesAt = 0;

  constructor(
    private readonly commands: CommandDef[],
    private readonly cwd: string,
  ) {}

  async refreshFiles(): Promise<void> {
    try {
      this.files = await walkFiles(this.cwd);
      this.filesLower = this.files.map((f) => f.toLowerCase());
      this.filesAt = Date.now();
    } catch {
      // keep the old cache
    }
  }

  fileList(): string[] {
    return this.files;
  }

  private rankSlash(query: string): Array<{ name: string; score: number }> {
    const out: Array<{ name: string; score: number }> = [];
    for (const c of this.commands) {
      const s = fuzzyScore(query, c.name);
      if (s !== null) out.push({ name: c.name, score: s });
    }
    out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    return out;
  }

  private rankFiles(query: string, limit: number): Array<{ file: string; score: number }> {
    const q = query.toLowerCase();
    const out: Array<{ file: string; score: number }> = [];
    for (let i = 0; i < this.files.length; i++) {
      const target = this.filesLower[i] ?? "";
      const s = fuzzyScore(q, target);
      if (s !== null) out.push({ file: this.files[i] ?? "", score: s });
    }
    out.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
    return out.slice(0, limit);
  }

  private topSlash(prefix: string): string | null {
    const query = prefix.startsWith("/") ? prefix.slice(1) : prefix;
    const ranked = this.rankSlash(query);
    const top = ranked[0];
    if (!top) return null;
    const full = "/" + top.name;
    return full !== prefix ? full : null;
  }

  private topFile(prefix: string): string | null {
    const ranked = this.rankFiles(prefix, 1);
    return ranked[0]?.file ?? null;
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
      const query = prefix.startsWith("/") ? prefix.slice(1) : prefix;
      const ranked = this.rankSlash(query).slice(0, 4);
      // Never ghost the exact full command.
      const pending = ranked.filter((r) => "/" + r.name !== prefix);
      if (pending.length > 0) {
        const top = pending[0] as { name: string };
        const full = "/" + top.name;
        const extra = pending.length > 1 ? `  (+${pending.length - 1})` : "";
        return full.slice(prefix.length) + extra;
      }
      return "";
    }
    const mention = beforeCursor.match(/(^|\s)@([^\s]*)$/);
    if (mention) {
      const prefix = mention[2] ?? "";
      const ranked = this.rankFiles(prefix, 4);
      if (ranked.length > 0) {
        const top = ranked[0]?.file ?? "";
        const extra = ranked.length > 1 ? `  (+${ranked.length - 1})` : "";
        return top.slice(prefix.length) + extra;
      }
    }
    return "";
  }

  /** Ranked dropdown items for the token ending at the cursor. */
  list(beforeCursor: string): DropdownItem[] {
    const slash = beforeCursor.match(/(^|\s)(\/[A-Za-z-]*)$/);
    // Commands rank before files: slash context wins when both could match.
    if (slash) {
      const prefix = slash[2] ?? "";
      const query = prefix.startsWith("/") ? prefix.slice(1) : prefix;
      const ranked = this.rankSlash(query).slice(0, MAX_SUGGESTIONS);
      const desc = new Map(this.commands.map((c) => [c.name, c.description]));
      return ranked
        .filter((r) => "/" + r.name !== prefix)
        .map((r) => ({
          insert: ("/" + r.name).slice(prefix.length) + " ",
          display: "/" + r.name,
          description: desc.get(r.name) ?? "",
          kind: "command" as const,
        }));
    }
    const mention = beforeCursor.match(/(^|\s)@([^\s]*)$/);
    if (mention) {
      const prefix = mention[2] ?? "";
      return this.rankFiles(prefix, MAX_SUGGESTIONS).map((r) => ({
        insert: r.file.slice(prefix.length) + " ",
        display: r.file,
        kind: "file" as const,
      }));
    }
    return [];
  }
}

/**
 * Fuzzy subsequence score (higher ranks first), null when `query` is not a
 * subsequence of `target`. Case-insensitive; both inputs should already be
 * lowercased for file paths (commands lower themselves). Fast single pass.
 */
export function fuzzyScore(query: string, target: string): number | null {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (q.length === 0) return 100 - t.length * 0.05;
  if (q.length > t.length) return null;
  let prev = -2;
  let first = -1;
  let gaps = 0;
  let contiguous = 0;
  let ti = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const want = q[qi];
    let found = -1;
    for (let k = ti; k < t.length; k++) {
      if (t[k] === want) {
        found = k;
        break;
      }
    }
    if (found === -1) return null;
    if (first === -1) first = found;
    if (found === prev + 1) contiguous++;
    else gaps += found - prev - 1;
    prev = found;
    ti = found + 1;
  }
  let score = contiguous * 15 - gaps * 8 + q.length * 5 - t.length * 0.2;
  if (first === 0) score += 300;
  else {
    score -= first * 5;
    const before = t[first - 1] ?? "";
    if (before === "/" || before === "-" || before === "_" || before === "." || before === " ") score += 150;
  }
  // Exact-prefix comparisons sort above gappy subsequence hits.
  if (t.startsWith(q)) score += 200;
  return score;
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
