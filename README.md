# Stata Workbench

A VS Code / Cursor extension that allows Stata code to be run directly from the editor. It connects directly to the [mcp-stata](https://github.com/tmonk/mcp-stata) MCP server over stdio.

Built by [Thomas Monk](https://tdmonk.com), London School of Economics.

## Installation
1. Download the latest extension .vsix from the [releases page](https://github.com/tmonk/stata-workbench/releases/latest).
2. In your VS Code/Cursor/Antigravity/Windsurf IDE, open the command palette (`Ctrl+Shift+P` or `Cmd+Shift+P` on Mac) and select `Extensions: Install from VSIX...`.
3. Select the downloaded .vsix file and install.

## Requirements
- Stata 17+
- uv/uvx on PATH (to run the published mcp-stata tool). If missing, the extension bootstraps uv locally into its storage; otherwise it surfaces a quick action to copy the install command or open the uv install docs.

## Features & Commands
- Run Selection/Current Line (`stata-workbench.runSelection`) → MCP tool `run_command` with normalized output + graphs.
- Run Current File (`stata-workbench.runFile`) → MCP tool `run_do_file` for `.do` scripts.
- Interactive panel (`stata-workbench.showInteractive`): rerun snippets inline with the latest stdout/stderr + graph artifacts.
- Graph viewer (`stata-workbench.showGraphs`): list via `list_graphs`, fetch via `export_graph`, render inline previews.
- Test MCP Server (`stata-workbench.testMcpServer`) for quick smoke checks.
- Install MCP CLI helper (`stata-workbench.installMcpCli`): bootstraps uv locally when it is missing.
- Status bar + cancel (`stata-workbench.cancelRequest`): live request states with one-click cancellation routed through the MCP client.
- Auto-manage MCP configs: writes `.vscode/mcp.json` and `.cursor/mcp.json` so agents reuse the same `uvx --from mcp-stata` wiring.
- Run results surface in the Run panel + `Stata MCP` output channel for durable logs.

## Settings (contributes)
- `stataMcp.requestTimeoutMs` (default `45000`): timeout for MCP requests.
- `stataMcp.autoRevealOutput` (default `true`): automatically show the output channel after runs.

## Agent MCP configs (optional)
When uv is available, the extension writes `.vscode/mcp.json` + `.cursor/mcp.json` with the correct `mcp_stata` wiring. If you want to manage the files yourself (or copy them into another repo) use the snippets below.

VS Code agents (`.vscode/mcp.json`):
```json
{
  "servers": {
    "mcp_stata": {
      "type": "stdio",
      "command": "uvx",
      "args": ["--from", "mcp-stata", "mcp-stata"]
    }
  }
}
```

Cursor agents (`.cursor/mcp.json`):
```json
{
  "mcpServers": {
    "mcp_stata": {
      "command": "uvx",
      "args": ["--from", "mcp-stata", "mcp-stata"]
    }
  }
}
```

## Troubleshooting
- Status bar says “CLI missing”: install uv (includes uvx) with `curl -LsSf https://astral.sh/uv/install.sh | sh`.
- Requests time out: raise `stataMcp.requestTimeoutMs`.
- Unexpected MCP errors: open the output channel for a structured error message.
- Cancel a stuck run: run `Stata: Cancel Current Request` from the command palette.

## Packaging
- Build bundle: `npm run bundle` (runs esbuild in production mode).
- Build VSIX: `npm install && npm run package` (bundles then invokes `vsce`).
- Publish to VS Code Marketplace: `VSCE_PAT=<token> npm run package && npx vsce publish` (or use your own flow).
- Publish to Open VSX: `OVSX_TOKEN=<token> npm run publish:ovsx` (see [Open VSX publishing guide](https://github.com/EclipseFdn/open-vsx.org/wiki/Publishing-Extensions)).

## Uninstall cleanup (optional)
If you added agent configs and want to remove them:
- `.vscode/mcp.json` → delete `servers.mcp_stata`
- `.cursor/mcp.json` → delete `mcpServers.mcp_stata`

## Development
- Install deps: `npm install`
- Bundle once for local debugging: `npm run compile`
- Watch mode while iterating: `npm run watch`
- Tests: `npm test`
- Package: `npm run package` (or `npm run package:dist` for output to the dist directory)

## Acknowledgments
Portions of this file are derived from [stata-mcp](https://github.com/hanlulong/stata-mcp) (MIT License), [language-stata](https://github.com/kylebarron/language-stata) by Kyle Barron (MIT License), and [vscode-stata](https://github.com/kylebutts/vscode-stata) by Kyle Butts (MIT License). See license_extras for the full license texts. Do check their projects out!