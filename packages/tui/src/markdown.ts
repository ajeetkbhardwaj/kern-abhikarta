/**
 * @kern/tui — Markdown component with syntax-highlighted code blocks.
 *
 * Full-text render (not per-line streaming): the orchestrator accumulates
 * assistant text and calls setText per delta; layout caches by width+text.
 */

import type { Component } from "./component.js";
import { wrapTextWithAnsi } from "./text.js";
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
};

const KEYWORDS =
  /\b(const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|import|from|export|default|async|await|try|catch|finally|throw|typeof|interface|type|enum|def|elif|fn|struct|impl|match|use|pub|echo|then|fi|done|null|true|false|None|True|False)\b/g;

/** Generic keyword/string/comment/number highlighter for fenced code. */
export function highlightCode(code: string): string[] {
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

export class Markdown implements Component {
  private cachedWidth = -1;
  private cachedRows: string[] | null = null;

  constructor(private text: string, private readonly theme_: MarkdownTheme = defaultMarkdownTheme) {}

  setText(text: string): void {
    if (text === this.text) return;
    this.text = text;
    this.cachedRows = null;
  }

  render(width: number): string[] {
    if (this.cachedRows && this.cachedWidth === width) return this.cachedRows;
    const rows = renderMarkdown(this.text, this.theme_, width);
    this.cachedWidth = width;
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
    rows.push(t.codeBlockBorder("```" + fenceLang));
    const highlighted = t.highlightCode ? t.highlightCode(fenceBuffer.join("\n"), fenceLang || undefined) : fenceBuffer;
    for (const line of highlighted) rows.push(...wrapTextWithAnsi("  " + line, width));
    rows.push(t.codeBlockBorder("```"));
    fenceBuffer = [];
  };
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("```")) {
      if (inFence) {
        flushFence();
        inFence = false;
      } else {
        inFence = true;
        fenceLang = trimmed.slice(3).trim();
      }
      continue;
    }
    if (inFence) {
      fenceBuffer.push(line);
      continue;
    }
    const heading = line.match(/^(\s{0,3})(#{1,6})\s+(.*)$/);
    if (heading) {
      rows.push(...wrapTextWithAnsi(`${heading[1]}${t.heading(heading[3] ?? "")}`, width));
      continue;
    }
    if (/^\s*---+\s*$/.test(line)) {
      rows.push(t.hr("─".repeat(Math.max(8, Math.min(width, 40)))));
      continue;
    }
    if (/^\s*>/.test(line)) {
      rows.push(...wrapTextWithAnsi(t.quoteBorder("│ ") + t.quote(styleInline(line.replace(/^\s*>\s?/, ""), t)), width));
      continue;
    }
    const list = line.match(/^(\s*)([-*+]|\d+[.)])(\s+)(.*)$/);
    if (list) {
      rows.push(...wrapTextWithAnsi(`${list[1]}${t.listBullet(list[2] ?? "")}${list[3]}${styleInline(list[4] ?? "", t)}`, width));
      continue;
    }
    rows.push(...wrapTextWithAnsi(styleInline(line, t), width));
  }
  if (inFence) {
    // Unclosed fence (still streaming): render contents as code so far.
    rows.push(t.codeBlockBorder("```" + fenceLang));
    const highlighted = t.highlightCode ? t.highlightCode(fenceBuffer.join("\n"), fenceLang || undefined) : fenceBuffer;
    for (const hl of highlighted) rows.push(...wrapTextWithAnsi("  " + hl, width));
  }
  return rows;
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
