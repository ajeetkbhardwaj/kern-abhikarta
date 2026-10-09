/**
 * @kern/tui — component model.
 *
 * A component renders rows for a width, optionally handles keys, and clears
 * cached state on invalidate(). Focusable components place CURSOR_MARKER
 * where the hardware cursor belongs (IME positioning).
 */

import { CURSOR_MARKER } from "./terminal.js";
import { visibleWidth } from "./text.js";

export { CURSOR_MARKER };

export interface Component {
  render(width: number): string[];
  handleInput?(key: string): boolean;
  invalidate(): void;
}

export interface Focusable extends Component {
  focused: boolean;
}

export function isFocusable(c: Component): c is Focusable {
  return "focused" in c;
}

/** Locate CURSOR_MARKER in rendered rows → {row, col(visible)}. */
export function findCursor(rows: string[]): { row: number; col: number } | null {
  for (let r = 0; r < rows.length; r++) {
    const line = rows[r] ?? "";
    const at = line.indexOf(CURSOR_MARKER);
    if (at !== -1) {
      return { row: r, col: visibleWidth(line.slice(0, at)) };
    }
  }
  return null;
}
