/**
 * @kern/tui — Markdown component with syntax-highlighted code blocks.
 *
 * Rendering is delegated to @earendil-works/pi-tui's Markdown (marked
 * parser); this module keeps our public API (theme roles, `highlightCode`
 * incl. diff coloring) and maps our theme onto the pi widget theme.
 */

import type { Component } from "./component.js";
import { theme } from "./theme.js";
import {
  Markdown as PiMarkdown,
  type MarkdownTheme as PiMarkdownTheme,
} from "@earendil-works/pi-tui";

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

/**
 * Build a full pi MarkdownTheme from our theme roles. Our code highlighter
 * (including ```diff coloring) is reused via pi's `highlightCode` hook.
 * Roles with no pi equivalent (diffAdd/diffDel/taskChecked/taskUnchecked)
 * stay on our theme for direct use; pi-only `codeBlock` reuses our inline
 * code style and `codeBlockIndent` keeps pi's default.
 */
function toPiTheme(t: MarkdownTheme): PiMarkdownTheme {
  return {
    heading: t.heading,
    link: t.link,
    linkUrl: t.linkUrl,
    code: t.code,
    codeBlock: t.code,
    codeBlockBorder: t.codeBlockBorder,
    quote: t.quote,
    quoteBorder: t.quoteBorder,
    hr: t.hr,
    listBullet: t.listBullet,
    bold: t.bold,
    italic: t.italic,
    strikethrough: t.strikethrough,
    underline: t.underline,
    highlightCode: t.highlightCode ?? highlightCode,
  };
}

export class Markdown implements Component {
  private readonly inner: PiMarkdown;

  constructor(text: string, private readonly theme_: MarkdownTheme = defaultMarkdownTheme) {
    // Pi ctor is (text, paddingX, paddingY, theme); we render full-width.
    this.inner = new PiMarkdown(text, 0, 0, toPiTheme(theme_));
  }

  setText(text: string): void {
    // Pi Markdown has setText (clears its width/text cache); no need to
    // reconstruct the widget.
    this.inner.setText(text);
  }

  render(width: number): string[] {
    return this.inner.render(width);
  }

  invalidate(): void {
    this.inner.invalidate();
  }
}
