/**
 * @kern/tui — multiline Editor component (pi-tui wrapper).
 *
 * This used to be a hand-rolled offset-based editor. It is now a thin
 * wrapper around MIT `@earendil-works/pi-tui`'s `Editor`, which owns the
 * buffer, cursor, kill ring, undo stack, history browsing, bracketed paste
 * collapsing, and the autocomplete dropdown. The wrapper exists only to:
 *
 * - keep OUR public API stable for the orchestrator (`tui.ts`): onSubmit /
 *   onEscape / onChange, disableSubmit, getText / setText / clear /
 *   addToHistory / stashPrompt / setAutocompleteProvider, handleData /
 *   handleInput / render / focused;
 * - emulate `onEscape` (pi-tui has no such hook — see below);
 * - implement `stashPrompt` (pi-tui has no stash — no Ctrl+S binding, no
 *   buffer save/restore);
 * - preserve Ctrl+C / Ctrl+D "return false on empty buffer" semantics so
 *   the app can exit/abort;
 * - map our `EditorTheme` onto pi-tui's `{ borderColor, selectList }`.
 *
 * Escape behavior (verified against pi-tui 1.1.0 `components/editor.js`):
 * pi consumes Escape ONLY while its autocomplete dropdown is open
 * (`tui.select.cancel` → `cancelAutocomplete()`). A bare Escape with no
 * dropdown open falls through its `handleInput` and is ignored (never
 * throws, never calls out). So the wrapper intercepts bare Escape BEFORE
 * delegating: dropdown open → let pi dismiss it; non-empty buffer → clear
 * it (matches our old first-Esc-clears behavior); empty buffer → fire
 * `onEscape` (used by prompt dialogs for Esc-cancel).
 *
 * NOTE on dispatch order: the screen-level input hook runs BEFORE the
 * focused component (`Screen.dispatch`: hook → overlay → focus), so while
 * no overlay is open the orchestrator's hook sees Escape first. Prompt
 * dialogs (`promptText`) route overlay input straight to this editor, so
 * `onEscape` here is what cancels them.
 */

import {
  Editor as PiEditor,
  type AutocompleteProvider as PiAutocompleteProvider,
  type EditorTheme as PiEditorTheme,
  type TUI,
} from "@earendil-works/pi-tui";
import type { Component, Focusable } from "./component.js";
import { theme } from "./theme.js";
import { splitKeys } from "./text.js";
import { matchesKey } from "./keys.js";

/** Autocomplete provider contract — now exactly pi-tui's. */
export type AutocompleteProvider = PiAutocompleteProvider;

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

/** Max autocomplete rows requested from the inner pi-tui editor. */
export const MAX_DROPDOWN = 8;

function toPiTheme(t: EditorTheme): PiEditorTheme {
  return {
    borderColor: t.borderColor,
    selectList: {
      selectedPrefix: t.selectedPrefix,
      selectedText: t.selectedText,
      description: t.description,
      scrollInfo: t.scrollInfo,
      noMatch: t.noMatch,
    },
  };
}

export class Editor implements Component, Focusable {
  focused = false;
  /** Fired on bare Esc with an empty buffer (dismiss dialogs). */
  onEscape: (() => void) | null = null;

  private readonly inner: PiEditor;
  private stash = "";

  /**
   * @param tui Host used for `requestRender()` callbacks and terminal rows.
   *   Accepts our `Screen` (or a real pi-tui `TUI`); only `requestRender`
   *   is required — terminal rows fall back to `process.stdout.rows`.
   * @param prompt Kept for call-site compatibility. pi-tui's editor renders
   *   no prompt prefix of its own (previously `› ` was drawn by us); the
   *   surrounding `Box` title now carries that affordance.
   */
  constructor(
    tui: TUI,
    private readonly prompt = "> ",
    private readonly theme_: EditorTheme = defaultEditorTheme,
  ) {
    void this.prompt;
    const rowsOf = (): number =>
      (tui as unknown as { terminal?: { rows?: number } }).terminal?.rows ??
      process.stdout.rows ??
      24;
    // Our Screen satisfies the slice of pi-tui's TUI the editor touches
    // (`requestRender` + `terminal.rows`); adapt defensively so a Screen
    // can be passed without a cast at the call site.
    const piTui = {
      requestRender: (force?: boolean) => tui.requestRender(force),
      terminal: {
        get rows(): number {
          return rowsOf();
        },
      },
    } as unknown as TUI;
    this.inner = new PiEditor(piTui, toPiTheme(theme_), {
      autocompleteMaxVisible: MAX_DROPDOWN,
    });
  }

  get onSubmit(): ((text: string) => void) | null {
    return this.inner.onSubmit ?? null;
  }
  set onSubmit(fn: ((text: string) => void) | null | undefined) {
    this.inner.onSubmit = fn ?? undefined;
  }

  get onChange(): ((text: string) => void) | null {
    return this.inner.onChange ?? null;
  }
  set onChange(fn: ((text: string) => void) | null | undefined) {
    this.inner.onChange = fn ?? undefined;
  }

  get disableSubmit(): boolean {
    return this.inner.disableSubmit;
  }
  set disableSubmit(value: boolean) {
    this.inner.disableSubmit = value;
  }

  setAutocompleteProvider(provider: AutocompleteProvider): void {
    this.inner.setAutocompleteProvider(provider);
  }

  /** Buffer text with large-paste markers expanded (what gets submitted). */
  getText(): string {
    return this.inner.getExpandedText();
  }

  setText(text: string): void {
    this.inner.setText(text);
  }

  clear(): void {
    this.inner.setText("");
  }

  addToHistory(text: string): void {
    this.inner.addToHistory(text);
  }

  /**
   * Toggle-save the prompt: non-empty buffer is stashed and cleared;
   * empty buffer restores the stash. pi-tui has no equivalent (no Ctrl+S
   * binding, no draft API), so the wrapper owns the stash slot.
   */
  stashPrompt(): void {
    const current = this.inner.getExpandedText();
    if (current.length > 0) {
      this.stash = current;
      this.inner.setText("");
    } else if (this.stash) {
      this.inner.setText(this.stash);
    }
  }

  /** Whether pi-tui's autocomplete dropdown is currently open. */
  isShowingAutocomplete(): boolean {
    return this.inner.isShowingAutocomplete();
  }

  /** Raw stdin (may hold several keys or a paste block). */
  handleData(data: string): void {
    for (const key of splitKeys(data)) {
      if (!this.handleInput(key)) break;
    }
  }

  handleInput(key: string): boolean {
    if (matchesKey(key, "escape")) {
      // pi consumes Esc only to dismiss its autocomplete dropdown; it
      // ignores a bare Escape otherwise, so emulate our old semantics here.
      if (this.inner.isShowingAutocomplete()) {
        this.inner.handleInput(key);
        return true;
      }
      if (this.getText().length > 0) this.clear();
      else this.onEscape?.();
      return true;
    }
    if (matchesKey(key, "ctrl+c")) {
      if (this.getText().length === 0) return false; // let app exit/abort
      this.clear();
      return true;
    }
    if (matchesKey(key, "ctrl+d")) {
      if (this.getText().length === 0) return false;
      return true;
    }
    if (matchesKey(key, "ctrl+s")) {
      this.stashPrompt();
      return true;
    }
    this.inner.handleInput(key);
    return true;
  }

  render(width: number): string[] {
    return this.inner.render(width);
  }

  invalidate(): void {
    this.inner.invalidate();
  }
}
