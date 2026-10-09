/**
 * @kern/tui — layout and text components.
 */

import type { Component } from "./component.js";
import { wrapTextWithAnsi, truncateToWidth, visibleWidth } from "./text.js";
import { theme, statusBg } from "./theme.js";

/**
 * Generic vertical containers, re-exported from pi-tui (identical
 * addChild/removeChild/clear/render semantics to our old ones).
 */
export { Container, Spacer } from "@earendil-works/pi-tui";

export class Text implements Component {
  constructor(private text: string, private readonly paddingX = 0, private readonly paddingY = 0) {}

  setText(text: string): void {
    this.text = text;
  }

  render(width: number): string[] {
    const pad = " ".repeat(this.paddingX);
    const rows: string[] = [];
    for (let i = 0; i < this.paddingY; i++) rows.push("");
    for (const line of this.text.split("\n")) {
      rows.push(...wrapTextWithAnsi(pad + line, width).map((r) => (r.length === 0 ? r : r)));
    }
    for (let i = 0; i < this.paddingY; i++) rows.push("");
    return rows;
  }

  invalidate(): void {}
}

/** Horizontal divider rule. */
export class Rule implements Component {
  constructor(private readonly char = "─") {}

  render(width: number): string[] {
    return [theme.muted(this.char.repeat(Math.max(8, width)))];
  }

  invalidate(): void {}
}

export type BoxMood = "default" | "info" | "accent" | "error" | "success";

export interface BoxOptions {
  title?: string;
  paddingX?: number;
  border?: (s: string) => string;
  /** Shorthand for a semantic border color; explicit `border` wins. */
  mood?: BoxMood;
}

function moodBorder(mood: BoxMood): (s: string) => string {
  switch (mood) {
    case "info":
      return theme.info;
    case "accent":
      return theme.accent;
    case "error":
      return theme.error;
    case "success":
      return theme.success;
    default:
      return theme.muted;
  }
}

/** Rounded-border box around a child component. Every row is exactly `width` wide. */
export class Box implements Component {
  private readonly paddingX: number;
  private readonly border: (s: string) => string;
  private inputTarget: Component | null = null;

  constructor(
    private readonly child: Component,
    private readonly options: BoxOptions = {},
  ) {
    this.paddingX = Math.max(0, options.paddingX ?? 1);
    this.border = options.border ?? moodBorder(options.mood ?? "default");
  }

  /** Direct subsequent input at an interactive descendant (boxed dialogs). */
  setInputTarget(c: Component): void {
    this.inputTarget = c;
  }

  /** Input goes to the interactive child (used for boxed dialogs). */
  handleInput(key: string): boolean {
    return this.inputTarget?.handleInput?.(key) ?? false;
  }

  render(width: number): string[] {
    const w = Math.max(10, width);
    const inner = w - 2;
    const padN = Math.min(this.paddingX, Math.max(0, Math.floor((inner - 1) / 2)));
    const contentWidth = Math.max(1, inner - padN * 2);
    const rawTitle = this.options.title ?? "";
    const maxTitle = Math.max(0, inner - 6);
    const title = visibleWidth(rawTitle) > maxTitle ? truncateToWidth(rawTitle, maxTitle, "…") : rawTitle;
    const top =
      title.length > 0
        ? (() => {
            const dashes = Math.max(0, inner - visibleWidth(title) - 3);
            return (
              this.border("╭─ ") + theme.bold(title) + this.border(` ${"─".repeat(dashes)}╮`)
            );
          })()
        : this.border(`╭${"─".repeat(inner)}╮`);
    const rows = [top];
    for (const line of this.child.render(contentWidth)) {
      // Each rendered child line already fits contentWidth; clamp defensively
      // (ANSI-aware) so borders always align.
      const clamped = visibleWidth(line) > contentWidth ? truncateToWidth(line, contentWidth, "…") : line;
      const fill = Math.max(0, inner - padN - visibleWidth(clamped));
      rows.push(this.border("│") + " ".repeat(padN) + clamped + " ".repeat(fill) + this.border("│"));
    }
    rows.push(this.border(`╰${"─".repeat(inner)}╯`));
    return rows;
  }

  invalidate(): void {
    this.child.invalidate();
  }
}

/** Full-width status bar with per-segment styles and a ctx% progress bar. */
export class StatusBar implements Component {
  private segments: string[] = [];

  setSegments(segments: string[]): void {
    this.segments = segments;
  }

  render(width: number): string[] {
    const w = Math.max(1, width);
    if (this.segments.length === 0) return [statusBg(" ".repeat(w))];
    const styled = this.segments.map((s, i) => styleSegment(s, i, this.segments.length));
    const sep = theme.muted(" │ ");
    const joined = ` ${styled.join(sep)} `;
    const clipped = visibleWidth(joined) > w ? truncateToWidth(joined, w, "…") : joined;
    const padded = clipped + " ".repeat(Math.max(0, w - visibleWidth(clipped)));
    return [statusBg(padded)];
  }

  invalidate(): void {}
}

function styleSegment(seg: string, index: number, total: number): string {
  const ctx = seg.match(/ctx\s+(\d+)\s*%/i);
  if (ctx?.[1] !== undefined) {
    const pct = Math.max(0, Math.min(100, Number(ctx[1])));
    const color = pct >= 90 ? theme.error : pct >= 70 ? theme.warn : theme.success;
    return `${theme.muted("ctx")} ${color(`${pct}%`)} ${color(ctxBar(pct, 8))}`;
  }
  if (index === 0) return theme.bold(seg);
  if (/^(manual|ask)\b/i.test(seg)) return theme.warn(seg);
  if (/^auto/i.test(seg)) return theme.success(seg);
  if (/turn|calls?|queued|\d+\.\d+s/i.test(seg)) return theme.muted(seg);
  if (index === total - 1) return theme.muted(seg);
  return theme.accent(seg);
}

/** Fixed-width block progress bar: `████░░░░`. */
export function ctxBar(pct: number, length = 8): string {
  const filled = Math.round((Math.max(0, Math.min(100, pct)) / 100) * length);
  return "█".repeat(filled) + "░".repeat(Math.max(0, length - filled));
}

export interface ToolCardOptions {
  /** Live output lines kept visible (default 12). */
  maxLines?: number;
}

/** Tool execution card: header + live output + result footer. Mutated in place. */
export class ToolCard implements Component {
  private output: string[] = [];
  private done = false;
  private failed = false;
  private detail = "";
  private readonly maxLines: number;

  constructor(
    private readonly toolName: string,
    private readonly argsSummary: string,
    opts?: ToolCardOptions,
  ) {
    this.maxLines = Math.max(1, opts?.maxLines ?? 12);
  }

  appendOutput(text: string): void {
    this.output.push(...text.split("\n"));
  }

  finish(isError: boolean, detail = ""): void {
    this.done = true;
    this.failed = isError;
    this.detail = detail;
  }

  /** True once finished with an error (lets callers pick a red Box mood). */
  isFailed(): boolean {
    return this.done && this.failed;
  }

  /** True once finished either way. */
  isDone(): boolean {
    return this.done;
  }

  render(width: number): string[] {
    const w = Math.max(8, width);
    const icon = this.done ? (this.failed ? "✖" : "✔") : "◈";
    const headColor = this.done ? (this.failed ? theme.error : theme.success) : theme.tool;
    const running = this.done ? "" : "…";
    const headerBase = theme.bold(headColor(`${icon} ${this.toolName}${running}`));
    const summary = this.argsSummary ? theme.muted(` ${this.argsSummary}`) : "";
    const rows = [truncateToWidth(headerBase + summary, w, "…")];
    const shown = this.output.slice(-this.maxLines);
    const gutter = this.failed ? theme.error("▎ ") : theme.muted("│ ");
    for (const line of shown) {
      if (line.length === 0) {
        rows.push(truncateToWidth(gutter.trimEnd(), w, ""));
        continue;
      }
      rows.push(...wrapTextWithAnsi(gutter + theme.muted(line), w));
    }
    const hidden = this.output.length - shown.length;
    if (hidden > 0) rows.push(theme.muted(`  … +${hidden} more`));
    if (this.done) {
      const timing = this.detail ? theme.muted(` · ${this.detail}`) : "";
      rows.push(
        this.failed
          ? truncateToWidth(theme.error("✖ failed") + timing, w, "…")
          : truncateToWidth(theme.success("✔ done") + timing, w, "…"),
      );
    }
    return rows;
  }

  invalidate(): void {}
}
