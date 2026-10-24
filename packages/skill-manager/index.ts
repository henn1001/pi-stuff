import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { handleSkillCommand } from "./src/command.js";

const INSTALL = Symbol.for("dotfiles.skill-invocation-manager.installed");

export default function skillInvocationManager(pi: ExtensionAPI): void {
	const guard = pi as unknown as Record<PropertyKey, unknown>;
	if (guard[INSTALL]) return;
	guard[INSTALL] = true;

	pi.registerCommand("skill", {
		description: "Browse skills or manage model invocation visibility",
		handler: handleSkillCommand,
	});
}
