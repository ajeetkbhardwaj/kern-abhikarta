/**
 * @kern/tui — SelectList (searchable selection) and Loader (spinner).
 */

import type { Component } from "./component.js";
import { theme } from "./theme.js";
import { truncateToWidth } from "./text.js";
import { matchesKey } from "./keys.js";

export interface SelectItem<T = string> {
  value: T;
  label: string;
  description?: string;
  disabled?: boolean;
}

export interface SelectListTheme {
  selectedPrefix: (str: string) => string;
  selectedText: (str: string) => string;
  description: (str: string) => string;
  scrollInfo: (str: string) => string;
  noMatch: (str: string) => string;
}

export const defaultSelectListTheme: SelectListTheme = {
  selectedPrefix: theme.accent,
  selectedText: theme.bold,
  description: theme.muted,
  scrollInfo: theme.muted,
  noMatch: theme.muted,
};

export class SelectList<T = string> implements Component {
  onSelect: ((item: SelectItem<T>) => void) | null = null;
  onCancel: (() => void) | null = null;
  onSelectionChange: ((item: SelectItem<T>) => void) | null = null;

  private filter = "";
  private index = 0;

  constructor(
    private readonly title: string,
    private readonly items: Array<SelectItem<T>>,
    private readonly maxVisible = 10,
    private readonly theme_: SelectListTheme = defaultSelectListTheme,
  ) {}

  setFilter(filter: string): void {
    this.filter = filter;
    this.index = 0;
  }

  setSelectedIndex(index: number): void {
    this.index = Math.max(0, Math.min(index, Math.max(0, this.filtered().length - 1)));
  }

  filtered(): Array<SelectItem<T>> {
    const q = this.filter.toLowerCase();
    if (!q) return this.items;
    return this.items.filter(
      (i) => i.label.toLowerCase().includes(q) || (i.description ?? "").toLowerCase().includes(q),
    );
  }

  handleInput(key: string): boolean {
    if (matchesKey(key, "escape") || matchesKey(key, "ctrl+c")) {
      this.onCancel?.();
      return true;
    }
    if (matchesKey(key, "enter")) {
      const item = this.filtered()[this.index];
      if (item && !item.disabled) this.onSelect?.(item);
      else this.onCancel?.();
      return true;
    }
    if (matchesKey(key, "up")) {
      this.setSelectedIndex(this.index - 1);
      const item = this.filtered()[this.index];
      if (item) this.onSelectionChange?.(item);
      return true;
    }
    if (matchesKey(key, "down")) {
      this.setSelectedIndex(this.index + 1);
      const item = this.filtered()[this.index];
      if (item) this.onSelectionChange?.(item);
      return true;
    }
    if (matchesKey(key, "backspace")) {
      if (this.filter.length > 0) {
        this.filter = this.filter.slice(0, -1);
        this.index = 0;
      }
      return true;
    }
    if (key.length === 1 && key >= " " && ![...key].some((c) => /[\u0000-\u001f\u007f]/.test(c))) {
      this.filter += key;
      this.index = 0;
      return true;
    }
    return false;
  }

  render(width: number): string[] {
    const t = this.theme_;
    const list = this.filtered();
    if (this.index >= list.length) this.index = Math.max(0, list.length - 1);
    const rows: string[] = [theme.bold(this.title) + (this.filter ? theme.muted(`  /${this.filter}`) : "")];
    const visible = list.slice(0, this.maxVisible);
    visible.forEach((item, i) => {
      const cursor = i === this.index ? t.selectedPrefix("❯ ") : "  ";
      const label = item.disabled ? t.description(item.label) : i === this.index ? t.selectedText(item.label) : item.label;
      const hint = item.description ? t.description(`  ${item.description}`) : "";
      rows.push(truncateToWidth(cursor + label + hint, width));
    });
    if (list.length > visible.length) rows.push(t.scrollInfo(`… ${list.length - visible.length} more`));
    if (list.length === 0) rows.push(t.noMatch("(no matches)"));
    rows.push(t.description("type to filter · ↑↓ move · enter select · esc cancel"));
    return rows;
  }

  invalidate(): void {}
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class Loader implements Component {
  private frame = 0;
  private message: string;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly onTick: () => void, message: string) {
    this.message = message;
  }

  setMessage(message: string): void {
    this.message = message;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.frame++;
      this.onTick();
    }, 120);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  render(_width: number): string[] {
    return [theme.muted(`${FRAMES[this.frame % FRAMES.length]} ${this.message}`)];
  }

  invalidate(): void {}
}
