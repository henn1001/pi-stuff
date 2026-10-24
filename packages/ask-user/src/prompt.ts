/** Model-facing schema descriptions for answer options. */
export const ASK_USER_PARAMETER_DESCRIPTIONS = {
	optionLabel: "Short display label",
	optionDescription: "One-line detail below the label",
};

/** Describes the ask_user tool's question shape and dismissible free-form fallback. */
export const ASK_USER_TOOL_DESCRIPTION =
	"Ask one question per call. A custom-answer option is added automatically; do not include it. The user may dismiss without answering.";

/** Adds ask_user's multiple-choice capability to the model's available-tools prompt. */
export const ASK_USER_PROMPT_SNIPPET = "Ask a multiple-choice question";

/** Guides the model to use ask_user for enumerable answers. */
export const ASK_USER_PROMPT_GUIDELINES = [
	"Use ask_user instead of plain text when likely answers can be enumerated.",
];

/** Builds the behavioral tool-result message returned to the parent model for an ask_user outcome. */
export function buildAskUserResultMessage(
	outcome:
		| { kind: "no-ui" }
		| { kind: "cancelled" }
		| { kind: "dismissed" }
		| { kind: "custom"; answer: string }
		| { kind: "selected"; answer: string; index: number | undefined },
) {
	switch (outcome.kind) {
		case "no-ui":
			return "No interactive UI is available, so the question could not be shown. Ask the user in plain text instead.";
		case "cancelled":
			return "Cancelled";
		case "dismissed":
			return "User dismissed the question without answering. Do not assume an answer; proceed accordingly or ask differently.";
		case "custom":
			return `User wrote their own answer: ${outcome.answer}`;
		case "selected":
			return `User selected option ${outcome.index}: ${outcome.answer}`;
	}
}
