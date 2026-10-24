import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	type Focusable,
	HStack,
	Input,
	Key,
	Markdown,
	matchesKey,
	Spacer,
	Text,
	truncateToWidth,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { SkillEntry, SkillRegistry } from "./registry.js";

export interface BrowseWindow {
	startIndex: number;
	endIndex: number;
	rows: number;
}

/** Pane widths include borders; pane rows exclude the screen header and two footer lines. */
export interface BrowserLayout {
	height: number;
	split: boolean;
	listWidth: number;
	detailWidth: number;
	paneRows: number;
	detailRows: number;
}

export function browserLayout(
	width: number,
	terminalRows: number,
): BrowserLayout {
	const columns = Math.max(1, Math.floor(width));
	const height = Math.max(
		1,
		Math.floor(Number.isFinite(terminalRows) ? terminalRows : 24),
	);
	const split = columns >= 100;
	const listWidth = split ? Math.floor(columns * 0.25) : columns;
	const paneRows = Math.max(2, height - 3);
	return {
		height,
		split,
		listWidth,
		detailWidth: split ? columns - listWidth : columns,
		paneRows,
		detailRows: Math.max(1, paneRows - 2),
	};
}

export function visibleListRows(terminalRows: number): number {
	const height = Math.floor(Number.isFinite(terminalRows) ? terminalRows : 24);
	return Math.max(1, height - 7);
}

export function browseWindow(
	count: number,
	selected: number,
	rows: number,
): BrowseWindow {
	const safeCount = Math.max(0, Math.floor(count));
	const safeRows = Math.max(1, Math.floor(rows));
	if (!safeCount) return { startIndex: 0, endIndex: 0, rows: safeRows };
	const safeSelected = Math.max(
		0,
		Math.min(safeCount - 1, Math.floor(selected)),
	);
	const startIndex = Math.max(
		0,
		Math.min(safeCount - safeRows, safeSelected - Math.floor(safeRows / 2)),
	);
	return {
		startIndex,
		endIndex: Math.min(safeCount, startIndex + safeRows),
		rows: safeRows,
	};
}

interface DialogOptions {
	onToggle(skill: SkillEntry, enabled: boolean): Promise<void>;
	onRefresh(): Promise<SkillRegistry>;
}

function clipLine(text: string, width: number): string {
	return truncateToWidth(text.replace(/[\r\n]+/g, " "), width, "…");
}

function pad(text: string, width: number): string {
	const clipped = clipLine(text, width);
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function frame(
	theme: Theme,
	width: number,
	lines: string[],
	title: string,
	focused: boolean,
	right = "",
): string[] {
	if (width < 8)
		return [
			pad(title, width),
			...lines.map((line) => pad(line, width)),
			" ".repeat(width),
		];
	const border = focused ? "borderAccent" : "borderMuted";
	const inner = width - 4;
	const available = inner + 2;
	const tailCandidate = right ? ` ${right} ` : "";
	const tail =
		visibleWidth(tailCandidate) <= Math.floor(available / 2)
			? tailCandidate
			: "";
	const heading = truncateToWidth(
		` ${title} `,
		Math.max(1, available - visibleWidth(tail)),
		"…",
	);
	const fill = Math.max(
		0,
		available - visibleWidth(heading) - visibleWidth(tail),
	);
	return [
		`${theme.fg(border, "┏")}${theme.fg(focused ? "accent" : "muted", theme.bold(heading))}${theme.fg(border, "━".repeat(fill))}${theme.fg("dim", tail)}${theme.fg(border, "┓")}`,
		...lines.map(
			(line) =>
				`${theme.fg(border, "┃ ")}${pad(line, inner)}${theme.fg(border, " ┃")}`,
		),
		theme.fg(border, `┗${"━".repeat(inner + 2)}┛`),
	];
}

function scopeLabel(skill: SkillEntry): string {
	return skill.scope === "user" ? "global" : skill.scope;
}

class SkillDialog implements Focusable {
	private _focused = false;
	private registry: SkillRegistry;
	private filtered: SkillEntry[] = [];
	private selected = 0;
	private query = "";
	private readonly input = new Input();
	private detailFocused = false;
	private detailPath?: string;
	private scroll = 0;
	private previewLines: string[] = [];
	private previewEntry?: SkillEntry;
	private previewWidth = 0;

	constructor(
		private readonly ctx: ExtensionContext,
		registry: SkillRegistry,
		private readonly theme: Theme,
		private readonly tui: TUI,
		private readonly done: (skill: SkillEntry | null) => void,
		private readonly options: DialogOptions,
	) {
		this.registry = registry;
		this.filter();
	}

	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value && !this.detailFocused;
	}
	invalidate(): void {
		this.input.invalidate();
		this.previewEntry = undefined;
		this.previewWidth = 0;
	}

	private filter(preferredPath?: string): void {
		const tokens = this.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
		this.filtered = this.registry.skills.filter((skill) => {
			const text = [
				skill.name,
				skill.description,
				skill.path,
				skill.source,
				skill.scope,
				skill.origin,
			]
				.join(" ")
				.toLowerCase();
			return tokens.every((token) => text.includes(token));
		});
		if (preferredPath) {
			const index = this.filtered.findIndex(
				(skill) => skill.path === preferredPath,
			);
			if (index >= 0) this.selected = index;
		}
		this.selected = Math.max(
			0,
			Math.min(this.selected, Math.max(0, this.filtered.length - 1)),
		);
	}

	private selectedSkill(): SkillEntry | undefined {
		return this.filtered[this.selected];
	}

	private async toggle(skill: SkillEntry): Promise<void> {
		const enable = skill.disableModelInvocation;
		try {
			await this.options.onToggle(skill, enable);
			this.registry = await this.options.onRefresh();
			this.filter(skill.path);
			this.previewEntry = undefined;
			this.ctx.ui.notify(
				`${enable ? "Enabled" : "Disabled"} model invocation for ${skill.name}. Run /reload to apply it to the current session.`,
				"info",
			);
		} catch (error) {
			this.ctx.ui.notify(
				error instanceof Error ? error.message : String(error),
				"error",
			);
		}
		this.tui.requestRender();
	}

	private renderBrowse(width: number, paneRows: number): string[] {
		const inner = Math.max(1, width - 4);
		const body = this.detailFocused
			? [
					clipLine(
						this.theme.fg("dim", `Search: ${this.query || "(all skills)"}`),
						inner,
					),
					"",
				]
			: [...this.input.render(inner), ""];
		const rows = visibleListRows(this.tui.terminal.rows);
		const window = browseWindow(this.filtered.length, this.selected, rows);
		if (!this.filtered.length)
			body.push(this.theme.fg("dim", "No matching skills."));
		for (let index = window.startIndex; index < window.endIndex; index++) {
			const skill = this.filtered[index]!;
			const selected = index === this.selected;
			const state = skill.disableModelInvocation
				? this.theme.fg("warning", "M")
				: this.theme.fg("success", "V");
			const line = `${selected ? "›" : " "} ${state} ${this.theme.fg("dim", `[${scopeLabel(skill)}]`)} ${selected ? this.theme.bold(skill.name) : skill.name}`;
			body.push(
				selected
					? this.theme.bg("selectedBg", pad(line, inner))
					: clipLine(line, inner),
			);
		}
		const bodyRows = Math.max(0, paneRows - 2);
		while (body.length < bodyRows) body.push("");
		return frame(
			this.theme,
			width,
			body.slice(0, bodyRows),
			"Skills",
			!this.detailFocused,
		);
	}

	private buildPreviewLines(skill: SkillEntry, inner: number): string[] {
		const root = new Container();
		root.addChild(
			new Text(this.theme.fg("text", this.theme.bold(skill.name)), 0, 0),
		);
		root.addChild(
			new Text(
				this.theme.fg(
					"muted",
					`${scopeLabel(skill)} · ${skill.source} · ${skill.disableModelInvocation ? "manual-only" : "model-visible"}`,
				),
				0,
				0,
			),
		);
		root.addChild(new Text(this.theme.fg("dim", skill.path), 0, 0));
		root.addChild(new Spacer(1));
		root.addChild(new Text(skill.description, 0, 0));
		root.addChild(new Spacer(1));
		root.addChild(
			new Text(this.theme.fg("muted", this.theme.bold("Frontmatter")), 0, 0),
		);
		root.addChild(new Text(this.theme.fg("dim", skill.frontmatterText), 0, 0));
		root.addChild(new Spacer(1));
		root.addChild(
			new Text(this.theme.fg("muted", this.theme.bold("Content")), 0, 0),
		);
		root.addChild(
			new Markdown(
				skill.content || "(empty skill body)",
				0,
				0,
				getMarkdownTheme(),
			),
		);
		return root.render(inner);
	}

	private renderPreview(width: number, paneRows: number): string[] {
		const skill = this.selectedSkill();
		const inner = Math.max(1, width - 4);
		if (skill !== this.previewEntry || inner !== this.previewWidth) {
			this.previewLines = skill
				? this.buildPreviewLines(skill, inner)
				: [this.theme.fg("dim", "Select a skill to view its content.")];
			this.previewEntry = skill;
			this.previewWidth = inner;
		}
		const visibleRows = Math.max(0, paneRows - 2);
		const max = Math.max(0, this.previewLines.length - visibleRows);
		this.scroll = Math.max(0, Math.min(this.scroll, max));
		const body = this.previewLines.slice(
			this.scroll,
			this.scroll + visibleRows,
		);
		while (body.length < visibleRows) body.push("");
		const position = skill
			? `${this.scroll + 1}–${Math.min(this.previewLines.length, this.scroll + visibleRows)}/${this.previewLines.length}`
			: "";
		return frame(
			this.theme,
			width,
			body,
			"Detail",
			this.detailFocused,
			position,
		);
	}

	render(width: number): string[] {
		const layout = browserLayout(width, this.tui.terminal.rows);
		const skill = this.selectedSkill();
		if (skill?.path !== this.detailPath) {
			this.detailPath = skill?.path;
			this.scroll = 0;
		}
		let panes: string[];
		if (layout.split) {
			const list = this.renderBrowse(layout.listWidth, layout.paneRows);
			const detail = this.renderPreview(layout.detailWidth, layout.paneRows);
			panes = new HStack([
				{
					component: { render: () => list, invalidate() {} },
					basis: layout.listWidth,
					shrink: 0,
				},
				{
					component: { render: () => detail, invalidate() {} },
					basis: layout.detailWidth,
					shrink: 0,
				},
			]).render(width);
		} else {
			panes = this.detailFocused
				? this.renderPreview(layout.detailWidth, layout.paneRows)
				: this.renderBrowse(layout.listWidth, layout.paneRows);
		}
		const visible = this.registry.skills.filter(
			(entry) => !entry.disableModelInvocation,
		).length;
		const header = `${this.theme.fg("accent", this.theme.bold("Skill Invocation"))}  ${this.theme.fg("muted", `${this.filtered.length}/${this.registry.skills.length} skills · ${visible} model-visible`)}`;
		const navigation = this.detailFocused
			? "↑/↓ scroll"
			: "type search · ↑/↓ select";
		return [
			pad(header, width),
			...panes.map((line) => pad(line, width)),
			pad(
				this.theme.fg(
					"dim",
					`tab ${this.detailFocused ? "list" : "detail"} · ${navigation} · PgUp/PgDn or -/= page${this.detailFocused ? " · Home/End · wheel scroll" : ""}`,
				),
				width,
			),
			pad(
				this.theme.fg(
					"dim",
					"ctrl+x toggle · enter insert · esc " +
						(this.detailFocused
							? "back"
							: this.query
								? "clear search"
								: "close") +
						" · V visible / M manual-only",
				),
				width,
			),
		].slice(0, layout.height);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "wheel") return;
		const layout = browserLayout(event.width, this.tui.terminal.rows);
		const overDetail = layout.split
			? event.x >= layout.listWidth
			: this.detailFocused;
		if (event.y > 0 && event.y < layout.paneRows + 1) {
			if (overDetail) {
				const max = Math.max(0, this.previewLines.length - layout.detailRows);
				this.scroll = Math.max(
					0,
					Math.min(max, this.scroll + (event.wheelDelta ?? 0)),
				);
			} else {
				this.selected = Math.max(
					0,
					Math.min(
						Math.max(0, this.filtered.length - 1),
						this.selected + (event.wheelDelta ?? 0),
					),
				);
			}
		}
		return { handled: true };
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.tab)) {
			this.detailFocused = !this.detailFocused;
			this.input.focused = this.focused && !this.detailFocused;
			return;
		}
		if (matchesKey(data, Key.escape)) {
			if (this.detailFocused) {
				this.detailFocused = false;
				this.input.focused = this.focused;
			} else if (this.query) {
				this.query = "";
				this.input.setValue("");
				this.filter();
			} else this.done(null);
			return;
		}
		const skill = this.selectedSkill();
		if (matchesKey(data, Key.enter)) {
			if (skill) this.done(skill);
			return;
		}
		if (matchesKey(data, Key.ctrl("x")) || matchesKey(data, Key.alt("x"))) {
			if (skill) void this.toggle(skill);
			return;
		}
		if (this.detailFocused) {
			const page = browserLayout(
				this.tui.terminal.columns,
				this.tui.terminal.rows,
			).detailRows;
			const max = Math.max(0, this.previewLines.length - page);
			if (matchesKey(data, Key.up)) this.scroll = Math.max(0, this.scroll - 1);
			else if (matchesKey(data, Key.down))
				this.scroll = Math.min(max, this.scroll + 1);
			else if (matchesKey(data, "-") || matchesKey(data, Key.pageUp))
				this.scroll = Math.max(0, this.scroll - page);
			else if (matchesKey(data, "=") || matchesKey(data, Key.pageDown))
				this.scroll = Math.min(max, this.scroll + page);
			else if (matchesKey(data, Key.home)) this.scroll = 0;
			else if (matchesKey(data, Key.end)) this.scroll = max;
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.selected =
				this.selected <= 0
					? Math.max(0, this.filtered.length - 1)
					: this.selected - 1;
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.selected =
				this.selected >= this.filtered.length - 1 ? 0 : this.selected + 1;
			return;
		}
		const page = visibleListRows(this.tui.terminal.rows);
		if (matchesKey(data, "-") || matchesKey(data, Key.pageUp)) {
			this.selected = Math.max(0, this.selected - page);
			return;
		}
		if (matchesKey(data, "=") || matchesKey(data, Key.pageDown)) {
			this.selected = Math.min(
				Math.max(0, this.filtered.length - 1),
				this.selected + page,
			);
			return;
		}
		this.input.handleInput(data);
		this.query = this.input.getValue();
		this.filter();
	}
}

export async function showSkillDialog(
	ctx: ExtensionContext,
	registry: SkillRegistry,
	options: DialogOptions,
): Promise<SkillEntry | null> {
	return await ctx.ui.custom<SkillEntry | null>(
		(tui, theme, _kb, done) => {
			const dialog = new SkillDialog(ctx, registry, theme, tui, done, options);
			return {
				get focused() {
					return dialog.focused;
				},
				set focused(value: boolean) {
					dialog.focused = value;
				},
				render: (width: number) => dialog.render(width),
				invalidate: () => dialog.invalidate(),
				handleInput: (data: string) => {
					dialog.handleInput(data);
					tui.requestRender();
				},
				handleMouse: (event: TuiMouseEvent) => dialog.handleMouse(event),
			};
		},
		{
			// Non-overlay custom UI occupies only the editor area, leaving session chrome visible.
			overlay: true,
			overlayOptions: {
				anchor: "top-left",
				width: "100%",
				maxHeight: "100%",
				margin: 0,
			},
		},
	);
}
