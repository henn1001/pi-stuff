import { describe, expect, test } from "bun:test";
import { parseSkillCommand } from "./command.js";

describe("parseSkillCommand", () => {
	test("parses browse and list", () => {
		expect(parseSkillCommand("  ")).toEqual({ action: "browse" });
		expect(parseSkillCommand("LIST")).toEqual({ action: "list" });
	});

	test("preserves paths containing spaces", () => {
		expect(parseSkillCommand("disable /tmp/my skill/SKILL.md")).toEqual({
			action: "disable",
			identifier: "/tmp/my skill/SKILL.md",
		});
	});

	test("rejects missing and extra arguments", () => {
		expect(() => parseSkillCommand("enable")).toThrow("<name-or-path>");
		expect(() => parseSkillCommand("list extra")).toThrow("Usage: /skill list");
		expect(() => parseSkillCommand("remove demo")).toThrow("Usage: /skill");
	});
});
