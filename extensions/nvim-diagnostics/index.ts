import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readSnapshot, selectDiagnostics } from "./bridge.mjs";

export default function (pi: ExtensionAPI) {
  pi.registerFlag("nvim-socket", {
    description: "Neovim server address (see :echo v:servername)",
    type: "string",
  });
  let override: string | undefined;
  const server = () => override || String(pi.getFlag("nvim-socket") || process.env.PI_NVIM_SOCKET || process.env.NVIM || "");

  pi.registerTool(defineTool({
    name: "nvim_diagnostics",
    label: "Neovim diagnostics",
    description: "Read the same current errors, warnings, information and hints cached in the user's running Neovim via vim.diagnostic.get(). Includes LSP and other diagnostic sources, including unsaved buffers. Defaults to files beneath Pi's cwd; use scope=all for all editor diagnostics. Read this when asked about editor/LSP errors or to check fixes, but remember external edits may not yet have reached Neovim/LSP. This does not reload buffers, save files, or run a fresh workspace analysis.",
    parameters: Type.Object({
      file: Type.Optional(Type.String({ description: "Exact file path, relative to Pi cwd or absolute. Overrides scope." })),
      scope: Type.Optional(Type.Union([Type.Literal("project"), Type.Literal("all")], { description: "Default: project (beneath Pi cwd)." })),
      severity: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("error"), Type.Literal("warning"), Type.Literal("information"), Type.Literal("hint")])),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, description: "Maximum returned diagnostics; default 200." })),
    }),
    async execute(_id, params, signal, _update, ctx) {
      const result = selectDiagnostics(await readSnapshot(server(), signal), params, ctx.cwd);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
    },
  }));

  pi.registerCommand("nvim-connect", {
    description: "Connect to Neovim: /nvim-connect <server>; no argument checks current connection; 'auto' resets override",
    handler: async (args, ctx) => {
      const requested = args.trim();
      const candidate = requested === "auto"
        ? String(pi.getFlag("nvim-socket") || process.env.PI_NVIM_SOCKET || process.env.NVIM || "")
        : requested || server();
      try {
        const snapshot = await readSnapshot(candidate);
        if (requested) override = requested === "auto" ? undefined : requested;
        ctx.ui.notify(`Neovim: ${candidate}\nCwd: ${snapshot.cwd}\n${snapshot.diagnostics.length} cached diagnostics`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("nvim-diagnostics", {
    description: "Share current Neovim diagnostics with the agent (optional file path, or 'all')",
    handler: async (args, ctx) => {
      try {
        const arg = args.trim();
        const options = arg === "all" ? { scope: "all" } : arg ? { file: arg } : {};
        const result = selectDiagnostics(await readSnapshot(server()), options, ctx.cwd);
        pi.sendMessage({
          customType: "nvim-diagnostics",
          content: `Neovim diagnostic snapshot:\n${JSON.stringify(result, null, 2)}`,
          display: true,
          details: result,
        }, { triggerTurn: false });
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
