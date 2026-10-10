import {
	parseColor,
	styleText,
	truncateToWidth,
	visibleWidth,
	type Component,
} from "@earendil-works/pi-tui";
import { theme } from "./theme.js";

export { Container, Spacer, Text } from "@earendil-works/pi-tui";

const noColor = (process.env.NO_COLOR ?? "") !== "";

function borderSty(okhsl: string): (s: string) => string {
	if (noColor) return (s) => s;
	const c = parseColor(okhsl);
	return (s) => styleText(s, { fg: c }, "truecolor");
}

const borderMuted = borderSty("okhsl(229 8% 53%)");
const borderDefault = borderSty("okhsl(231 57% 65%)");
const borderAccent = borderSty("okhsl(295 53% 64%)");
const borderError = borderSty("okhsl(20 72% 67%)");
const borderSuccess = borderSty("okhsl(159 59% 67%)");

type BoxMood = "default" | "info" | "accent" | "error" | "success";

function moodBorder(mood: BoxMood): (s: string) => string {
	if (mood === "accent") return borderAccent;
	if (mood === "error") return borderError;
	if (mood === "success") return borderSuccess;
	if (mood === "info") return borderDefault;
	return borderMuted;
}

export class Box implements Component {
	private child: Component;
	private title: string | undefined;
	private paddingX: number;
	private mood: BoxMood;

	constructor(child: Component, opts?: { title?: string; paddingX?: number; mood?: BoxMood }) {
		this.child = child;
		this.title = opts?.title;
		this.paddingX = Math.max(0, opts?.paddingX ?? 1);
		this.mood = opts?.mood ?? "default";
	}

	invalidate(): void {}

	render(width: number): string[] {
		const w = Math.max(6, width);
		const border = moodBorder(this.mood);
		const inner = w - 2;
		const contentW = Math.max(1, inner - this.paddingX * 2);
		const pad = " ".repeat(Math.min(this.paddingX, Math.max(0, Math.floor(inner / 2))));
		let top = "╭─";
		if (this.title !== undefined && this.title !== "") {
			const t = truncateToWidth(this.title, Math.max(1, w - 6), "");
			top += ` ${t} `;
		}
		top += "─".repeat(Math.max(0, w - visibleWidth(top) - 1)) + "╮";
		const rows = [border(truncateToWidth(top, w, ""))];
		for (const line of this.child.render(contentW)) {
			const t = truncateToWidth(line, contentW, "");
			const fill = " ".repeat(Math.max(0, contentW - visibleWidth(t)));
			rows.push(border("│") + pad + t + fill + pad + border("│"));
		}
		rows.push(border("╰" + "─".repeat(Math.max(1, w - 2)) + "╯"));
		return rows;
	}
}

export class StatusBar implements Component {
	private segments: string[] = [];

	setSegments(segments: string[]): void {
		this.segments = segments;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const w = Math.max(0, width);
		if (this.segments.length === 0) return [""];
		const joined = this.segments.join(theme.muted(" │ "));
		const padded = ` ${joined} `;
		return [truncateToWidth(theme.muted("▏") + padded, w, "")];
	}
}

export class ToolCard implements Component {
	private outputs: string[] = [];
	private done = false;
	private failed = false;
	private readonly maxLines: number;
	private readonly toolName: string;
	private readonly argsSummary: string;

	constructor(toolName: string, argsSummary: string, opts?: { maxLines?: number }) {
		this.toolName = toolName;
		this.argsSummary = argsSummary;
		this.maxLines = Math.max(0, opts?.maxLines ?? 10);
	}

	appendOutput(text: string): void {
		for (const line of text.split("\n")) this.outputs.push(line.trimEnd());
	}

	finish(failed = false): void {
		this.done = true;
		this.failed = failed;
	}

	isFailed(): boolean {
		return this.failed;
	}

	isDone(): boolean {
		return this.done;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const w = Math.max(1, width);
		const summary = this.argsSummary === "" ? this.toolName : `${this.toolName} ${this.argsSummary}`;
		let header: string;
		if (!this.done) header = `${theme.accent("◈")} ${theme.muted(summary)}`;
		else if (this.failed) header = theme.error(`✖ ${summary}`);
		else header = `${theme.success("✔")} ${theme.bold(summary)}`;
		const rows = [truncateToWidth(header, w, "")];
		const visible = this.outputs.slice(Math.max(0, this.outputs.length - this.maxLines));
		for (const line of visible) {
			const compact = line.trim();
			if (!compact) continue;
			rows.push(truncateToWidth(theme.tool(`  ▸ ${compact}`), w, ""));
		}
		if (this.failed && this.outputs.length === 0) {
			rows.push(truncateToWidth(theme.error("  ▸ failed with no output"), w, ""));
		}
		return rows;
	}
}

export class Rule implements Component {
	private readonly char: string;

	constructor(char = "─") {
		this.char = char === "" ? "─" : char;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const w = Math.max(1, width);
		let s = "";
		let guard = 0;
		while (visibleWidth(s) < w && guard < w + 4) {
			s += this.char;
			guard += 1;
		}
		return [theme.muted(truncateToWidth(s, w, ""))];
	}
}
