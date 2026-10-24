import { expect, test } from "bun:test";
import { browserLayout, browseWindow, visibleListRows } from "./dialog.js";

test("full-screen list uses the available terminal height", () => {
	expect(visibleListRows(8)).toBe(1);
	expect(visibleListRows(24)).toBe(17);
	expect(visibleListRows(40)).toBe(33);
	expect(visibleListRows(2)).toBe(1);
	expect(visibleListRows(Number.NaN)).toBe(17);
});

test("wide terminals use quarter-width list and remaining detail pane", () => {
	expect(browserLayout(120, 24)).toEqual({
		height: 24,
		split: true,
		listWidth: 30,
		detailWidth: 90,
		paneRows: 21,
		detailRows: 19,
	});
	const odd = browserLayout(101, 40);
	expect(odd.listWidth).toBe(25);
	expect(odd.detailWidth).toBe(76);
	expect(odd.listWidth + odd.detailWidth).toBe(101);
	expect(odd.paneRows + 3).toBe(40);
	expect(odd.detailRows + 2).toBe(odd.paneRows);
	expect(visibleListRows(40) + 4).toBe(odd.paneRows);
});

test("narrow terminals give the focused pane the full width", () => {
	expect(browserLayout(99, 24)).toEqual({
		height: 24,
		split: false,
		listWidth: 99,
		detailWidth: 99,
		paneRows: 21,
		detailRows: 19,
	});
	expect(browserLayout(100, 24).split).toBe(true);
	expect(browserLayout(40, 8).detailRows).toBe(3);
	expect(browserLayout(40, 2).detailRows).toBe(1);
	expect(browserLayout(40, Number.NaN).height).toBe(24);
});

test("list window keeps selection visible at either end and in the middle", () => {
	expect(browseWindow(30, 29, 5)).toEqual({
		startIndex: 25,
		endIndex: 30,
		rows: 5,
	});
	expect(browseWindow(30, 0, 5)).toEqual({
		startIndex: 0,
		endIndex: 5,
		rows: 5,
	});
	expect(browseWindow(30, 15, 5)).toEqual({
		startIndex: 13,
		endIndex: 18,
		rows: 5,
	});
	expect(browseWindow(3, 2, 17)).toEqual({
		startIndex: 0,
		endIndex: 3,
		rows: 17,
	});
	expect(browseWindow(0, 0, 17)).toEqual({
		startIndex: 0,
		endIndex: 0,
		rows: 17,
	});
});
