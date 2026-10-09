/**
 * @kern/tui — main-screen renderer with differential updates.
 *
 * Renders into the main terminal buffer (scrollback preserved). Each frame
 * computes all rows, finds the first row differing from the committed
 * frame, and repaints from there to the end of screen — never touching
 * scrolled history. Frames are wrapped in synchronized output (CSI 2026)
 * for atomic, flicker-free updates. Overlays append below the document and
 * vanish on close via the same diff. Resize triggers a full repaint.
 */

import type { Component, Focusable } from "./component.js";
import { findCursor, isFocusable } from "./component.js";
import { CURSOR_MARKER, HIDE_CURSOR, SHOW_CURSOR, CLEAR_TO_END, SYNC_BEGIN, SYNC_END, ENABLE_PASTE, DISABLE_PASTE, rawModeOff, rawModeOn } from "./terminal.js";
import { splitKeys } from "./text.js";

export type InputResult = { consume: boolean } | undefined;
export type InputHook = (key: string) => InputResult;

const UP = (n: number) => (n > 0 ? `\u001b[${n}A` : "");

export class Screen {
  private readonly children: Component[] = [];
  private readonly overlays: Component[] = [];
  private focus: Component | null = null;
  private hook: InputHook | null = null;
  private committed: string[] = [];
  private scheduled = false;
  private running = false;
  private escTimer: ReturnType<typeof setTimeout> | null = null;
  private heldChunk = "";
  private width = 80;

  addChild(c: Component): void {
    this.children.push(c);
    this.requestRender();
  }

  removeChild(c: Component): void {
    const i = this.children.indexOf(c);
    if (i !== -1) this.children.splice(i, 1);
    this.requestRender();
  }

  setFocus(c: Component | null): void {
    if (this.focus && isFocusable(this.focus)) this.focus.focused = false;
    this.focus = c;
    if (c && isFocusable(c)) c.focused = true;
    this.requestRender();
  }

  setInputHook(hook: InputHook | null): void {
    this.hook = hook;
  }

  showOverlay(c: Component): void {
    // Only one overlay at a time in v1; replace the top.
    if (this.overlays.length > 0) this.overlays.pop();
    this.overlays.push(c);
    this.requestRender();
  }

  hideOverlay(): void {
    this.overlays.pop();
    this.requestRender();
  }

  hasOverlay(): boolean {
    return this.overlays.length > 0;
  }

  overlayTop(): Component | null {
    return this.overlays.length > 0 ? (this.overlays[this.overlays.length - 1] as Component) : null;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.width = process.stdout.columns && process.stdout.columns > 0 ? process.stdout.columns : 80;
    rawModeOn();
    process.stdout.write(ENABLE_PASTE + HIDE_CURSOR);
    process.stdin.on("data", this.onData);
    process.stdout.on("resize", this.onResize);
    this.renderNow();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.escTimer) clearTimeout(this.escTimer);
    process.stdin.removeListener("data", this.onData);
    process.stdout.removeListener("resize", this.onResize);
    process.stdout.write(DISABLE_PASTE + SHOW_CURSOR);
    rawModeOff();
  }

  requestRender(): void {
    if (!this.running || this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      this.renderNow();
    });
  }

  renderNow(): void {
    if (!this.running) return;
    const width = process.stdout.columns && process.stdout.columns > 0 ? process.stdout.columns : 80;
    if (width !== this.width) {
      this.width = width;
      this.fullRepaint();
      return;
    }
    const rows = this.compose(width);
    this.paintDiff(rows);
    this.committed = rows;
  }

  private compose(width: number): string[] {
    const rows: string[] = [];
    for (const child of this.children) rows.push(...child.render(width));
    for (const overlay of this.overlays) {
      rows.push("─".repeat(Math.max(8, Math.min(width, 48))));
      rows.push(...overlay.render(width));
    }
    return rows;
  }

  private paintDiff(rows: string[]): void {
    const prev = this.committed;
    let first = 0;
    while (first < prev.length && first < rows.length && prev[first] === rows[first]) first++;
    if (first === prev.length && first === rows.length) {
      this.placeCursor(rows);
      return;
    }
    let out = SYNC_BEGIN;
    out += UP(prev.length - first);
    out += "\r" + CLEAR_TO_END;
    out += stripMarkers(rows.slice(first)).join("\r\n");
    if (rows.length > first) out += "\r\n";
    out += SYNC_END;
    process.stdout.write(out);
    this.placeCursor(rows);
  }

  private placeCursor(rows: string[]): void {
    // Cursor always sits at the end of the painted region (row rows.length).
    if (this.overlays.length > 0) {
      process.stdout.write(HIDE_CURSOR);
      return;
    }
    const focusable = this.focus && isFocusable(this.focus) ? this.focus : null;
    const at = focusable && focusable.focused ? findCursor(rows) : null;
    if (!at) {
      process.stdout.write(HIDE_CURSOR);
      return;
    }
    // Move from below end-of-output to the marker row/col.
    const up = rows.length - at.row;
    process.stdout.write(SHOW_CURSOR + UP(up) + "\r" + `\u001b[${at.col + 1}G`);
  }

  private fullRepaint(): void {
    process.stdout.write(SYNC_BEGIN + "\u001b[2J\u001b[H" + SYNC_END);
    this.committed = [];
    const rows = this.compose(this.width);
    process.stdout.write(SYNC_BEGIN + stripMarkers(rows).join("\r\n") + (rows.length > 0 ? "\r\n" : "") + SYNC_END);
    this.placeCursor(rows);
    this.committed = rows;
  }

  private onResize = (): void => {
    this.fullRepaint();
  };

  private onData = (chunk: string): void => {
    // Hold a trailing lone ESC briefly: it may head a split sequence.
    if (this.escTimer) {
      clearTimeout(this.escTimer);
      this.escTimer = null;
      const combined = this.heldChunk + chunk;
      this.heldChunk = "";
      this.dispatch(combined);
      return;
    }
    if (chunk.endsWith("\u001b")) {
      this.heldChunk = chunk;
      this.escTimer = setTimeout(() => {
        this.escTimer = null;
        const pending = this.heldChunk;
        this.heldChunk = "";
        this.dispatch(pending);
      }, 40);
      return;
    }
    this.dispatch(chunk);
  };

  private dispatch(chunk: string): void {
    for (const key of splitKeys(chunk)) {
      const hookResult = this.hook?.(key);
      if (hookResult?.consume) continue;
      const top = this.overlayTop();
      if (top?.handleInput && top.handleInput(key)) {
        this.requestRender();
        continue;
      }
      if (top) continue; // overlay open: unhandled keys go nowhere
      if (this.focus?.handleInput && this.focus.handleInput(key)) {
        this.requestRender();
      }
    }
  }
}

function stripMarkers(rows: string[]): string[] {
  return rows.map((r) => r.split(CURSOR_MARKER).join(""));
}
