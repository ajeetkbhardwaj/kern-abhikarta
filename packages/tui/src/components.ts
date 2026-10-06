/**
 * @kern/tui — layout and text components.
 */

import type { Component } from "./component.js";
import { wrapTextWithAnsi, truncateToWidth, visibleWidth } from "./text.js";
import { theme } from "./theme.js";

export class Container implements Component {
  readonly children: Component[] = [];

  addChild(c: Component): void {
    this.children.push(c);
  }

  removeChild(c: Component): void {
    const i = this.children.indexOf(c);
    if (i !== -1) this.children.splice(i, 1);
  }

  clear(): void {
    this.children.length = 0;
  }

  render(width: number): string[] {
    const rows: string[] = [];
    for (const child of this.children) rows.push(...child.render(width));
    return rows;
  }

  invalidate(): void {
    for (const child of this.children) child.invalidate();
  }
}

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

export class Spacer implements Component {
  constructor(private readonly lines = 1) {}

  render(_width: number): string[] {
    return new Array<string>(this.lines).fill("");
  }

  invalidate(): void {}
}

export class TruncatedText implements Component {
  constructor(private text: string) {}

  setText(text: string): void {
    this.text = text;
  }

  render(width: number): string[] {
    return [truncateToWidth(this.text, width, "")];
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

export interface BoxOptions {
  title?: string;
  paddingX?: number;
  border?: (s: string) => string;
}

/** Rounded-border box around a child component. */
export class Box implements Component {
  private readonly paddingX: number;
  private readonly border: (s: string) => string;
  private inputTarget: Component | null = null;

  constructor(
    private readonly child: Component,
    private readonly options: BoxOptions = {},
  ) {
    this.paddingX = options.paddingX ?? 1;
    this.border = options.border ?? theme.muted;
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
    const inner = Math.max(8, width - 2);
    const pad = " ".repeat(this.paddingX);
    const contentWidth = Math.max(1, inner - this.paddingX * 2);
    const title = this.options.title;
    const top = title
      ? `╭─ ${title} ${"─".repeat(Math.max(0, inner - title.length - 4))}╮`
      : `╭${"─".repeat(inner)}╮`;
    const rows = [this.border(top)];
    for (const line of this.child.render(contentWidth)) {
      const padded = pad + line + " ".repeat(Math.max(0, contentWidth - visibleWidth(line) - this.paddingX));
      rows.push(this.border("│") + padded + this.border("│"));
    }
    rows.push(this.border(`╰${"─".repeat(inner)}╯`));
    return rows;
  }

  invalidate(): void {
    this.child.invalidate();
  }
}

/** Full-width status bar with background segments. */
export class StatusBar implements Component {
  private segments: string[] = [];

  setSegments(segments: string[]): void {
    this.segments = segments;
  }

  render(width: number): string[] {
    const bg = (s: string) => `\u001b[48;5;236m\u001b[37m${s}\u001b[0m`;
    const joined = ` ${this.segments.join(" │ ")} `;
    const plain = joined.length > width ? joined.slice(0, width) : joined + " ".repeat(width - joined.length);
    return [bg(plain)];
  }

  invalidate(): void {}
}

/** Tool execution card: header + live output + result footer. Mutated in place. */
export class ToolCard implements Component {
  private output: string[] = [];
  private done = false;
  private failed = false;
  private detail = "";

  constructor(
    private readonly toolName: string,
    private readonly argsSummary: string,
  ) {}

  appendOutput(text: string): void {
    this.output.push(...text.split("\n"));
  }

  finish(isError: boolean, detail = ""): void {
    this.done = true;
    this.failed = isError;
    this.detail = detail;
  }

  render(width: number): string[] {
    const head = this.done
      ? this.failed
        ? theme.error(`✖ ${this.toolName}`)
        : theme.success(`✔ ${this.toolName}`)
      : theme.tool(`◈ ${this.toolName}…`);
    const rows = [theme.bold(head) + (this.argsSummary ? theme.muted(` ${this.argsSummary}`) : "")];
    const MAX = 12;
    const shown = this.output.slice(-MAX);
    for (const line of shown) {
      rows.push(...wrapTextWithAnsi(theme.muted("  " + line), width));
    }
    if (this.output.length > shown.length) {
      rows.push(theme.muted(`  … ${this.output.length - shown.length} more lines`));
    }
    if (this.done && this.detail) rows.push(theme.muted(`  ${this.detail}`));
    return rows;
  }

  invalidate(): void {}
}
