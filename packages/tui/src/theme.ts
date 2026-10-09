import {
	parseColor,
	styleText,
	type Color,
	type EditorTheme as PiEditorTheme,
	type MarkdownTheme as PiMarkdownTheme,
	type SelectListTheme as PiSelectListTheme,
} from "@earendil-works/pi-tui";

// Pi dark palette (dark.json). Built once at module load.
const noColor = (process.env.NO_COLOR ?? "") !== "";

function sty(color: Color, extra?: { bold?: boolean; italic?: boolean; inverse?: boolean }): (s: string) => string {
	if (noColor) return (s) => s;
	return (s) => styleText(s, { fg: color, ...extra }, "truecolor");
}

const text = parseColor("okhsl(234 3% 89%)");
const mutedC = parseColor("okhsl(229 6% 67%)");
const violet = parseColor("okhsl(295 50% 67%)");
const blue = parseColor("okhsl(232 54% 67%)");
const green = parseColor("okhsl(159 59% 67%)");
const red = parseColor("okhsl(20 72% 67%)");
const yellow = parseColor("okhsl(83 88% 67%)");
const warmString = parseColor("okhsl(52 67% 67%)");
const borderC = parseColor("okhsl(231 57% 65%)");
const blueBg = parseColor("okhsl(233 41% 24%)");

export const theme = {
	user: sty(blue),
	assistant: sty(text),
	tool: sty(mutedC),
	error: sty(red),
	warn: sty(yellow),
	muted: sty(mutedC),
	accent: sty(violet),
	success: sty(green),
	bold: sty(text, { bold: true }),
	info: sty(blue),
	diffAdd: sty(green),
	diffDel: sty(red),
	inverse: sty(text, { inverse: true }),
};

export function statusBg(s: string): string {
	if (noColor) return s;
	return styleText(s, { fg: text, bg: blueBg }, "truecolor");
}

const KEYWORDS = new Set([
	"const", "let", "var", "function", "return", "if", "else", "for", "while",
	"do", "switch", "case", "break", "continue", "default", "class", "extends",
	"import", "export", "from", "await", "async", "new", "try", "catch",
	"finally", "throw", "typeof", "instanceof", "in", "of", "void", "delete",
	"null", "undefined", "true", "false", "this", "super", "static", "get",
	"set", "public", "private", "protected", "readonly", "interface", "type",
	"enum", "implements", "def", "lambda", "pass", "raise", "with", "as",
	"is", "not", "and", "or", "elif", "while", "for",
]);

const TOKEN_RE =
	/(\/\/[^\n]*|#[^\n]*)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|\b(\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)\b|([A-Za-z_$][\w$]*)/g;

const commentFn = sty(mutedC);
const keywordFn = sty(blue);
const fnFn = sty(yellow);
const stringFn = sty(warmString);
const numberFn = sty(green);
const typeFn = sty(violet);
const baseFn = sty(green);
const gapFn = sty(mutedC);

function styleGap(gap: string): string {
	if (gap === "" || /^\s+$/.test(gap)) return gap;
	return gapFn(gap);
}

function highlightLine(line: string): string {
	const trimmed = line.trimStart();
	if (trimmed.startsWith("+") && !trimmed.startsWith("+++")) return theme.diffAdd(line);
	if (trimmed.startsWith("-") && !trimmed.startsWith("---")) return theme.diffDel(line);
	TOKEN_RE.lastIndex = 0;
	let out = "";
	let cursor = 0;
	for (;;) {
		const m = TOKEN_RE.exec(line);
		if (m === null || m[0] === "") break;
		const start = m.index;
		if (start > cursor) out += styleGap(line.slice(cursor, start));
		const comment = m[1];
		const str = m[2];
		const num = m[3];
		const word = m[4];
		if (comment !== undefined) out += commentFn(comment);
		else if (str !== undefined) out += stringFn(str);
		else if (num !== undefined) out += numberFn(num);
		else if (word !== undefined) {
			const after = line.slice(TOKEN_RE.lastIndex);
			if (KEYWORDS.has(word)) out += keywordFn(word);
			else if (/^\s*\(/.test(after)) out += fnFn(word);
			else if (/^[A-Z]/.test(word)) out += typeFn(word);
			else out += baseFn(word);
		}
		cursor = TOKEN_RE.lastIndex;
	}
	if (cursor < line.length) out += styleGap(line.slice(cursor));
	return out;
}

export function highlightCode(code: string, lang?: string): string[] {
	void lang;
	return code.split("\n").map(highlightLine);
}

export function buildMarkdownTheme(): PiMarkdownTheme {
	return {
		heading: sty(yellow),
		link: sty(blue),
		linkUrl: sty(mutedC),
		code: sty(violet),
		codeBlock: sty(green),
		codeBlockBorder: sty(mutedC),
		quote: sty(mutedC),
		quoteBorder: sty(mutedC),
		hr: sty(mutedC),
		listBullet: sty(violet),
		bold: sty(text, { bold: true }),
		italic: sty(text, { italic: true }),
		strikethrough: sty(text),
		underline: sty(text),
		highlightCode,
		codeBlockIndent: "  ",
	};
}

export function buildSelectTheme(): PiSelectListTheme {
	return {
		selectedPrefix: sty(violet, { bold: true }),
		selectedText: statusBg,
		description: sty(mutedC),
		scrollInfo: sty(mutedC),
		noMatch: sty(yellow),
	};
}

export function buildEditorTheme(): PiEditorTheme {
	return {
		borderColor: noColor ? (s: string) => s : (s: string) => styleText(s, { fg: borderC }, "truecolor"),
		selectList: buildSelectTheme(),
	};
}
