import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, mock, test } from "bun:test";

const installRoot = resolve(
  process.env.PI_MANAGED_INSTALL_ROOT ?? join(homedir(), ".pi", "agent", "install"),
);
const version = (await Bun.file(join(installRoot, "current-version")).text()).trim();
if (!version) {
  throw new Error(`No current Pi version found under ${installRoot}`);
}

const packageDir = join(
  installRoot,
  "releases",
  version,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
);
const packageJson = await Bun.file(join(packageDir, "package.json")).json();
if (packageJson.version !== version) {
  throw new Error(
    `Pi install version mismatch: current-version says ${version}, package is ${packageJson.version}`,
  );
}
const piConfig = await import(
  pathToFileURL(join(packageDir, "dist", "config.js")).href
);

// This extension is loaded by Pi, but its standalone test has no local Pi dependency.
mock.module("@earendil-works/pi-ai", () => ({
  getSupportedThinkingLevels: () => [],
  getSystemMessageText: () => "",
}));
mock.module("@earendil-works/pi-coding-agent", () => ({
  CONFIG_DIR_NAME: piConfig.CONFIG_DIR_NAME,
  getAgentDir: piConfig.getAgentDir,
  getDocsPath: piConfig.getDocsPath,
  getExamplesPath: piConfig.getExamplesPath,
  getReadmePath: piConfig.getReadmePath,
  parseFrontmatter: () => ({ frontmatter: {}, body: "" }),
}));

// Use Pi's internal builder: it is the source of truth but is not publicly exported.
const upstream = await import(
  pathToFileURL(join(packageDir, "dist", "core", "system-prompt.js")).href
);
const { applyProfile } = await import("./runtime.ts");

type PromptInput = {
  cwd?: string;
  selectedTools?: string[];
  hiddenTools?: string[];
  toolSnippets?: Record<string, string>;
  toolGuidelines?: Record<string, string[]>;
  promptGuidelines?: string[];
};

function makeOptions(input: PromptInput = {}) {
  return {
    customPrompt: undefined,
    forceSystemPrompt: undefined,
    selectedTools: ["read", "bash", "edit", "write"],
    hiddenTools: [],
    toolSnippets: {},
    toolGuidelines: {},
    promptGuidelines: [],
    appendSystemPrompt: "",
    sections: {} as Record<string, string>,
    cwd: "/project",
    contextFiles: [],
    skills: [],
    ...input,
  };
}

function applyBasePrompt(
  input: PromptInput = {},
  prompt: { preamble?: string; docs?: boolean; tools?: boolean; rules?: boolean } = {
    preamble: "Preset preamble",
  },
) {
  const options = makeOptions(input);
  applyProfile(
    { name: "parity-test", definition: { body: "", prompt } },
    options,
    { ui: { notify() {} } },
    new Set(),
  );
  return options;
}

function sectionBody(name: string, section: string | undefined): string {
  const open = `<${name}>\n`;
  const close = `\n</${name}>`;
  expect(section?.startsWith(open)).toBe(true);
  expect(section?.endsWith(close)).toBe(true);
  return section!.slice(open.length, -close.length);
}

const parityCases: Array<[string, PromptInput]> = [
	["Pi's default tool loadout", {}],
	[
		"hidden tools, snippets, and deduplicated guidelines",
		{
			selectedTools: ["bash", "read", "custom"],
			hiddenTools: ["read"],
			toolSnippets: {
				bash: "Run shell commands",
				read: "Read files",
				custom: "Do custom work",
			},
			toolGuidelines: { bash: ["Keep commands safe", " Keep commands safe "] },
			promptGuidelines: ["Keep commands safe", "Prefer small changes"],
		},
	],
	["PowerShell-only loadout", { selectedTools: ["powershell"] }],
	["bash and PowerShell loadout", { selectedTools: ["bash", "powershell"] }],
	[
		"native file tools suppressing the shell rule",
		{ selectedTools: ["bash", "grep", "find", "ls"] },
	],
];

describe(`Pi ${version} system-prompt parity`, () => {
  test("matches Pi's default preamble", () => {
    const expected = upstream.buildSystemPromptSections({ cwd: "/project" });
    const actual = applyBasePrompt({}, { docs: false });
    expect(actual.customPrompt).toBe(expected.preamble);
  });

  for (const [name, input] of parityCases) {
    test(`matches tools, rules, and docs sections for ${name}`, () => {
      const expected = upstream.buildSystemPromptSections({
        ...input,
        cwd: input.cwd ?? "/project",
      });
      const actual = applyBasePrompt(input);

      expect(actual.sections.tools).toBe(sectionBody("tools", expected.tools));
      expect(actual.sections.rules).toBe(sectionBody("rules", expected.rules));
      expect(actual.sections.docs).toBe(sectionBody("docs", expected.docs));
    });
  }
});
