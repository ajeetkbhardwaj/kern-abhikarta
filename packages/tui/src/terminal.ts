/**
 * @kern/tui — terminal backend.
 *
 * Raw-mode stdin, size tracking, synchronized output (CSI 2026) for atomic
 * flicker-free frames, bracketed paste, cursor primitives. No dependencies.
 */

export const ESC = "\u001b";
export const CSI = `${ESC}[`;
export const HIDE_CURSOR = `${CSI}?25l`;
export const SHOW_CURSOR = `${CSI}?25h`;
export const CLEAR_LINE = `${CSI}2K\r`;
export const CLEAR_TO_END = `${CSI}0J`;
export const SYNC_BEGIN = `${CSI}?2026h`;
export const SYNC_END = `${CSI}?2026l`;
export const ENABLE_PASTE = `${CSI}?2004h`;
export const DISABLE_PASTE = `${CSI}?2004l`;
export const CURSOR_MARKER = "\u001bP1;1|kern-cursor\u001b\\";

export interface Terminal {
  columns(): number;
  rows(): number;
  write(data: string): void;
}

export class ProcessTerminal implements Terminal {
  columns(): number {
    return process.stdout.columns && process.stdout.columns > 0 ? process.stdout.columns : 80;
  }

  rows(): number {
    return process.stdout.rows && process.stdout.rows > 0 ? process.stdout.rows : 24;
  }

  write(data: string): void {
    process.stdout.write(data);
  }
}

let rawCount = 0;

/** Enter raw mode (ref-counted) and resume stdin. */
export function rawModeOn(): void {
  if (rawCount === 0 && process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
  }
  rawCount++;
}

/** Leave raw mode; pauses stdin when the last owner exits. */
export function rawModeOff(): void {
  rawCount = Math.max(0, rawCount - 1);
  if (rawCount === 0 && process.stdin.isTTY) {
    try {
      process.stdin.setRawMode(false);
    } catch {
      // already restored
    }
    process.stdin.pause();
  }
}
