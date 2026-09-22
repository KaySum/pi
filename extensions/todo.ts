/**
 * Todo - a visible task list for multi-step work.
 *
 * Matches Claude Code's TodoWrite: the model rewrites the whole list on every call, so
 * the latest tool result always holds the current state. Keeping state in the result
 * details rather than on disk means forking or navigating the session tree restores the
 * list that belonged to that point in history.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type Status = "pending" | "in_progress" | "completed";

interface Todo {
	content: string;
	activeForm: string;
	status: Status;
}

const TodoParams = Type.Object({
	todos: Type.Array(
		Type.Object({
			content: Type.String({ description: "The task, in the imperative: 'Add the auth middleware'" }),
			activeForm: Type.String({ description: "The same task in the present continuous: 'Adding the auth middleware'" }),
			status: StringEnum(["pending", "in_progress", "completed"] as const),
		}),
		{ description: "The complete list, including unchanged items" },
	),
});

const MARK: Record<Status, string> = { pending: "[ ]", in_progress: "[~]", completed: "[x]" };

function render(todos: Todo[]): string {
	return todos.map((todo) => `${MARK[todo.status]} ${todo.content}`).join("\n");
}

export default function (pi: ExtensionAPI) {
	let todos: Todo[] = [];

	const restore = (ctx: ExtensionContext) => {
		todos = [];
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const message = entry.message;
			if (message.role !== "toolResult" || message.toolName !== "todo_write") continue;
			const details = message.details as { todos?: Todo[] } | undefined;
			if (details?.todos) todos = details.todos;
		}
		showActive(ctx);
	};

	const showActive = (ctx: ExtensionContext) => {
		const active = todos.find((todo) => todo.status === "in_progress");
		const done = todos.filter((todo) => todo.status === "completed").length;
		ctx.ui.setStatus("todo", active ? `${active.activeForm} (${done}/${todos.length})` : undefined);
	};

	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));

	pi.registerTool({
		name: "todo_write",
		label: "Todo",
		description: [
			"Track progress through multi-step work. Use it for tasks with three or more distinct",
			"steps, and whenever the user gives you a list of things to do. Skip it for single-step",
			"work - the overhead is not worth it there.",
			"",
			"Send the complete list every time; it replaces the previous one. Keep exactly one task",
			"in_progress, mark a task completed as soon as it is actually done rather than batching",
			"at the end, and never mark something completed that failed or is partially done.",
		].join("\n"),
		promptSnippet: "todo_write: track progress through multi-step work",
		promptGuidelines: [
			"Use todo_write for work with three or more steps, keeping exactly one task in_progress.",
		],
		parameters: TodoParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const active = params.todos.filter((todo) => todo.status === "in_progress");
			if (active.length > 1) {
				throw new Error(`Only one task may be in_progress; got ${active.length}`);
			}

			todos = params.todos;
			showActive(ctx);

			return {
				content: [{ type: "text", text: todos.length ? render(todos) : "The todo list is empty" }],
				details: { todos: [...todos] },
			};
		},
	});

	pi.registerCommand("todos", {
		description: "Show the current todo list",
		handler: async (_args, ctx) => {
			ctx.ui.notify(todos.length ? render(todos) : "No todos", "info");
		},
	});
}
