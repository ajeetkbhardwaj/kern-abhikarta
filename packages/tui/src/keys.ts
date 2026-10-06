/**
 * @kern/tui — key identification.
 *
 * Parses raw terminal input (legacy sequences + a pragmatic Kitty-protocol
 * subset) into stable key ids. Matching is by id so callers never compare
 * raw bytes.
 */

export type KeyId =
  | "enter"
  | "escape"
  | "tab"
  | "shift+tab"
  | "space"
  | "backspace"
  | "delete"
  | "home"
  | "end"
  | "pageup"
  | "pagedown"
  | "up"
  | "down"
  | "left"
  | "right"
  | `ctrl+${string}`
  | `alt+${string}`
  | `ctrl+alt+${string}`
  | `shift+${string}`
  | { char: string };

function ctrlName(code: number): string {
  const map: Record<number, string> = {
    0: "space",
    9: "tab",
    13: "enter",
    27: "escape",
    127: "backspace",
  };
  if (code in map) return `ctrl+${map[code]}`;
  return `ctrl+${String.fromCharCode(code + 96)}`;
}

/** Identify a single key unit (see splitKeys). Falls back to { char }. */
export function parseKey(key: string): KeyId {
  if (key.length === 0) return { char: "" };
  const code = key.codePointAt(0) ?? 0;

  // C0 controls.
  if (key.length === 1 && code < 32) {
    if (key === "\r" || key === "\n") return "enter";
    if (key === "\t") return "tab";
    if (key === "\u001b") return "escape";
    return ctrlName(code) as KeyId;
  }
  if (key === "\u007f") return "backspace";

  // Alt+Enter.
  if (key === "\u001b\r" || key === "\u001b\n") return "alt+enter";
  // Alt+letter.
  if (key.startsWith("\u001b") && !key.startsWith("\u001b[")) {
    const rest = key.slice(1).toLowerCase();
    return `alt+${rest}` as KeyId;
  }

  // Kitty progressive: CSI number [; modifiers] u.
  const kitty = key.match(/^\u001b\[(\d+)(?::\d+)?;(\d+)u$/);
  if (kitty) {
    const num = Number(kitty[1]);
    const mods = Number(kitty[2]) - 1;
    const base =
      num === 13 ? "enter" : num === 9 ? "tab" : num === 27 ? "escape" : num === 127 ? "backspace" : String.fromCharCode(num).toLowerCase();
    const parts: string[] = [];
    if (mods & 4) parts.push("ctrl");
    if (mods & 2) parts.push("alt");
    if (mods & 1) parts.push("shift");
    parts.push(base);
    return parts.join("+") as KeyId;
  }

  // Legacy CSI.
  switch (key) {
    case "\u001b[A":
      return "up";
    case "\u001b[B":
      return "down";
    case "\u001b[C":
      return "right";
    case "\u001b[D":
      return "left";
    case "\u001b[H":
    case "\u001b[1~":
      return "home";
    case "\u001b[F":
    case "\u001b[4~":
      return "end";
    case "\u001b[3~":
      return "delete";
    case "\u001b[5~":
      return "pageup";
    case "\u001b[6~":
      return "pagedown";
    case "\u001b[Z":
      return "shift+tab";
  }
  // CSI with modifiers: ESC [ 1 ; mod (A-D, H, F, Z).
  const mod = key.match(/^\u001b\[1;(\d+)([A-DHFZ])$/);
  if (mod) {
    const mods = Number(mod[1]) - 1;
    const base =
      mod[2] === "A" ? "up" : mod[2] === "B" ? "down" : mod[2] === "C" ? "right" : mod[2] === "D" ? "left" : mod[2] === "H" ? "home" : mod[2] === "F" ? "end" : "tab";
    const parts: string[] = [];
    if (mods & 4) parts.push("ctrl");
    if (mods & 2) parts.push("alt");
    if (mods & 1) parts.push("shift");
    parts.push(base);
    return parts.join("+") as KeyId;
  }

  if (key.length === 1) return { char: key };
  return { char: key };
}

/** True when the key unit matches the id (`{char}` matches exact text). */
export function matchesKey(key: string, id: KeyId): boolean {
  const parsed = parseKey(key);
  if (typeof id === "object") return typeof parsed === "object" && parsed.char === id.char;
  return parsed === id;
}
