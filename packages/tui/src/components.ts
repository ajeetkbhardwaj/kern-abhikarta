/**
 * @kern/tui — layout and text components.
 */

import type { Component } from "./component.js";
import { wrapTextWithAnsi, truncateToWidth } from "./text.js";

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
