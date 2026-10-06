/**
 * @kern/tui — raw-mode single-line editor.
 *
 * Owns the bottom input line: printable input, cursor movement, history,
 * slash-command hint. The orchestrator suspends it while a turn runs.
 */

import { CLEAR_LINE, SHOW_CURSOR, theme } from "./theme.js";
import { truncateToWidth, terminalWidth, splitKeys } from "./text.js";

export interface LineEditorOptions {
  prompt?: string;
  history?: string[];
}

export class LineEditor {
  private buffer = "";
  private cursor = 0;
  private history: string[];
  private historyIndex = -1;
  private savedBuffer = "";
  private readonly prompt: string;
  private active = false;
  private onSubmit: ((line: string) => void) | null = null;
  private onAbort: (() => void) | null = null;
  private onExit: (() => void) | null = null;

  constructor(options: LineEditorOptions = {}) {
    this.prompt = options.prompt ?? "> ";
    this.history = options.history ?? [];
  }

  pushHistory(line: string): void {
    if (line.trim().length === 0) return;
    if (this.history[this.history.length - 1] !== line) this.history.push(line);
    if (this.history.length > 200) this.history.splice(0, this.history.length - 200);
  }

  start(handlers: { onSubmit: (line: string) => void; onAbort: () => void; onExit: () => void }): void {
    this.onSubmit = handlers.onSubmit;
    this.onAbort = handlers.onAbort;
    this.onExit = handlers.onExit;
    this.active = true;
    this.buffer = "";
    this.cursor = 0;
    this.historyIndex = -1;
    this.redraw();
  }

  stop(): void {
    this.active = false;
  }

  /** Feed one raw stdin chunk (may hold several keys). */
  handleData(data: string): boolean {
    if (!this.active) return false;
    for (const key of splitKeys(data)) {
      this.handleKey(key);
      if (!this.active) break;
    }
    return true;
  }

  /** Feed one key (single char or one escape sequence). */
  handleKey(data: string): boolean {
    if (!this.active) return false;
    if (data === "\r" || data === "\n") {
      const line = this.buffer;
      this.pushHistory(line);
      process.stdout.write("\r\n");
      this.onSubmit?.(line);
      return true;
    }
    if (data === "\u0003") {
      // Ctrl+C
      if (this.buffer.length === 0) {
        this.onExit?.();
      } else {
        this.buffer = "";
        this.cursor = 0;
        this.redraw();
      }
      return true;
    }
    if (data === "\u0004") {
      // Ctrl+D
      if (this.buffer.length === 0) this.onExit?.();
      return true;
    }
    if (data === "\u007f" || data === "\b") {
      // Backspace
      if (this.cursor > 0) {
        this.buffer = this.buffer.slice(0, this.cursor - 1) + this.buffer.slice(this.cursor);
        this.cursor -= 1;
        this.redraw();
      }
      return true;
    }
    if (data === "\u001b[D") {
      // Left
      if (this.cursor > 0) {
        this.cursor -= 1;
        this.redraw();
      }
      return true;
    }
    if (data === "\u001b[C") {
      // Right
      if (this.cursor < this.buffer.length) {
        this.cursor += 1;
        this.redraw();
      }
      return true;
    }
    if (data === "\u001b[A") {
      // Up: history back
      if (this.history.length > 0 && this.historyIndex < this.history.length - 1) {
        if (this.historyIndex === -1) this.savedBuffer = this.buffer;
        this.historyIndex += 1;
        this.buffer = this.history[this.history.length - 1 - this.historyIndex] ?? "";
        this.cursor = this.buffer.length;
        this.redraw();
      }
      return true;
    }
    if (data === "\u001b[B") {
      // Down: history forward
      if (this.historyIndex > 0) {
        this.historyIndex -= 1;
        this.buffer = this.history[this.history.length - 1 - this.historyIndex] ?? "";
        this.cursor = this.buffer.length;
        this.redraw();
      } else if (this.historyIndex === 0) {
        this.historyIndex = -1;
        this.buffer = this.savedBuffer;
        this.cursor = this.buffer.length;
        this.redraw();
      }
      return true;
    }
    if (data === "\u0015") {
      // Ctrl+U: clear line
      this.buffer = "";
      this.cursor = 0;
      this.redraw();
      return true;
    }
    if (data.startsWith("\u001b")) return true; // swallow other escape sequences
    if (data >= " " || data === "\t") {
      const insert = data === "\t" ? "  " : data;
      this.buffer = this.buffer.slice(0, this.cursor) + insert + this.buffer.slice(this.cursor);
      this.cursor += insert.length;
      this.redraw();
      return true;
    }
    return true;
  }

  redraw(): void {
    if (!this.active) return;
    const width = terminalWidth();
    let prefix = theme.accent(this.prompt);
    let shown = this.buffer;
    if (this.buffer.startsWith("/")) {
      const space = this.buffer.indexOf(" ");
      const cmd = space === -1 ? this.buffer : this.buffer.slice(0, space);
      const rest = space === -1 ? "" : this.buffer.slice(space);
      shown = theme.success(cmd) + rest;
      void prefix;
    }
    const line = this.prompt + shown;
    process.stdout.write(CLEAR_LINE + truncateToWidth(line, width) + SHOW_CURSOR);
  }

  suspend(): void {
    this.active = false;
    process.stdout.write(CLEAR_LINE);
  }

  resume(): void {
    this.active = true;
    this.buffer = "";
    this.cursor = 0;
    this.historyIndex = -1;
    this.redraw();
  }

  requestAbort(): void {
    this.onAbort?.();
  }
}
