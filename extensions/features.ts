/**
 * Features - show which parts of this configuration are on.
 *
 * The switches live in `features.json` in the agent directory. This command is always
 * available, so a session can always report what it is running.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FEATURES, features } from "../lib/features.ts";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("features", {
		description: "Show which features are enabled, and where to change them",
		handler: async (_args, ctx) => {
			const state = features();
			const lines = FEATURES.map(([name, description]) => {
				const on = state[name] !== false;
				return `  ${on ? "on " : "off"}  ${name.padEnd(20)} ${description}`;
			});

			ctx.ui.notify(
				[...lines, "", "Edit features.json in the agent directory, then run /reload."].join("\n"),
				"info",
			);
		},
	});
}
