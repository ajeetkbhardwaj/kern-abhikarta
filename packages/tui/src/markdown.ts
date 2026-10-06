/**
 * @kern/tui — streaming markdown-lite renderer.
 *
 * Assistant text arrives as arbitrary deltas. Styling per keystroke would
 * need cross-chunk span tracking, so instead we style per completed line:
 * deltas accumulate until `\n`, then the whole line is styled at once.
 * Only fenced code blocks carry state across lines (`inFence`).
 *
 * Deliberately modest: headings, quotes, list markers, bold, inline code,
 * fences. Plain text passes through untouched.
 */

import { theme } from "./theme.js";

export class MarkdownStream {
  private pending = "";
  private inFence = false;

  /** Push a delta; returns styled, ready-to-write output (may be empty). */
  push(delta: string): string {
    this.pending += delta;
    let out = "";
    let idx = this.pending.indexOf("\n");
    while (idx !== -1) {
      out += this.styleLine(this.pending.slice(0, idx)) + "\n";
      this.pending = this.pending.slice(idx + 1);
      idx = this.pending.indexOf("\n");
    }
    return out;
  }

  /** Flush the remainder (styled as a line even without trailing newline). */
  flush(): string {
    if (!this.pending) return "";
    const out = this.styleLine(this.pending);
    this.pending = "";
    return out;
  }

  reset(): void {
    this.pending = "";
    this.inFence = false;
  }

  private styleLine(line: string): string {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("```")) {
      this.inFence = !this.inFence;
      return theme.muted(line);
    }
    if (this.inFence) return line;
    // Headings: "# " → bold accent.
    const heading = line.match(/^(\s{0,3})(#{1,6})\s+(.*)$/);
    if (heading) {
      return `${heading[1]}${theme.accent(theme.bold(heading[3] ?? ""))}`;
    }
    // Quote.
    if (/^\s*>/.test(line)) return theme.muted(line);
    // List markers.
    const list = line.match(/^(\s*)([-*+]|\d+[.)])(\s+)(.*)$/);
    if (list) {
      return `${list[1]}${theme.accent(list[2] ?? "")}${list[3]}${this.styleInline(list[4] ?? "")}`;
    }
    // Table/horizontal-rule rows: leave alone.
    if (/^\s*(\||---)/.test(line)) return line;
    return this.styleInline(line);
  }

  private styleInline(line: string): string {
    // Inline code first (protect contents from bold styling).
    const codeParts = line.split("`");
    let out = "";
    for (let i = 0; i < codeParts.length; i++) {
      const part = codeParts[i] ?? "";
      if (i % 2 === 1) {
        out += theme.tool(`\`${part}\``);
      } else {
        out += part.replace(/\*\*(.+?)\*\*/g, (_, b: string) => theme.bold(b));
      }
    }
    // Unbalanced backtick: trailing part was treated as code — acceptable.
    return out;
  }
}
