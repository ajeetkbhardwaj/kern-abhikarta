/**
 * @kern/tui — Markdown component with syntax-highlighted code blocks.
 *
 * Full-text render (not per-line streaming): the orchestrator accumulates
 * assistant text and calls setText per delta; layout caches by width+text.
 */

import type { Component } from "./component.js";
import { wrapTextWithAnsi, truncateToWidth, visibleWidth, stripAnsi } from "./text.js";
import { theme } from "./theme.js";

export interface MarkdownTheme {
  heading: (text: string) => string;
  link: (text: string) => string;
  linkUrl: (text: string) => string;
  code: (text: string) => string;
  codeBlockBorder: (text: string) => string;
  quote: (text: string) => string;
  quoteBorder: (text: string) => string;
  hr: (text: string) => string;
  listBullet: (text: string) => string;
  bold: (text: string) => string;
  italic: (text: string) => string;
  strikethrough: (text: string) => string;
  underline: (text: string) => string;
  highlightCode?: (code: string, lang?: string) => string[];
  diffAdd?: (text: string) => string;
  diffDel?: (text: string) => string;
  taskChecked?: (text: string) => string;
  taskUnchecked?: (text: string) => string;
}

export const defaultMarkdownTheme: MarkdownTheme = {
  heading: (s) => theme.accent(theme.bold(s)),
  link: (s) => `\u001b[4;36m${s}\u001b[0m`,
  linkUrl: theme.muted,
  code: theme.tool,
  codeBlockBorder: theme.muted,
  quote: theme.muted,
  quoteBorder: theme.muted,
  hr: theme.muted,
  listBullet: theme.accent,
  bold: theme.bold,
  italic: (s) => `\u001b[3m${s}\u001b[0m`,
  strikethrough: (s) => `\u001b[9m${s}\u001b[0m`,
  underline: (s) => `\u001b[4m${s}\u001b[0m`,
  highlightCode,
  diffAdd: theme.diffAdd,
  diffDel: theme.diffDel,
  taskChecked: theme.success,
  taskUnchecked: theme.warn,
};

const KEYWORDS =
  /\b(const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|import|from|export|default|async|await|try|catch|finally|throw|typeof|interface|type|enum|def|elif|fn|struct|impl|match|use|pub|echo|then|fi|done|null|true|false|None|True|False)\b/g;

/** Generic keyword/string/comment/number highlighter for fenced code. */
export function highlightCode(code: string, lang?: string): string[] {
  if ((lang ?? "").toLowerCase() === "diff") return highlightDiff(code);
  return code.split("\n").map((line) => {
    const comment = line.match(/(\/\/|#|--).*$/);
    let body = line;
    let tail = "";
    if (comment && (comment.index ?? 0) > 0) {
      const idx = comment.index ?? line.length;
      // Avoid treating URLs / colors as comments: require start or space before #.
      if (comment[1] !== "#" || idx === 0 || /\s/.test(line[idx - 1] ?? "")) {
        tail = theme.muted(line.slice(idx));
        body = line.slice(0, idx);
      }
    }
    body = body
      .replace(/("[^"\n]*"|'[^'\n]*'|`[^`\n]*`)/g, (m) => theme.tool(m))
      .replace(KEYWORDS, (m) => theme.accent(m))
      .replace(/\b(\d[\d._]*)\b/g, (m) => `\u001b[33m${m}\u001b[0m`);
    return body + tail;
  });
}

/** Red/green line coloring for ```diff fences. */
export function highlightDiff(code: string): string[] {
  return code.split("\n").map((line) => {
    if (/^@@/.test(line)) return theme.accent(line);
    if (/^\+\+\+/.test(line) || /^---/.test(line)) return theme.muted(line);
    if (line.startsWith("+")) return theme.diffAdd(line);
    if (line.startsWith("-")) return theme.diffDel(line);
    return line;
  });
}

export class Markdown implements Component {
  private cachedWidth = -1;
  private cachedText = "";
  private cachedRows: string[] | null = null;

  constructor(private text: string, private readonly theme_: MarkdownTheme = defaultMarkdownTheme) {
    this.cachedText = text;
  }

  setText(text: string): void {
    if (text === this.text) return;
    this.text = text;
    this.cachedRows = null;
  }

  render(width: number): string[] {
    if (this.cachedRows && this.cachedWidth === width && this.cachedText === this.text) return this.cachedRows;
    const rows = renderMarkdown(this.text, this.theme_, width);
    this.cachedWidth = width;
    this.cachedText = this.text;
    this.cachedRows = rows;
    return rows;
  }

  invalidate(): void {
    this.cachedRows = null;
  }
}

function renderMarkdown(text: string, t: MarkdownTheme, width: number): string[] {
  const rows: string[] = [];
  const lines = text.split("\n");
  let inFence = false;
  let fenceBuffer: string[] = [];
  let fenceLang = "";
  const flushFence = () => {
    const label = fenceLang ? ` ${fenceLang} ` : "";
    rows.push(t.codeBlockBorder("╭─" + label + "─".repeat(Math.max(0, Math.min(width, 60) - label.length - 3))));
    const highlighted = t.highlightCode ? t.highlightCode(fenceBuffer.join("\n"), fenceLang || undefined) : fenceBuffer;
    for (const line of highlighted) rows.push(...wrapTextWithAnsi("│ " + line, width));
    rows.push(t.codeBlockBorder("╰" + "─".repeat(Math.max(0, Math.min(width, 60) - 1))));
    fenceBuffer = [];
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const trimmed = line.trimStart();
    if (trimmed.startsWith("```")) {
      if (inFence) {
        flushFence();
        inFence = false;
      } else {
        inFence = true;
        fenceLang = trimmed.slice(3).trim();
      }
      i++;
      continue;
    }
    if (inFence) {
      fenceBuffer.push(line);
      i++;
      continue;
    }
    // Table-ish alignment: consecutive pipe rows render column-aligned.
    if (isTableRow(line) && isTableRow(lines[i + 1] ?? "")) {
      const block: string[] = [line];
      let j = i + 1;
      while (j < lines.length && isTableRow(lines[j] ?? "")) {
        block.push(lines[j] ?? "");
        j++;
      }
      rows.push(...renderTable(block, t, width));
      i = j;
      continue;
    }
    const heading = line.match(/^(\s{0,3})(#{1,6})\s+(.*)$/);
    if (heading) {
      rows.push(...wrapTextWithAnsi(`${heading[1]}${t.heading(heading[3] ?? "")}`, width));
      i++;
      continue;
    }
    if (/^\s*---+\s*$/.test(line)) {
      rows.push(t.hr("─".repeat(Math.max(8, Math.min(width, 40)))));
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      rows.push(...wrapTextWithAnsi(t.quoteBorder("│ ") + t.quote(styleInline(line.replace(/^\s*>\s?/, ""), t)), width));
      i++;
      continue;
    }
    const task = line.match(/^(\s*)([-*+]|\d+[.)])(\s+)\[([ xX])\](\s+)(.*)$/);
    if (task) {
      const checked = (task[4] ?? "").toLowerCase() === "x";
      const glyph = checked
        ? (t.taskChecked ?? theme.success)("☑")
        : (t.taskUnchecked ?? theme.warn)("☐");
      rows.push(
        ...wrapTextWithAnsi(
          `${task[1]}${t.listBullet(task[2] ?? "")}${task[3]}${glyph}${task[5]}${styleInline(task[6] ?? "", t)}`,
          width,
        ),
      );
      i++;
      continue;
    }
    const list = line.match(/^(\s*)([-*+]|\d+[.)])(\s+)(.*)$/);
    if (list) {
      rows.push(...wrapTextWithAnsi(`${list[1]}${t.listBullet(list[2] ?? "")}${list[3]}${styleInline(list[4] ?? "", t)}`, width));
      i++;
      continue;
    }
    rows.push(...wrapTextWithAnsi(styleInline(line, t), width));
    i++;
  }
  if (inFence) {
    // Unclosed fence (still streaming): render contents as code so far.
    const label = fenceLang ? ` ${fenceLang} ` : "";
    rows.push(t.codeBlockBorder("╭─" + label + "─".repeat(Math.max(0, Math.min(width, 60) - label.length - 3))));
    const highlighted = t.highlightCode ? t.highlightCode(fenceBuffer.join("\n"), fenceLang || undefined) : fenceBuffer;
    for (const hl of highlighted) rows.push(...wrapTextWithAnsi("│ " + hl, width));
  }
  return rows;
}

function isTableRow(line: string): boolean {
  if (!line.includes("|")) return false;
  const trimmed = line.trim();
  if (/^\|?[\s:|-]+\|?$/.test(trimmed) && /[-|:]/.test(trimmed)) return true; // separator row
  return (trimmed.match(/\|/g) ?? []).length >= 1 && trimmed.length > 2;
}

function splitCells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

function isSeparatorRow(line: string): boolean {
  const cells = splitCells(line);
  return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c));
}

/** Align pipe-table columns with space padding; separator rows get ─ rules. */
function renderTable(block: string[], t: MarkdownTheme, width: number): string[] {
  const parsed = block.map(splitCells);
  const cols = Math.max(...parsed.map((r) => r.length));
  const norm = parsed.map((r) => {
    const row = [...r];
    while (row.length < cols) row.push("");
    return row;
  });
  const content = norm.filter((_, idx) => !isSeparatorRow(block[idx] ?? ""));
  const widths: number[] = new Array<number>(cols).fill(3);
  for (let c = 0; c < cols; c++) {
    let w = 3;
    for (const row of content) w = Math.max(w, visibleWidth(stripAnsi(row[c] ?? "")));
    widths[c] = w;
  }
  // Shrink columns proportionally so the row fits width.
  const chrome = cols * 3 + 1; // "| " per col + trailing "|"
  let total = chrome + widths.reduce((a, b) => a + b, 0);
  if (total > width) {
    let over = total - width;
    const minW = 3;
    while (over > 0) {
      let progress = false;
      for (let c = 0; c < cols && over > 0; c++) {
        const w = widths[c] ?? minW;
        if (w > minW) {
          widths[c] = w - 1;
          over--;
          progress = true;
        }
      }
      if (!progress) break;
    }
    total = chrome + widths.reduce((a, b) => a + b, 0);
  }
  const hasHeader = block.length >= 2 && isSeparatorRow(block[1] ?? "");
  return block.map((line, idx) => {
    const cells = norm[idx] ?? [];
    if (isSeparatorRow(line)) {
      const rule = `| ${widths.map((w) => "─".repeat(w)).join("─┼─")} |`;
      return truncateToWidth(theme.muted(rule), width, "…");
    }
    const styled = cells.map((c, cIdx) => {
      const w = widths[cIdx] ?? 3;
      const text = styleInline(c, t);
      const pad = Math.max(0, w - visibleWidth(stripAnsi(c)));
      return text + " ".repeat(pad);
    });
    const row = `| ${styled.join(" | ")} |`;
    return truncateToWidth(idx === 0 && hasHeader ? t.bold(row) : row, width, "…");
  });
}

function styleInline(line: string, t: MarkdownTheme): string {
  // Links first so brackets inside code spans don't confuse the matcher.
  let out = line.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text: string, url: string) => `${t.link(text)}${t.linkUrl(` (${url})`)}`);
  const parts = out.split("`");
  let rebuilt = "";
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] ?? "";
    if (i % 2 === 1) rebuilt += t.code(`\`${part}\``);
    else {
      rebuilt += part
        .replace(/\*\*(.+?)\*\*/g, (_, b: string) => t.bold(b))
        .replace(/(^|[^*\w])\*([^*\n]+)\*/g, (_, pre: string, b: string) => `${pre}${t.italic(b)}`)
        .replace(/~~(.+?)~~/g, (_, b: string) => t.strikethrough(b));
    }
  }
  return rebuilt;
}
