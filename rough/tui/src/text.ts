/**
 * @kern/tui — text measurement and wrapping.
 *
 * Width math ignores ANSI escapes; east-asian wide chars count 2, combining
 * marks 0. Wrap preserves ANSI styles across line breaks.
 */

const ANSI_RE = /\u001b\[[0-9;?]*[A-Za-z]|\u001b[PX^_][^\u001b\\]*(?:\u001b\\)?|\u001b[@-Z\\-_]/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

export function charWidth(code: number): number {
  if (code >= 0x0300 && code <= 0x036f) return 0;
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
  for (const ch of plain) w += charWidth(ch.codePointAt(0) ?? 0);
  return w;
}

/** Split raw stdin into keys: single chars, CSI sequences, paste blocks. */
export function splitKeys(data: string): string[] {
  const keys: string[] = [];
  let i = 0;
  while (i < data.length) {
    // Bracketed paste block is one unit.
    if (data.startsWith("\u001b[200~", i)) {
      const end = data.indexOf("\u001b[201~", i + 6);
      if (end === -1) {
        keys.push(data.slice(i));
        break;
      }
      keys.push(data.slice(i, end + 6));
      i = end + 6;
      continue;
    }
    // Alt+Enter (ESC CR / ESC LF) is one unit.
    if (data[i] === "\u001b" && (data[i + 1] === "\r" || data[i + 1] === "\n")) {
      keys.push(data.slice(i, i + 2));
      i += 2;
      continue;
    }
    // Alt+letter (ESC + char) is one unit.
    if (data[i] === "\u001b" && i + 1 < data.length && data[i + 1] !== "[") {
      const code = data.codePointAt(i + 1) ?? 0;
      const len = code > 0xffff ? 2 : 1;
      keys.push(data.slice(i, i + 1 + len));
      i += 1 + len;
      continue;
    }
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

/** Truncate to columns, preserving ANSI styles, with ellipsis. */
export function truncateToWidth(s: string, maxWidth: number, ellipsis = "…"): string {
  if (visibleWidth(s) <= maxWidth) return s;
  const target = Math.max(0, maxWidth - visibleWidth(ellipsis));
  let w = 0;
  let out = "";
  const re = new RegExp(ANSI_RE.source, "g");
  let last = 0;
  let m: RegExpExecArray | null;
  const pushText = (text: string) => {
    for (const ch of text) {
      const cw = charWidth(ch.codePointAt(0) ?? 0);
      if (w + cw > target) return false;
      out += ch;
      w += cw;
    }
    return true;
  };
  while ((m = re.exec(s)) !== null) {
    if (!pushText(s.slice(last, m.index))) break;
    out += m[0];
    last = m.index + m[0].length;
  }
  pushText(s.slice(last));
  return out + ellipsis + "\u001b[0m";
}

/** Wrap ANSI-styled text to width, reapplying styles on each row. */
export function wrapTextWithAnsi(text: string, width: number): string[] {
  const rows: string[] = [];
  for (const raw of text.split("\n")) {
    if (visibleWidth(raw) <= width || raw.length === 0) {
      rows.push(raw);
      continue;
    }
    // Tokenize into (ansi | word | space) pieces.
    const tokens: string[] = [];
    const re = new RegExp(`(${ANSI_RE.source}|\\s+)`, "g");
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) {
      if (m.index > last) tokens.push(raw.slice(last, m.index));
      tokens.push(m[0]);
      last = m.index + m[0].length;
    }
    if (last < raw.length) tokens.push(raw.slice(last));
    let current = "";
    let active = "";
    const styled = (t: string) => active + t;
    for (const tok of tokens) {
      if (/^\u001b/.test(tok)) {
        current += tok;
        active = tok.endsWith("\u001b[0m") ? "" : tok;
        continue;
      }
      if (/^\s+$/.test(tok)) {
        if (visibleWidth(current) + visibleWidth(tok) <= width) current += tok;
        continue;
      }
      if (visibleWidth(current) + visibleWidth(tok) <= width) {
        current += tok;
      } else {
        rows.push(current);
        current = styled(tok);
        // Hard-break overlong tokens.
        while (visibleWidth(current) > width) {
          let w = 0;
          let k = 0;
          const plain = stripAnsi(current);
          for (const ch of plain) {
            const cw = charWidth(ch.codePointAt(0) ?? 0);
            if (w + cw > width) break;
            w += cw;
            k += ch.length;
          }
          rows.push(current.slice(0, k) + "\u001b[0m");
          current = styled(plain.slice(k));
        }
      }
    }
    rows.push(current);
  }
  return rows;
}
