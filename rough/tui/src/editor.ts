/**
 * @kern/tui — multiline Editor component.
 *
 * Offset-based cursor, readline bindings, word ops, kill ring, history,
 * bracketed paste (large pastes collapse to a `[paste #N +M lines]`
 * marker), slash/file autocomplete via provider, ghost-text remainder plus
 * a stateful completion dropdown under the input. Emits CURSOR_MARKER for
 * hardware-cursor (IME) positioning. Long lines soft-wrap with correct
 * cursor mapping.
 */

import type { Component, Focusable } from "./component.js";
import { CURSOR_MARKER } from "./terminal.js";
import { theme } from "./theme.js";
import { truncateToWidth, visibleWidth, charWidth, splitKeys } from "./text.js";
import { matchesKey, parseKey } from "./keys.js";

export interface Completion {
  /** Text to insert for the token at the cursor. */
  insert: string;
  /** Full replacement rows for dropdown-style completion, or null. */
  dropdown: string[] | null;
}

/** One dropdown row: suffix to insert plus display text. */
export interface DropdownItem {
  /** Suffix to insert at the cursor for the active token. */
  insert: string;
  /** Display text for the row. */
  display: string;
  /** Optional right-hand hint (e.g. command description). */
  description?: string;
  /** Token kind, for ranking/styling. */
  kind?: "command" | "file";
}

export interface AutocompleteProvider {
  /** Completions for the token ending at the cursor. */
  complete(beforeCursor: string): Completion | null;
  /** Ghost remainder shown dim after the cursor. */
  ghost(beforeCursor: string): string;
  /** Ranked dropdown items for the token ending at the cursor. */
  list?(beforeCursor: string): DropdownItem[];
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

/** Max dropdown rows rendered under the input. */
const MAX_DROPDOWN = 8;

const PASTE_MARKER_RE = /^\[paste #(\d+) \+(\d+) lines\]$/;

export class Editor implements Component, Focusable {
  focused = false;
  onSubmit: ((text: string) => void) | null = null;
  /** Fired on Esc with an empty buffer (dismiss dialogs). */
  onEscape: (() => void) | null = null;
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
  private dropIndex = 0;
  private dropDismissed = false;
  private provider: AutocompleteProvider | null = null;

  constructor(
    private readonly prompt = "› ",
    private readonly theme_: EditorTheme = defaultEditorTheme,
  ) {}

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
    this.dropDismissed = false;
    this.dropIndex = 0;
    this.onChange?.(this.getText());
  }

  clear(): void {
    this.buffer = "";
    this.cursor = 0;
    this.historyIndex = -1;
    this.dropDismissed = false;
    this.dropIndex = 0;
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
    this.dropDismissed = false;
    this.dropIndex = 0;
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
    const parsed = parseKey(key);
    const items = this.dropdownItems();
    const open = items.length > 0;
    const isUp = parsed === "up" || (typeof parsed === "string" && parsed.endsWith("+up"));
    const isDown = parsed === "down" || (typeof parsed === "string" && parsed.endsWith("+down"));

    if (matchesKey(key, "escape")) {
      if (open) {
        this.dropDismissed = true;
        return true;
      }
      if (this.buffer.length > 0) {
        this.buffer = "";
        this.cursor = 0;
      } else {
        this.onEscape?.();
      }
      return true;
    }
    // Dropdown takes precedence for navigation + accept.
    if (open) {
      if (isUp) {
        this.dropIndex = (this.dropIndex - 1 + items.length) % items.length;
        return true;
      }
      if (isDown) {
        this.dropIndex = (this.dropIndex + 1) % items.length;
        return true;
      }
      if (matchesKey(key, "tab")) {
        this.acceptDropdown(items);
        return true;
      }
      if (parsed === "enter") {
        this.acceptDropdown(items);
        return true;
      }
    }
    // Newline: Alt+Enter, Ctrl+J (LF), Shift+Enter, or any modified Enter.
    // Plain Enter (CR / Kitty enter) submits; every Enter with modifiers
    // inserts a newline so Shift+Enter-style bindings keep working.
    if (
      key === "\u001b\r" ||
      key === "\u001b\n" ||
      matchesKey(key, "ctrl+j") ||
      (typeof parsed === "string" && parsed !== "enter" && parsed.endsWith("enter"))
    ) {
      this.insert("\n");
      return true;
    }
    if (parsed === "enter") {
      if (this.disableSubmit) return true;
      const line = this.getText();
      this.addToHistory(this.buffer);
      this.onSubmit?.(line);
      return true;
    }
    if (matchesKey(key, "ctrl+c")) {
      if (this.buffer.length === 0) return false; // let app exit/abort
      this.buffer = "";
      this.cursor = 0;
      this.dropDismissed = false;
      this.dropIndex = 0;
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
    if (matchesKey(key, "delete")) {
      if (this.cursor < this.buffer.length) {
        this.buffer = this.buffer.slice(0, this.cursor) + this.buffer.slice(this.cursor + 1);
        this.changed();
      }
      return true;
    }
    if (matchesKey(key, "home")) {
      this.cursor = this.lineStart();
      return true;
    }
    if (matchesKey(key, "end")) {
      this.cursor = this.lineEnd();
      return true;
    }
    if (matchesKey(key, "pageup")) {
      if (this.multiline()) this.moveVertically(-5);
      else this.historyStep(1);
      return true;
    }
    if (matchesKey(key, "pagedown")) {
      if (this.multiline()) this.moveVertically(5);
      else this.historyStep(-1);
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
      if (this.dropDismissed) {
        this.insert("  ");
        return true;
      }
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
    const w = Math.max(1, width);
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
    let markerRow = -1;
    let markerCol = 0;
    for (let r = 0; r < lines.length; r++) {
      const raw = lines[r] ?? "";
      let text = (r === 0 ? this.prompt : "") + raw + (r === lines.length - 1 ? ghost : "");
      if (r === 0 && this.buffer.startsWith("/")) {
        const space = raw.indexOf(" ");
        const cmd = space === -1 ? raw : raw.slice(0, space);
        const rest = space === -1 ? "" : raw.slice(space);
        text = this.prompt + theme.success(cmd) + rest + (r === lines.length - 1 ? ghost : "");
      }
      const wrapped = wrapAnsiRow(text, w);
      if (r === cursorRow) {
        // Visual cursor position: wrap the text before the cursor with the
        // same width so soft-wrap breaks line up exactly.
        const lineStartOffset =
          lines.slice(0, cursorRow).join("\n").length + (cursorRow > 0 ? 1 : 0);
        const colInLine = Math.max(0, this.cursor - lineStartOffset);
        const before = (cursorRow === 0 ? this.prompt : "") + raw.slice(0, colInLine);
        const beforeRows = wrapAnsiRow(before, w);
        const rowOff = Math.min(beforeRows.length - 1, wrapped.length - 1);
        markerRow = rows.length + Math.max(0, rowOff);
        markerCol = visibleWidth(beforeRows[Math.max(0, rowOff)] ?? "");
      }
      rows.push(...wrapped);
    }
    if (markerRow >= 0 && markerRow < rows.length) {
      rows[markerRow] = insertMarker(rows[markerRow] ?? "", markerCol);
    } else if (rows.length > 0) {
      rows[rows.length - 1] = (rows[rows.length - 1] ?? "") + CURSOR_MARKER;
    } else {
      rows.push(CURSOR_MARKER);
    }
    // Completion dropdown under the input block.
    const items = this.dropdownItems();
    if (items.length > 0) {
      if (this.dropIndex >= items.length) this.dropIndex = 0;
      const shown = items.slice(0, MAX_DROPDOWN);
      shown.forEach((item, i) => {
        const active = i === this.dropIndex;
        const prefix = active ? this.theme_.selectedPrefix("❯ ") : "  ";
        const label = active ? this.theme_.selectedText(item.display) : item.display;
        const hint = item.description ? this.theme_.description(`  ${item.description}`) : "";
        rows.push(truncateToWidth(prefix + label + hint, w));
      });
      if (items.length > shown.length) {
        rows.push(this.theme_.scrollInfo(`… ${items.length - shown.length} more`));
      }
    }
    return rows;
  }

  invalidate(): void {}

  private dropdownItems(): DropdownItem[] {
    if (this.dropDismissed) return [];
    const list = this.provider?.list;
    if (typeof list !== "function") return [];
    try {
      const items = list.call(this.provider, this.buffer.slice(0, this.cursor));
      if (!Array.isArray(items) || items.length === 0) return [];
      return items.slice(0, MAX_DROPDOWN);
    } catch {
      return [];
    }
  }

  private acceptDropdown(items: DropdownItem[]): void {
    const sel = items[this.dropIndex] ?? items[0];
    if (!sel) return;
    this.insert(sel.insert);
  }

  private changed(): void {
    this.historyIndex = -1;
    this.dropDismissed = false;
    this.dropIndex = 0;
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

  private moveVertically(dir: number): void {
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
    const target = Math.max(0, Math.min(lines.length - 1, row + dir));
    if (target === row) return;
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
        this.historyChanged();
      }
    } else if (this.historyIndex > 0) {
      this.historyIndex -= 1;
      this.buffer = this.history[this.history.length - 1 - this.historyIndex] ?? "";
      this.cursor = this.buffer.length;
      this.historyChanged();
    } else if (this.historyIndex === 0) {
      this.historyIndex = -1;
      this.buffer = this.savedBuffer;
      this.cursor = this.buffer.length;
      this.historyChanged();
    }
  }

  /** Like changed() but preserves historyIndex for history navigation. */
  private historyChanged(): void {
    this.dropDismissed = false;
    this.dropIndex = 0;
    this.onChange?.(this.getText());
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
    void PASTE_MARKER_RE;
    return text.replace(/\[paste #(\d+) \+\d+ lines\]/g, (m, id: string) => this.pastes.get(Number(id)) ?? m);
  }
}

/**
 * Hard-wrap an ANSI-styled row to `width` visible columns, carrying the
 * active SGR style onto continuation rows so colors survive the break.
 */
function wrapAnsiRow(text: string, width: number): string[] {
  if (width <= 0) return [text];
  if (visibleWidth(text) <= width) return [text];
  const rows: string[] = [];
  let cur = "";
  let curW = 0;
  let active = "";
  const ansi = /\u001b\[[0-9;?]*[A-Za-z]|\u001b[PX^_][^\u001b\\]*(?:\u001b\\)?|\u001b[@-Z\\-_]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const pushChar = (ch: string): void => {
    const cw = charWidth(ch.codePointAt(0) ?? 0);
    if (cw === 0) {
      cur += ch;
      return;
    }
    if (curW + cw > width) {
      rows.push(cur + (active ? "\u001b[0m" : ""));
      cur = active;
      curW = 0;
      if (cw > width) {
        // Wider than the whole row (narrow screen + wide char): place it
        // anyway instead of looping forever on empty rows.
        cur += ch;
        curW += cw;
        return;
      }
    }
    cur += ch;
    curW += cw;
  };
  while ((m = ansi.exec(text)) !== null) {
    for (const ch of text.slice(last, m.index)) pushChar(ch);
    const esc = m[0];
    cur += esc;
    if (/^\u001b\[0+m?$/.test(esc)) active = "";
    else if (/^\u001b\[[0-9;?]*m$/.test(esc)) active = esc;
    last = m.index + esc.length;
  }
  for (const ch of text.slice(last)) pushChar(ch);
  rows.push(cur);
  return rows;
}

function stripForCursor(s: string): string {
  return s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
}

/** Insert CURSOR_MARKER at a visible column of an (ANSI-styled) row. */
function insertMarker(row: string, col: number): string {
  void stripForCursor;
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
