/**
 * @kern/tui — raw-mode multiline editor.
 *
 * Owns the bottom input block: printable input, Alt+Enter newline,
 * bracketed paste, word-wise editing, history, slash-command highlight.
 * The orchestrator suspends it while a turn runs.
 *
 * Cursor model: a single offset into `buffer`. Redraw rewrites the whole
 * block then repositions the hardware cursor with ANSI cursor motion.
 */

import { CLEAR_LINE, SHOW_CURSOR, HIDE_CURSOR, theme } from "./theme.js";
import { truncateToWidth, terminalWidth, splitKeys, visibleWidth } from "./text.js";

export interface LineEditorOptions {
  prompt?: string;
  history?: string[];
}

const UP_LINE = (n: number) => (n > 0 ? `\u001b[${n}A` : "");
const DOWN_LINE = (n: number) => (n > 0 ? `\u001b[${n}B` : "");
const COL = (n: number) => `\u001b[${n + 1}G`;

export class LineEditor {
  private buffer = "";
  private cursor = 0; // offset into buffer (code units)
  private history: string[];
  private historyIndex = -1;
  private savedBuffer = "";
  private readonly prompt: string;
  private active = false;
  private onSubmit: ((line: string) => void) | null = null;
  private onAbort: (() => void) | null = null;
  private onExit: (() => void) | null = null;
  private pasteBuf: string | null = null;

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

  /** Feed one raw stdin chunk (may hold several keys or a paste). */
  handleData(data: string): boolean {
    if (!this.active) return false;
    for (const key of splitKeys(data)) {
      this.handleKey(key);
      if (!this.active) break;
    }
    return true;
  }

  /** Feed one key (single char, escape sequence, or bracketed paste). */
  handleKey(data: string): boolean {
    if (!this.active) return false;

    // Bracketed paste: insert literally, redraw once.
    if (data.startsWith("\u001b[200~")) {
      const end = data.indexOf("\u001b[201~");
      const pasted = (end === -1 ? data.slice(6) : data.slice(6, end)).replace(/\r\n?/g, "\n");
      this.insert(pasted);
      this.redraw();
      return true;
    }

    // Alt+Enter (ESC CR / ESC LF): newline. Plain Enter submits.
    if (data === "\u001b\r" || data === "\u001b\n" || data === "\u001b\u000d" || data === "\u001b\u000a") {
      this.insert("\n");
      this.redraw();
      return true;
    }
    if (data === "\r" || data === "\n") {
      const line = this.buffer;
      this.pushHistory(line);
      // Move cursor below the block before handing over output.
      const submitLines = this.buffer.split("\n");
      let offset = 0;
      let cursorRow = submitLines.length - 1;
      for (let r = 0; r < submitLines.length; r++) {
        const len = (submitLines[r] ?? "").length;
        if (this.cursor <= offset + len) {
          cursorRow = r;
          break;
        }
        offset += len + 1;
      }
      process.stdout.write(DOWN_LINE(submitLines.length - 1 - cursorRow) + "\r\n");
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
      if (this.cursor > 0) {
        this.buffer = this.buffer.slice(0, this.cursor - 1) + this.buffer.slice(this.cursor);
        this.cursor -= 1;
        this.redraw();
      }
      return true;
    }
    if (data === "\u001b[D" || data === "\u0001") {
      // Left / Ctrl+A
      if (data === "\u0001") this.cursor = this.lineStart();
      else if (this.cursor > 0) this.cursor -= 1;
      this.redraw();
      return true;
    }
    if (data === "\u001b[C" || data === "\u0005") {
      // Right / Ctrl+E
      if (data === "\u0005") this.cursor = this.lineEnd();
      else if (this.cursor < this.buffer.length) this.cursor += 1;
      this.redraw();
      return true;
    }
    if (data === "\u001b[A" || data === "\u0010") {
      // Up / Ctrl+P: history back, or cursor up inside multiline text
      if (this.multiline() && data === "\u001b[A") {
        this.moveVertically(-1);
      } else if (this.history.length > 0 && this.historyIndex < this.history.length - 1) {
        if (this.historyIndex === -1) this.savedBuffer = this.buffer;
        this.historyIndex += 1;
        this.buffer = this.history[this.history.length - 1 - this.historyIndex] ?? "";
        this.cursor = this.buffer.length;
        this.redraw();
      }
      return true;
    }
    if (data === "\u001b[B" || data === "\u000e") {
      // Down / Ctrl+N: history forward, or cursor down inside multiline text
      if (this.multiline() && data === "\u001b[B") {
        this.moveVertically(1);
      } else if (this.historyIndex > 0) {
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
    if (data === "\u001b[1;5D" || data === "\u001bb") {
      // Ctrl+Left / Alt+B: word back
      this.cursor = this.wordStart(-1);
      this.redraw();
      return true;
    }
    if (data === "\u001b[1;5C" || data === "\u001bf") {
      // Ctrl+Right / Alt+F: word forward
      this.cursor = this.wordStart(1);
      this.redraw();
      return true;
    }
    if (data === "\u0017") {
      // Ctrl+W: delete word back
      const start = this.wordStart(-1);
      this.buffer = this.buffer.slice(0, start) + this.buffer.slice(this.cursor);
      this.cursor = start;
      this.redraw();
      return true;
    }
    if (data === "\u001b[3;5~" || data === "\u001bd") {
      // Ctrl+Delete / Alt+D: delete word forward
      const end = this.wordStart(1);
      this.buffer = this.buffer.slice(0, this.cursor) + this.buffer.slice(end);
      this.redraw();
      return true;
    }
    if (data === "\u000b") {
      // Ctrl+K: kill to end of line
      this.buffer = this.buffer.slice(0, this.cursor);
      this.redraw();
      return true;
    }
    if (data === "\u0015") {
      // Ctrl+U: clear all
      this.buffer = "";
      this.cursor = 0;
      this.redraw();
      return true;
    }
    if (data === "\u001b") {
      // Lone Esc: clear the input (cancel what was typed).
      if (this.buffer.length > 0) {
        this.buffer = "";
        this.cursor = 0;
        this.redraw();
      }
      return true;
    }
    if (data.startsWith("\u001b")) return true; // swallow other escape sequences
    if (data === "\t") {
      this.insert("  ");
      this.redraw();
      return true;
    }
    if (data >= " " && !/[\u0000-\u001f\u007f]/.test(data)) {
      this.insert(data);
      this.redraw();
      return true;
    }
    return true;
  }

  private insert(s: string): void {
    this.buffer = this.buffer.slice(0, this.cursor) + s + this.buffer.slice(this.cursor);
    this.cursor += s.length;
    this.historyIndex = -1;
  }

  private multiline(): boolean {
    return this.buffer.includes("\n");
  }

  private lineStart(): number {
    return this.buffer.lastIndexOf("\n", this.cursor - 1) + 1;
  }

  private lineEnd(): number {
    const i = this.buffer.indexOf("\n", this.cursor);
    return i === -1 ? this.buffer.length : i;
  }

  private isWordChar(ch: string): boolean {
    return /[A-Za-z0-9_]/.test(ch);
  }

  private wordStart(dir: -1 | 1): number {
    let i = this.cursor;
    if (dir === -1) {
      while (i > 0 && !this.isWordChar(this.buffer[i - 1] ?? "")) i--;
      while (i > 0 && this.isWordChar(this.buffer[i - 1] ?? "")) i--;
    } else {
      while (i < this.buffer.length && !this.isWordChar(this.buffer[i] ?? "")) i++;
      while (i < this.buffer.length && this.isWordChar(this.buffer[i] ?? "")) i++;
    }
    return i;
  }

  private moveVertically(dir: -1 | 1): void {
    const lines = this.buffer.split("\n");
    let offset = 0;
    let row = 0;
    let col = 0;
    for (let r = 0; r < lines.length; r++) {
      const len = (lines[r] ?? "").length;
      if (this.cursor <= offset + len) {
        row = r;
        col = this.cursor - offset;
        break;
      }
      offset += len + 1;
      row = r;
    }
    const target = row + dir;
    if (target < 0 || target >= lines.length) return;
    const targetLen = (lines[target] ?? "").length;
    let targetOffset = 0;
    for (let r = 0; r < target; r++) targetOffset += (lines[r] ?? "").length + 1;
    this.cursor = targetOffset + Math.min(col, targetLen);
    this.redraw();
  }

  /** Number of terminal rows the input block occupies. */
  private blockRows(): number {
    const width = terminalWidth();
    let rows = 0;
    const lines = this.buffer.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const text = (i === 0 ? this.prompt : "") + (lines[i] ?? "");
      rows += Math.max(1, Math.ceil((visibleWidth(text) + 1) / width));
    }
    return rows;
  }

  redraw(): void {
    if (!this.active) return;
    const width = terminalWidth();
    const lines = this.buffer.split("\n");
    // Cursor row/col in block coordinates.
    let cursorRow = 0;
    {
      let offset = 0;
      for (let r = 0; r < lines.length; r++) {
        const len = (lines[r] ?? "").length;
        if (this.cursor <= offset + len) {
          cursorRow = r;
          break;
        }
        offset += len + 1;
        cursorRow = r;
      }
    }
    // Rewrite the block from its first row.
    process.stdout.write(UP_LINE(lines.length - 1));
    for (let r = 0; r < lines.length; r++) {
      let text = ((r === 0 ? this.prompt : "") + (lines[r] ?? "")) || " ";
      if (r === 0 && this.buffer.startsWith("/")) {
        const raw = lines[r] ?? "";
        const space = raw.indexOf(" ");
        const cmd = space === -1 ? raw : raw.slice(0, space);
        const rest = space === -1 ? "" : raw.slice(space);
        text = this.prompt + theme.success(cmd) + rest;
      }
      process.stdout.write(CLEAR_LINE + truncateToWidth(text, width) + "\r\n");
    }
    // Move back up to the cursor row, then to the cursor column.
    const up = lines.length - 1 - cursorRow;
    process.stdout.write(UP_LINE(up));
    let colChars = cursorRow === 0 ? this.prompt.length : 0;
    const lineText = lines[cursorRow] ?? "";
    const lineStartOffset = this.buffer.split("\n").slice(0, cursorRow).join("\n").length + (cursorRow > 0 ? 1 : 0);
    const colInLine = this.cursor - lineStartOffset;
    colChars += visibleWidth(lineText.slice(0, Math.max(0, colInLine)));
    process.stdout.write(HIDE_CURSOR + COL(Math.min(colChars, width - 1)) + SHOW_CURSOR);
  }

  suspend(): void {
    this.active = false;
    // Clear the whole block.
    const lines = this.buffer.split("\n");
    process.stdout.write(UP_LINE(lines.length - 1));
    for (let i = 0; i < lines.length; i++) process.stdout.write(CLEAR_LINE + (i < lines.length - 1 ? "\u001b[1B" : "\r"));
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
