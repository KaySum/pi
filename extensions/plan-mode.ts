/**
 * Plan mode - investigate and propose, without touching anything.
 *
 * `/plan` turns it on. While it is on, file mutations are blocked and bash is restricted to
 * a read-only allowlist, so the model can explore freely but cannot act. The model leaves
 * plan mode by calling `exit_plan_mode`, which shows the plan and asks the user to accept it.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MUTATING_TOOLS = new Set(["edit", "write"]);

const READ_ONLY_COMMANDS =
	/^(ls|cat|head|tail|wc|file|stat|du|df|pwd|echo|which|type|env|date|grep|rg|find|fd|tree|jq|sed -n|awk|diff|man|node --version|npm ls|npm view|git (status|log|diff|show|branch|remote|blame|ls-files|describe|rev-parse|tag$))/;

const REMINDER = [
	"Plan mode is on. Investigate and propose; do not change anything.",
	"Read, search, and run read-only commands as much as you need.",
	"When the plan is ready, call exit_plan_mode with it. Do not start implementing before it is accepted.",
].join(" ");

/** A compound command is only read-only if every part of it is. */
function isReadOnly(command: string): boolean {
	return command
		.split(/&&|\|\||;|\|/)
		.map((part) => part.trim())
		.filter(Boolean)
		.every((part) => READ_ONLY_COMMANDS.test(part));
}

export default function (pi: ExtensionAPI) {
	let active = false;

	const setActive = (value: boolean, ctx: ExtensionContext) => {
		active = value;
		ctx.ui.setStatus("plan", active ? "plan mode" : undefined);
	};

	pi.registerCommand("plan", {
		description: "Toggle plan mode: investigate and propose without making changes",
		handler: async (_args, ctx) => {
			setActive(!active, ctx);
			ctx.ui.notify(active ? "Plan mode on. Nothing will be changed until you accept a plan." : "Plan mode off.", "info");
		},
	});

	// Claude Code cycles modes with shift+tab. keybindings.json frees the key by moving
	// pi's thinking-level cycle to alt+t.
	pi.registerShortcut("shift+tab", {
		description: "Toggle plan mode",
		handler: (ctx) => {
			setActive(!active, ctx);
			ctx.ui.notify(active ? "Plan mode on." : "Plan mode off.", "info");
		},
	});

	pi.on("before_agent_start", () => {
		if (!active) return undefined;
		return { message: { customType: "plan-mode", content: REMINDER, display: "plan mode" } };
	});

	pi.on("tool_call", (event) => {
		if (!active) return undefined;

		if (MUTATING_TOOLS.has(event.toolName)) {
			return { block: true, reason: "Plan mode is on. Propose the change in your plan instead of making it." };
		}
		if (event.toolName === "bash" && !isReadOnly(String(event.input.command ?? ""))) {
			return {
				block: true,
				reason: "Plan mode is on, and that command is not on the read-only allowlist. Investigate without side effects.",
			};
		}
		return undefined;
	});

	pi.registerTool({
		name: "exit_plan_mode",
		label: "Plan",
		description: [
			"Present a finished plan and ask the user to accept it. Call this only in plan mode, and",
			"only once you have investigated enough to be specific about the files and the order of work.",
			"",
			"If the user accepts, plan mode ends and you implement the plan. If they decline, stay in",
			"plan mode and revise.",
		].join("\n"),
		promptSnippet: "exit_plan_mode: present a plan for approval",
		parameters: Type.Object({
			plan: Type.String({ description: "The plan in Markdown: the approach, the ordered steps, and how it is verified" }),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!active) {
				throw new Error("Plan mode is not on; implement the change directly.");
			}
			if (!ctx.hasUI) {
				throw new Error("This session has no UI to accept a plan. Run without plan mode.");
			}

			const accepted = await ctx.ui.confirm("Accept this plan?", params.plan);
			if (accepted) setActive(false, ctx);

			return {
				content: [
					{
						type: "text",
						text: accepted
							? "The user accepted the plan. Plan mode is off; implement it now."
							: "The user declined the plan. Stay in plan mode and revise it.",
					},
				],
				details: { plan: params.plan, accepted },
			};
		},
	});
}
