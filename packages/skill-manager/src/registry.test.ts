import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { resolveSkillIdentifier, type SkillEntry, type SkillRegistry } from "./registry.js";

function skill(name: string, path: string): SkillEntry {
  return {
    name,
    path: resolve(path),
    description: "demo",
    scope: "user",
    origin: "top-level",
    source: "test",
    content: "",
    frontmatterText: "---",
    disableModelInvocation: false,
  };
}

function registry(skills: SkillEntry[]): SkillRegistry {
  const byName = new Map<string, SkillEntry[]>();
  for (const item of skills) {
    byName.set(item.name, [...(byName.get(item.name) ?? []), item]);
  }
  return {
    skills,
    byPath: new Map(skills.map((item) => [item.path, item])),
    byName,
  };
}

describe("resolveSkillIdentifier", () => {
  test("resolves a unique name", () => {
    const item = skill("demo", "/tmp/a/SKILL.md");
    expect(resolveSkillIdentifier(registry([item]), "demo", "/tmp")).toBe(item);
  });

  test("duplicate names fail deterministically with paths", () => {
    const a = skill("demo", "/tmp/a/SKILL.md");
    const b = skill("demo", "/tmp/b/SKILL.md");
    expect(() => resolveSkillIdentifier(registry([a, b]), "demo", "/tmp")).toThrow(
      `${a.path}\n- ${b.path}`,
    );
  });

  test("an exact path disambiguates duplicate names", () => {
    const a = skill("demo", "/tmp/a/SKILL.md");
    const b = skill("demo", "/tmp/b/SKILL.md");
    expect(resolveSkillIdentifier(registry([a, b]), b.path, "/tmp")).toBe(b);
  });
});