/**
 * @kern/tui — theme.
 *
 * Semantic ANSI styles, dark-first truecolor palette. Respects NO_COLOR
 * (any non-empty value disables color, checked dynamically).
 */

const ESC = "\u001b[";
const RESET = `${ESC}0m`;

function noColor(): boolean {
  const v = process.env["NO_COLOR"];
  return v !== undefined && v !== "";
}

export interface Theme {
  user: (s: string) => string;
  assistant: (s: string) => string;
  tool: (s: string) => string;
  error: (s: string) => string;
  warn: (s: string) => string;
  muted: (s: string) => string;
  accent: (s: string) => string;
  success: (s: string) => string;
  bold: (s: string) => string;
  /** Informational blue (borders, hints). */
  info: (s: string) => string;
  /** Added diff line (green). */
  diffAdd: (s: string) => string;
  /** Removed diff line (red). */
  diffDel: (s: string) => string;
  /** Full-width inverse highlight bar (selection). */
  inverse: (s: string) => string;
}

function paint(code: string): (s: string) => string {
  return (s) => (noColor() ? s : `${ESC}${code}m${s}${RESET}`);
}

function identity(s: string): string {
  return s;
}

export const theme: Theme = {
  user: paint("1;38;2;125;211;252"), // bold sky
  assistant: identity, // default terminal fg
  tool: paint("38;2;234;179;8"), // amber
  error: paint("1;38;2;248;113;113"), // bold soft red
  warn: paint("38;2;251;191;36"), // amber-yellow
  muted: paint("2;38;2;148;163;184"), // dim slate
  accent: paint("1;38;2;167;139;250"), // bold violet
  success: paint("38;2;52;211;153"), // mint green
  bold: paint("1"),
  info: paint("38;2;56;189;248"), // sky blue
  diffAdd: paint("38;2;74;222;128"), // green
  diffDel: paint("38;2;248;113;113"), // red
  inverse: paint("7;1"), // inverse + bold
};

/** Wrap a full-width status-bar row in its background (skipped under NO_COLOR). */
export function statusBg(s: string): string {
  if (noColor()) return s;
  return `${ESC}48;2;30;41;59m${ESC}38;2;226;232;240m${s}${RESET}`;
}

/** Re-apply inverse after embedded resets so a highlight bar stays solid. */
export function keepInverse(inner: string): string {
  if (noColor()) return inner;
  return `${ESC}7m${inner.split(RESET).join(`${RESET}${ESC}7m`)}${RESET}`;
}

export const CLEAR_SCREEN = `${ESC}2J${ESC}H`;
