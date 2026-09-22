/**
 * Ask - put a decision back to the user as a multiple-choice question.
 *
 * The model can always ask in prose; this is for the case where the answer changes what it
 * does next and a structured choice is faster for the user than typing a reply.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const OTHER = "Something else…";

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user",
		label: "Ask",
		description: [
			"Ask the user to choose between options when you are blocked on a decision that is",
			"genuinely theirs: one you cannot resolve from the request, the code, or a sensible",
			"default.",
			"",
			"Do not use it for choices with an obvious default or for facts you can check yourself.",
			"In those cases pick the reasonable option, say which you picked, and keep going.",
		].join("\n"),
		promptSnippet: "ask_user: ask the user to choose between options",
		parameters: Type.Object({
			question: Type.String({ description: "The question, specific and ending in a question mark" }),
			options: Type.Array(Type.String(), {
				description: "2-4 distinct choices. Put your recommendation first.",
				minItems: 2,
				maxItems: 4,
			}),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				throw new Error("This session has no UI. Choose the most reasonable option and state the assumption.");
			}

			const choice = await ctx.ui.select(params.question, [...params.options, OTHER]);
			if (choice === undefined) {
				return {
					content: [{ type: "text", text: "The user dismissed the question without answering." }],
					details: { question: params.question, answer: undefined },
				};
			}

			const answer = choice === OTHER ? ((await ctx.ui.input(params.question)) ?? "") : choice;
			return {
				content: [{ type: "text", text: answer || "The user gave no answer." }],
				details: { question: params.question, answer },
			};
		},
	});
}
