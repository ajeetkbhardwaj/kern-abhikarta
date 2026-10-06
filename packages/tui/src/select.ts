/**
 * @kern/tui — searchable select overlay (model picker, etc.).
 *
 * Takes over stdin while open: type to filter, up/down to move, enter to
 * choose, esc to cancel, Ctrl+C to abort. Renders below the cursor in
 * scrollback mode and cleans up after itself.
 */

import { CLEAR_LINE, theme } from "./theme.js";
import { truncateToWidth, terminalWidth, visibleWidth } from "./text.js";

export interface SelectItem<T> {
  label: string;
  hint?: string;
  value: T;
  disabled?: boolean;
}

export class SelectOverlay<T> {
  private filter = "";
  private index = 0;
  private readonly maxRows = 10;

  constructor(private readonly title: string, private readonly items: SelectItem<T>[]) {}

  private filtered(): SelectItem<T>[] {
    const q = this.filter.toLowerCase();
    if (!q) return this.items;
    return this.items.filter(
      (i) => i.label.toLowerCase().includes(q) || (i.hint ?? "").toLowerCase().includes(q),
    );
  }

  /** Run the picker. Resolves to the value, or null on cancel. */
  run(readKey: () => Promise<string>): Promise<T | null> {
    return new Promise((resolve) => {
      const render = () => {
        const width = terminalWidth();
        const list = this.filtered();
        if (this.index >= list.length) this.index = Math.max(0, list.length - 1);
        process.stdout.write(CLEAR_LINE + theme.bold(this.title) + (this.filter ? theme.muted(`  /${this.filter}`) : "") + "\r\n");
        const rows = list.slice(0, this.maxRows);
        rows.forEach((item, i) => {
          const cursor = i === this.index ? theme.accent("❯ ") : "  ";
          const label = item.disabled ? theme.muted(item.label) : item.label;
          const hint = item.hint ? theme.muted(`  ${item.hint}`) : "";
          process.stdout.write(CLEAR_LINE + cursor + truncateToWidth(label + hint, width - 2) + "\r\n");
        });
        if (list.length > rows.length) {
          process.stdout.write(CLEAR_LINE + theme.muted(`… ${list.length - rows.length} more`) + "\r\n");
        }
        if (list.length === 0) {
          process.stdout.write(CLEAR_LINE + theme.muted("(no matches)") + "\r\n");
        }
        process.stdout.write(theme.muted("type to filter · ↑↓ move · enter select · esc cancel") + "\r\n");
      };
      const erase = () => {
        const list = this.filtered();
        const n = Math.min(list.length, this.maxRows) + (list.length > this.maxRows ? 1 : 0) + (list.length === 0 ? 1 : 0) + 2;
        for (let i = 0; i < n; i++) {
          process.stdout.write("\u001b[1A" + CLEAR_LINE);
        }
      };
      const cleanup = () => erase();
      const loop = async (): Promise<void> => {
        render();
        for (;;) {
          const key = await readKey();
          if (key === "\u001b") {
            cleanup();
            resolve(null);
            return;
          }
          if (key === "\u0003") {
            cleanup();
            resolve(null);
            return;
          }
          if (key === "\r" || key === "\n") {
            const item = this.filtered()[this.index];
            cleanup();
            resolve(item && !item.disabled ? item.value : null);
            return;
          }
          if (key === "\u001b[A") {
            this.index = Math.max(0, this.index - 1);
            erase();
            render();
            continue;
          }
          if (key === "\u001b[B") {
            this.index = Math.min(Math.max(0, this.filtered().length - 1), this.index + 1);
            erase();
            render();
            continue;
          }
          if (key === "\u007f" || key === "\b") {
            if (this.filter.length > 0) {
              this.filter = this.filter.slice(0, -1);
              this.index = 0;
              erase();
              render();
            }
            continue;
          }
          if (key.length === 1 && key >= " " && key.length <= 2 && visibleWidth(key) > 0) {
            this.filter += key;
            this.index = 0;
            erase();
            render();
            continue;
          }
        }
      };
      void loop();
    });
  }
}
