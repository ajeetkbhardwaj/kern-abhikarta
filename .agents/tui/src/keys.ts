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
  | "insert"
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

  // C0 controls. In raw mode Enter arrives as CR (\r) while Ctrl+J arrives
  // as LF (\n) — keep them distinct so the editor can submit on Enter and
  // insert a newline on Ctrl+J. (Pre-raw stacks that translate CR→LF will
  // see LF for Enter; matchesKey("enter") still matches "\n" for those.)
  if (key.length === 1 && code < 32) {
    if (key === "\r") return "enter";
    if (key === "\n") return "ctrl+j";
    if (key === "\t") return "tab";
    if (key === "\u001b") return "escape";
    if (key === "\u0008") return "backspace"; // Ctrl+H / legacy backspace
    return ctrlName(code) as KeyId;
  }
  if (key === "\u007f") return "backspace";

  // Alt+Enter.
  if (key === "\u001b\r" || key === "\u001b\n") return "alt+enter";
  // Alt+Backspace (ESC DEL / ESC Ctrl+H).
  if (key === "\u001b\u007f" || key === "\u001b\b") return "alt+backspace";

  // SS3 (application-cursor) sequences: ESC O <final>.
  if (key.startsWith("\u001bO") && key.length === 3) {
    switch (key[2]) {
      case "A":
        return "up";
      case "B":
        return "down";
      case "C":
        return "right";
      case "D":
        return "left";
      case "H":
        return "home";
      case "F":
        return "end";
      case "P":
      case "Q":
      case "R":
      case "S":
        return { char: key };
      default:
        break;
    }
  }
  // Alt+letter (ESC + char). Exclude CSI (ESC [) and SS3 (ESC O) prefixes.
  if (key.startsWith("\u001b") && !key.startsWith("\u001b[") && !key.startsWith("\u001bO")) {
    const rest = key.slice(1).toLowerCase();
    return `alt+${rest}` as KeyId;
  }

  // Kitty progressive: CSI number [; modifiers] u (modifiers optional).
  const kitty = key.match(/^\u001b\[(\d+)(?:;(\d+))?u$/);
  if (kitty) {
    const num = Number(kitty[1]);
    const mods = (kitty[2] === undefined ? 1 : Number(kitty[2])) - 1;
    const base =
      num === 13
        ? "enter"
        : num === 9
          ? "tab"
          : num === 27
            ? "escape"
            : num === 32
              ? "space"
              : num === 127
                ? "backspace"
                : String.fromCharCode(num).toLowerCase();
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
    case "\u001b[7~":
      return "home";
    case "\u001b[F":
    case "\u001b[4~":
    case "\u001b[8~":
      return "end";
    case "\u001b[3~":
      return "delete";
    case "\u001b[2~":
      return "insert";
    case "\u001b[5~":
      return "pageup";
    case "\u001b[6~":
      return "pagedown";
    case "\u001b[Z":
      return "shift+tab";
  }
  // CSI with modifiers: ESC [ 1 ; mod + (A-D, H, F, P, Q, R, S, Z).
  const mod = key.match(/^\u001b\[1;(\d+)([A-DHFPQRSZ])$/);
  if (mod) {
    const mods = Number(mod[1]) - 1;
    const base =
      mod[2] === "A"
        ? "up"
        : mod[2] === "B"
          ? "down"
          : mod[2] === "C"
            ? "right"
            : mod[2] === "D"
              ? "left"
              : mod[2] === "H"
                ? "home"
                : mod[2] === "F"
                  ? "end"
                  : "tab";
    const parts: string[] = [];
    if (mods & 4) parts.push("ctrl");
    if (mods & 2) parts.push("alt");
    if (mods & 1) parts.push("shift");
    parts.push(base);
    return parts.join("+") as KeyId;
  }
  // CSI num [; mod] ~ (delete/insert/home/end/pageup/pagedown + F5-F12).
  const tilde = key.match(/^\u001b\[(\d+)(?:;(\d+))?~$/);
  if (tilde) {
    const num = Number(tilde[1]);
    const mods = (tilde[2] === undefined ? 1 : Number(tilde[2])) - 1;
    let base: string | null = null;
    switch (num) {
      case 1:
      case 7:
        base = "home";
        break;
      case 2:
        base = "insert";
        break;
      case 3:
        base = "delete";
        break;
      case 4:
      case 8:
        base = "end";
        break;
      case 5:
        base = "pageup";
        break;
      case 6:
        base = "pagedown";
        break;
      default:
        base = null; // F5-F12 and friends: no stable id yet
        break;
    }
    if (base !== null) {
      if (mods === 0) return base as KeyId;
      const parts: string[] = [];
      if (mods & 4) parts.push("ctrl");
      if (mods & 2) parts.push("alt");
      if (mods & 1) parts.push("shift");
      parts.push(base);
      return parts.join("+") as KeyId;
    }
  }

  if (key.length === 1) return { char: key };
  return { char: key };
}

/** True when the key unit matches the id (`{char}` matches exact text). */
export function matchesKey(key: string, id: KeyId): boolean {
  // Compatibility: bare LF historically meant Enter (stacks that translate
  // CR→LF). parseKey now reports LF as ctrl+j so the editor can bind it to
  // newline; still report it as Enter for callers that only know Enter
  // (e.g. selection lists where LF should confirm).
  if (id === "enter" && key === "\n") return true;
  if (id === "space" && key === " ") return true;
  if (id === "ctrl+h" && key === "\b") return true;
  const parsed = parseKey(key);
  if (typeof id === "object") return typeof parsed === "object" && parsed.char === id.char;
  return parsed === id;
}

/**
 * Human-readable label for a key unit, for future help screens.
 * Examples: "Enter", "Esc", "Ctrl+C", "Alt+F", "Shift+Tab", "Left".
 */
export function describeKey(key: string): string {
  if (key === "\n") return "Ctrl+J";
  const parsed = parseKey(key);
  if (typeof parsed === "object") {
    const c = parsed.char;
    if (c === " ") return "Space";
    if (c.length === 1) return c;
    if (c.length === 0) return "";
    // Multi-char unrecognized sequence (e.g. paste block, F-keys).
    if (c.startsWith("\u001b[200~")) return "Paste";
    return "Key";
  }
  const parts = parsed.split("+");
  const word = (p: string): string => {
    switch (p) {
      case "ctrl":
        return "Ctrl";
      case "alt":
        return "Alt";
      case "shift":
        return "Shift";
      case "enter":
        return "Enter";
      case "escape":
        return "Esc";
      case "tab":
        return "Tab";
      case "space":
        return "Space";
      case "backspace":
        return "Backspace";
      case "delete":
        return "Delete";
      case "insert":
        return "Insert";
      case "home":
        return "Home";
      case "end":
        return "End";
      case "pageup":
        return "PageUp";
      case "pagedown":
        return "PageDown";
      case "up":
        return "Up";
      case "down":
        return "Down";
      case "left":
        return "Left";
      case "right":
        return "Right";
      default:
        return p.length === 1 ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1);
    }
  };
  return parts.map(word).join("+");
}
