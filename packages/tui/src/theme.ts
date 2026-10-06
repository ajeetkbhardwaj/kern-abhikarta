/**
 * @kern/tui — theme.
 *
 * Semantic ANSI styles. Respects NO_COLOR. Truecolor assumed; terminals
 * that cannot handle it degrade via their own emulation.
 */

const ESC = "\u001b[";
const RESET = `${ESC}0m`;

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
}

function paint(code: string): (s: string) => string {
  if (process.env["NO_COLOR"] !== undefined && process.env["NO_COLOR"] !== "") {
    return (s) => s;
  }
  return (s) => `${ESC}${code}m${s}${RESET}`;
}

export const theme: Theme = {
  user: paint("36;1"), // bright cyan
  assistant: paint("0"), // default (wraps with reset; harmless)
  tool: paint("33"), // yellow
  error: paint("31;1"), // bright red
  warn: paint("33;1"), // bright yellow
  muted: paint("2"), // dim
  accent: paint("35;1"), // bright magenta
  success: paint("32"), // green
  bold: paint("1"),
};

export const CLEAR_SCREEN = `${ESC}2J${ESC}H`;
