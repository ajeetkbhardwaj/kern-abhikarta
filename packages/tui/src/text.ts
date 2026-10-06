/**
 * @kern/tui — text measurement and wrapping.
 *
 * Minimal and ASCII-safe: strips ANSI escapes for width, wraps on spaces.
 * Wide (CJK) characters count as 2 columns; combining marks as 0.
 */

const ANSI_RE = /\u001b\[[0-9;?]*[A-Za-z]/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

export function charWidth(code: number): number {
  if (code >= 0x0300 && code <= 0x036f) return 0; // combining diacriticals
  if (code >= 0x1100 && code <= 0x115f) return 2;
  if (code >= 0x2e80 && code <= 0xa4cf) return 2;
  if (code >= 0xac00 && code <= 0xd7a3) return 2;
  if (code >= 0xf900 && code <= 0xfaff) return 2;
  if (code >= 0xfe30 && code <= 0xfe4f) return 2;
  if (code >= 0xff00 && code <= 0xff60) return 2;
  if (code >= 0xffe0 && code <= 0xffe6) return 2;
  if (code >= 0x20000 && code <= 0x3fffd) return 2;
  return 1;
}

export function visibleWidth(s: string): number {
  const plain = stripAnsi(s);
  let w = 0;
  for (const ch of plain) {
    const code = ch.codePointAt(0) ?? 0;
    w += charWidth(code);
  }
  return w;
}

export function truncateToWidth(s: string, maxWidth: number): string {
  if (visibleWidth(s) <= maxWidth) return s;
  let w = 0;
  let out = "";
  const plain = stripAnsi(s);
  for (const ch of plain) {
    const cw = charWidth(ch.codePointAt(0) ?? 0);
    if (w + cw > maxWidth - 1) break;
    out += ch;
    w += cw;
  }
  return out + "…";
}

/**
 * Split a raw stdin chunk into keys: single chars, or one ANSI escape
 * sequence per key. Handles coalesced pastes (`/quit\r` in one chunk).
 */
export function splitKeys(data: string): string[] {
  const keys: string[] = [];
  let i = 0;
  while (i < data.length) {
    if (data[i] === "\u001b" && data[i + 1] === "[") {
      let j = i + 2;
      while (j < data.length && /[0-9;?]/.test(data[j] ?? "")) j++;
      if (j < data.length) j++; // final byte
      keys.push(data.slice(i, j));
      i = j;
    } else {
      const code = data.codePointAt(i) ?? 0;
      const len = code > 0xffff ? 2 : 1;
      keys.push(data.slice(i, i + len));
      i += len;
    }
  }
  return keys;
}

/** Wrap plain text (no ANSI) to width on word boundaries. */
export function wrapText(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const raw of text.split("\n")) {
    if (visibleWidth(raw) <= width) {
      lines.push(raw);
      continue;
    }
    const words = raw.split(/(\s+)/);
    let current = "";
    for (const word of words) {
      if (visibleWidth(current + word) <= width) {
        current += word;
      } else {
        if (current.trim().length > 0) lines.push(current.trimEnd());
        current = word.trimStart();
        while (visibleWidth(current) > width) {
          let w = 0;
          let i = 0;
          for (const ch of current) {
            const cw = charWidth(ch.codePointAt(0) ?? 0);
            if (w + cw > width) break;
            w += cw;
            i += ch.length;
          }
          lines.push(current.slice(0, i));
          current = current.slice(i);
        }
      }
    }
    lines.push(current);
  }
  return lines;
}

export function terminalWidth(): number {
  return process.stdout.columns && process.stdout.columns > 0 ? process.stdout.columns : 80;
}
