/**
 * @kern/tui — SelectList (searchable selection) and Loader (spinner).
 */

import type { Component } from "./component.js";
import { theme, keepInverse } from "./theme.js";
import { truncateToWidth, visibleWidth } from "./text.js";
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
  /** Full-width highlight bar for the selected row (default: inverse). */
  highlight?: (str: string) => string;
  /** Matched-filter substring style (default: accent + bold). */
  match?: (str: string) => string;
  /** Disabled-row label style (default: muted). */
  disabledRow?: (str: string) => string;
}

export const defaultSelectListTheme: SelectListTheme = {
  selectedPrefix: theme.accent,
  selectedText: theme.bold,
  description: theme.muted,
  scrollInfo: theme.muted,
  noMatch: theme.muted,
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Highlight every case-insensitive occurrence of the filter query. */
function highlightMatch(label: string, query: string, match: (s: string) => string): string {
  const q = query.trim();
  if (!q) return label;
  const re = new RegExp(escapeRegExp(q), "gi");
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  // Guard against pathological backtracking on long labels.
  let spans = 0;
  while ((m = re.exec(label)) !== null && spans < 16) {
    out += label.slice(last, m.index) + match(m[0]);
    last = m.index + m[0].length;
    spans++;
    if (m[0].length === 0) re.lastIndex++;
  }
  return out + label.slice(last);
}

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
    const w = Math.max(8, width);
    const match = t.match ?? ((s: string) => theme.accent(theme.bold(s)));
    const highlight = t.highlight ?? keepInverse;
    const disabledStyle = t.disabledRow ?? theme.muted;
    const list = this.filtered();
    if (this.index >= list.length) this.index = Math.max(0, list.length - 1);
    const pos = list.length > 0 ? `${this.index + 1}/${list.length}` : "0/0";
    const head = (this.title ? theme.bold(this.title) : theme.bold("select")) +
      (this.filter ? theme.muted(`  /${this.filter}`) : "") +
      t.scrollInfo(`  ${pos}`);
    const rows: string[] = [truncateToWidth(head, w, "…")];
    const cap = Math.max(1, this.maxVisible);
    const start = Math.min(Math.max(0, this.index - Math.floor(cap / 2)), Math.max(0, list.length - cap));
    const end = Math.min(list.length, start + cap);
    for (let gi = start; gi < end; gi++) {
      const item = list[gi];
      if (!item) continue;
      const selected = gi === this.index;
      const cursor = selected ? t.selectedPrefix("❯ ") : "  ";
      if (item.disabled) {
        const label = disabledStyle(item.label);
        const hint = item.description ? t.description(`  ${item.description}`) : "";
        const dim = cursor + label + hint + t.description("  · unavailable");
        rows.push(truncateToWidth(dim, w, "…"));
        continue;
      }
      const label = selected
        ? t.selectedText(highlightMatch(item.label, this.filter, match))
        : highlightMatch(item.label, this.filter, match);
      const hint = item.description ? t.description(`  ${item.description}`) : "";
      if (selected) {
        const inner = cursor + label + hint;
        const clipped = visibleWidth(inner) > w ? truncateToWidth(inner, w, "…") : inner;
        const padded = clipped + " ".repeat(Math.max(0, w - visibleWidth(clipped)));
        rows.push(highlight(padded));
      } else {
        rows.push(truncateToWidth(cursor + label + hint, w, "…"));
      }
    }
    if (list.length > cap) {
      const above = start;
      const below = list.length - end;
      const bits = [`${pos}`];
      if (above > 0) bits.push(`▲${above}`);
      if (below > 0) bits.push(`▼${below}`);
      rows.push(t.scrollInfo(`  ‹ ${bits.join(" · ")} ›`));
    }
    if (list.length === 0) rows.push(t.noMatch("(no matches)"));
    rows.push(truncateToWidth(t.description("type to filter · ↑↓ move · enter select · esc cancel"), w, "…"));
    return rows;
  }

  invalidate(): void {}
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class Loader implements Component {
  private frame = 0;
  private message: string;
  private startedAt = Date.now();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly onTick: () => void, message: string) {
    this.message = message;
  }

  setMessage(message: string): void {
    this.message = message;
  }

  start(): void {
    if (this.timer) return;
    this.startedAt = Date.now();
    this.timer = setInterval(() => {
      this.frame++;
      this.onTick();
    }, 120);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  render(width: number): string[] {
    const w = Math.max(8, width);
    const elapsed = ((Date.now() - this.startedAt) / 1000).toFixed(1);
    const row = `${theme.accent(FRAMES[this.frame % FRAMES.length] ?? "⠋")} ${theme.muted(`${this.message} · ${elapsed}s`)}`;
    return [truncateToWidth(row, w, "…")];
  }

  invalidate(): void {}
}
