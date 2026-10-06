/**
 * @kern/tui — multiline Editor component.
 *
 * Offset-based cursor, readline bindings, word ops, kill ring, history,
 * bracketed paste (large pastes collapse to a `[paste #N +M lines]`
 * marker), slash/file autocomplete via provider, ghost-text remainder.
 * Emits CURSOR_MARKER for hardware-cursor (IME) positioning.
 */

import type { Component, Focusable } from "./component.js";
import { CURSOR_MARKER } from "./terminal.js";
import { theme } from "./theme.js";
import { truncateToWidth, visibleWidth, splitKeys } from "./text.js";
import { matchesKey } from "./keys.js";

export interface Completion {
  /** Text to insert for the token at the cursor. */
  insert: string;
  /** Full replacement rows for dropdown-style completion, or null. */
  dropdown: string[] | null;
}

export interface AutocompleteProvider {
  /** Completions for the token ending at the cursor. */
  complete(beforeCursor: string): Completion | null;
  /** Ghost remainder shown dim after the cursor. */
  ghost(beforeCursor: string): string;
}

export interface EditorTheme {
  borderColor: (str: string) => string;
  selectedPrefix: (str: string) => string;
  selectedText: (str: string) => string;
  description: (str: string) => string;
  scrollInfo: (str: string) => string;
  noMatch: (str: string) => string;
}

export const defaultEditorTheme: EditorTheme = {
  borderColor: theme.muted,
  selectedPrefix: theme.accent,
  selectedText: theme.bold,
  description: theme.muted,
  scrollInfo: theme.muted,
  noMatch: theme.muted,
};

const PASTE_MARKER_RE = /^\[paste #(\d+) \+(\d+) lines\]$/;

export class Editor implements Component, Focusable {
  focused = false;
  onSubmit: ((text: string) => void) | null = null;
  onChange: ((text: string) => void) | null = null;
  disableSubmit = false;

  private buffer = "";
  private cursor = 0;
  private history: string[] = [];
  private historyIndex = -1;
  private savedBuffer = "";
  private yank = "";
  private stash = "";
  private pastes = new Map<number, string>();
  private pasteSeq = 0;
  private dropIndex = -1;
  private provider: AutocompleteProvider | null = null;

  constructor(private readonly prompt = "› ") {}

  setAutocompleteProvider(provider: AutocompleteProvider): void {
    this.provider = provider;
  }

  getText(): string {
    return this.expandPastes(this.buffer);
  }

  setText(text: string): void {
    this.buffer = text;
    this.cursor = text.length;
    this.historyIndex = -1;
    this.onChange?.(this.getText());
  }

  clear(): void {
    this.buffer = "";
    this.cursor = 0;
    this.historyIndex = -1;
  }

  addToHistory(text: string): void {
    if (text.trim().length === 0) return;
    if (this.history[this.history.length - 1] !== text) this.history.push(text);
    if (this.history.length > 200) this.history.splice(0, this.history.length - 200);
  }

  stashPrompt(): void {
    if (this.buffer.length > 0) {
      this.stash = this.buffer;
      this.buffer = "";
      this.cursor = 0;
    } else if (this.stash) {
      this.buffer = this.stash;
      this.cursor = this.buffer.length;
    }
  }

  /** Raw stdin (may hold several keys or a paste block). */
  handleData(data: string): void {
    for (const key of splitKeys(data)) {
      if (!this.handleInput(key)) break;
    }
  }

  handleInput(key: string): boolean {
    // Bracketed paste.
    if (key.startsWith("\u001b[200~")) {
      const end = key.indexOf("\u001b[201~");
      const pasted = (end === -1 ? key.slice(6) : key.slice(6, end)).replace(/\r\n?/g, "\n");
      this.insert(this.collapsePaste(pasted));
      return true;
    }
    // Alt+Enter: newline. Enter submits (CR and LF both submit; terminals
    // vary and some stacks translate CR→LF).
    if (key === "\u001b\r" || key === "\u001b\n") {
      this.insert("\n");
      return true;
    }
    if (matchesKey(key, "enter")) {
      if (this.disableSubmit) return true;
      const line = this.getText();
      this.addToHistory(this.buffer);
      this.onSubmit?.(line);
      return true;
    }
    if (matchesKey(key, "escape")) {
      if (this.buffer.length > 0) {
        this.buffer = "";
        this.cursor = 0;
      }
      return true;
    }
    if (matchesKey(key, "ctrl+c")) {
      if (this.buffer.length === 0) return false; // let app exit/abort
      this.buffer = "";
      this.cursor = 0;
      return true;
    }
    if (matchesKey(key, "ctrl+d")) {
      if (this.buffer.length === 0) return false;
      return true;
    }
    if (matchesKey(key, "backspace")) {
      if (this.cursor > 0) {
        this.buffer = this.buffer.slice(0, this.cursor - 1) + this.buffer.slice(this.cursor);
        this.cursor -= 1;
        this.changed();
      }
      return true;
    }
    if (matchesKey(key, "left")) {
      if (this.cursor > 0) this.cursor -= 1;
      return true;
    }
    if (matchesKey(key, "right")) {
      if (this.cursor < this.buffer.length) this.cursor += 1;
      return true;
    }
    if (matchesKey(key, "up")) {
      if (this.multiline()) this.moveVertically(-1);
      else this.historyStep(1);
      return true;
    }
    if (matchesKey(key, "down")) {
      if (this.multiline()) this.moveVertically(1);
      else this.historyStep(-1);
      return true;
    }
    if (matchesKey(key, "ctrl+a")) {
      this.cursor = this.lineStart();
      return true;
    }
    if (matchesKey(key, "ctrl+e")) {
      this.cursor = this.lineEnd();
      return true;
    }
    if (matchesKey(key, "ctrl+left") || matchesKey(key, "alt+b")) {
      this.cursor = this.wordStart(-1);
      return true;
    }
    if (matchesKey(key, "ctrl+right") || matchesKey(key, "alt+f")) {
      this.cursor = this.wordStart(1);
      return true;
    }
    if (matchesKey(key, "ctrl+w")) {
      let start = this.cursor;
      while (start > 0 && /\s/.test(this.buffer[start - 1] ?? "")) start--;
      while (start > 0 && !/\s/.test(this.buffer[start - 1] ?? "")) start--;
      this.yank = this.buffer.slice(start, this.cursor);
      this.buffer = this.buffer.slice(0, start) + this.buffer.slice(this.cursor);
      this.cursor = start;
      this.changed();
      return true;
    }
    if (matchesKey(key, "alt+d")) {
      const end = this.wordStart(1);
      this.yank = this.buffer.slice(this.cursor, end);
      this.buffer = this.buffer.slice(0, this.cursor) + this.buffer.slice(end);
      this.changed();
      return true;
    }
    if (matchesKey(key, "ctrl+k")) {
      this.yank = this.buffer.slice(this.cursor);
      this.buffer = this.buffer.slice(0, this.cursor);
      this.changed();
      return true;
    }
    if (matchesKey(key, "ctrl+u")) {
      this.yank = this.buffer;
      this.buffer = "";
      this.cursor = 0;
      this.changed();
      return true;
    }
    if (matchesKey(key, "ctrl+y")) {
      if (this.yank) this.insert(this.yank);
      return true;
    }
    if (matchesKey(key, "ctrl+s")) {
      this.stashPrompt();
      return true;
    }
    if (matchesKey(key, "tab")) {
      const completion = this.provider?.complete(this.buffer.slice(0, this.cursor)) ?? null;
      if (completion && this.cursor === this.buffer.length) {
        this.insert(completion.insert);
        return true;
      }
      this.insert("  ");
      return true;
    }
    if (key.startsWith("\u001b")) return true; // swallow the rest
    if (key === "\t") {
      this.insert("  ");
      return true;
    }
    if (key.length >= 1 && key >= " " && ![...key].some((c) => /[\u0000-\u001f\u007f]/.test(c))) {
      this.insert(key);
      return true;
    }
    return false;
  }

  render(width: number): string[] {
    const lines = this.buffer.split("\n");
    // Cursor row/col in block coordinates.
    let cursorRow = lines.length - 1;
    {
      let offset = 0;
      for (let r = 0; r < lines.length; r++) {
        const len = (lines[r] ?? "").length;
        if (this.cursor <= offset + len) {
          cursorRow = r;
          break;
        }
        offset += len + 1;
      }
    }
    // Ghost remainder after the cursor, only at end of input.
    let ghost = "";
    if (this.provider && this.cursor === this.buffer.length) {
      ghost = theme.muted(this.provider.ghost(this.buffer) || "");
    }
    const rows: string[] = [];
    for (let r = 0; r < lines.length; r++) {
      let text = (r === 0 ? this.prompt : "") + (lines[r] ?? "") + (r === lines.length - 1 ? ghost : "");
      if (r === 0 && this.buffer.startsWith("/")) {
        const raw = lines[r] ?? "";
        const space = raw.indexOf(" ");
        const cmd = space === -1 ? raw : raw.slice(0, space);
        const rest = space === -1 ? "" : raw.slice(space);
        text = this.prompt + theme.success(cmd) + rest + (r === lines.length - 1 ? ghost : "");
      }
      rows.push(truncateToWidth(text, width));
    }
    // Place hardware-cursor marker at the cursor column.
    const lineText = lines[cursorRow] ?? "";
    const lineStartOffset =
      lines.slice(0, cursorRow).join("\n").length + (cursorRow > 0 ? 1 : 0);
    const colInLine = Math.max(0, this.cursor - lineStartOffset);
    const before = (cursorRow === 0 ? this.prompt : "") + lineText.slice(0, colInLine);
    const col = visibleWidth(stripForCursor(before));
    rows[cursorRow] = insertMarker(rows[cursorRow] ?? "", col);
    return rows;
  }

  invalidate(): void {}

  private changed(): void {
    this.historyIndex = -1;
    this.onChange?.(this.getText());
  }

  private insert(s: string): void {
    this.buffer = this.buffer.slice(0, this.cursor) + s + this.buffer.slice(this.cursor);
    this.cursor += s.length;
    this.changed();
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
    return /[A-Za-z0-9]/.test(ch);
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
    let targetOffset = 0;
    for (let r = 0; r < target; r++) targetOffset += (lines[r] ?? "").length + 1;
    this.cursor = targetOffset + Math.min(col, (lines[target] ?? "").length);
  }

  private historyStep(dir: 1 | -1): void {
    if (dir === 1) {
      if (this.history.length > 0 && this.historyIndex < this.history.length - 1) {
        if (this.historyIndex === -1) this.savedBuffer = this.buffer;
        this.historyIndex += 1;
        this.buffer = this.history[this.history.length - 1 - this.historyIndex] ?? "";
        this.cursor = this.buffer.length;
        this.changed();
      }
    } else if (this.historyIndex > 0) {
      this.historyIndex -= 1;
      this.buffer = this.history[this.history.length - 1 - this.historyIndex] ?? "";
      this.cursor = this.buffer.length;
      this.changed();
    } else if (this.historyIndex === 0) {
      this.historyIndex = -1;
      this.buffer = this.savedBuffer;
      this.cursor = this.buffer.length;
      this.changed();
    }
  }

  private collapsePaste(pasted: string): string {
    const rows = pasted.split("\n").length;
    if (rows <= 10) return pasted;
    this.pasteSeq += 1;
    const id = this.pasteSeq;
    this.pastes.set(id, pasted);
    return `[paste #${id} +${rows} lines]`;
  }

  private expandPastes(text: string): string {
    return text.replace(/\[paste #(\d+) \+\d+ lines\]/g, (m, id: string) => this.pastes.get(Number(id)) ?? m);
  }
}

function stripForCursor(s: string): string {
  return s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
}

/** Insert CURSOR_MARKER at a visible column of an (ANSI-styled) row. */
function insertMarker(row: string, col: number): string {
  let w = 0;
  let out = "";
  const ansi = /\u001b\[[0-9;?]*[A-Za-z]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const pushText = (text: string): boolean => {
    let done = false;
    for (const ch of text) {
      if (w >= col && !done) {
        out += CURSOR_MARKER;
        done = true;
      }
      out += ch;
      const code = ch.codePointAt(0) ?? 0;
      w += code >= 0x1100 && code <= 0x115f ? 2 : 1;
    }
    return done;
  };
  while ((m = ansi.exec(row)) !== null) {
    if (pushText(row.slice(last, m.index))) {
      out += row.slice(m.index);
      return out;
    }
    out += m[0];
    last = m.index + m[0].length;
  }
  if (!pushText(row.slice(last))) out += CURSOR_MARKER;
  return out;
}
