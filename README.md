# Stata Workbench

<img style="margin: auto; text-align: center;" src="https://raw.githubusercontent.com/tmonk/stata-workbench/refs/heads/main/img/icon.png" width="200">

A VS Code / Cursor / Antigravity / Windsurf extension that allows Stata code to be run directly from the editor. Enables AI agents to directly interact with Stata, powered by [mcp-stata](https://github.com/tmonk/mcp-stata).

Built by [Thomas Monk](https://tdmonk.com), London School of Economics.

## Installation

Install directly from the marketplace listings by searching for **Stata Workbench** in the Extensions view.

[![Add to VSCode](https://img.shields.io/badge/VS%20Code-2C2C2C?style=flat&logo=data:image/svg+xml;base64,PHN2ZyByb2xlPSJpbWciIHZpZXdCb3g9IjAgMCAyNCAyNCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48dGl0bGU+VmlzdWFsIFN0dWRpbyBDb2RlPC90aXRsZT48cGF0aCBmaWxsPSJ3aGl0ZSIgZD0iTTIzLjE1IDIuNTg3TDE4LjIxLjIxYTEuNDk0IDEuNDk0IDAgMCAwLTEuNzA1LjI5bC05LjQ2IDguNjMtNC4xMi0zLjEyOGEuOTk5Ljk5OSAwIDAgMC0xLjI3Ni4wNTdMLjMyNyA3LjI2MUExIDEgMCAwIDAgLjMyNiA4Ljc0TDMuODk5IDEyIC4zMjYgMTUuMjZhMSAxIDAgMCAwIC4wMDEgMS40NzlMMS42NSAxNy45NGEuOTk5Ljk5OSAwIDAgMCAxLjI3Ni4wNTdsNC4xMi0zLjEyOCA5LjQ2IDguNjNhMS40OTIgMS40OTIgMCAwIDAgMS43MDQuMjlsNC45NDItMi4zNzdBMS41IDEuNSAwIDAgMCAyNCAyMC4wNlYzLjkzOWExLjUgMS41IDAgMCAwLS44NS0xLjM1MnptLTUuMTQ2IDE0Ljg2MUwxMC44MjYgMTJsNy4xNzgtNS40NDh2MTAuODk2eiIvPjwvc3ZnPg==&logoColor=white)](https://marketplace.visualstudio.com/items?itemName=tmonk.stata-workbench)
[![Add to Cursor](https://img.shields.io/badge/Cursor-2C2C2C?style=flat&logo=cursor&logoColor=white)](https://open-vsx.org/extension/tmonk/stata-workbench)
[![Add to Antigravity](https://img.shields.io/badge/Antigravity-2C2C2C?style=flat&logo=google&logoColor=white)](https://open-vsx.org/extension/tmonk/stata-workbench)
[![Add to Windsurf](https://img.shields.io/badge/Windsurf-2C2C2C?style=flat&logo=windsurf&logoColor=white)](https://open-vsx.org/extension/tmonk/stata-workbench)

- VS Code Marketplace: [tmonk.stata-workbench](https://marketplace.visualstudio.com/items?itemName=tmonk.stata-workbench)
- Open VSX: [tmonk/stata-workbench](https://open-vsx.org/extension/tmonk/stata-workbench)

Offline/VSIX fallback:
1. Download the latest extension .vsix from the [releases page](https://github.com/tmonk/stata-workbench/releases/latest).
2. In your VS Code/Cursor/Antigravity/Windsurf IDE, open the command palette (`Ctrl+Shift+P` or `Cmd+Shift+P` on Mac) and select `Extensions: Install from VSIX...`.
3. Select the downloaded .vsix file and install.

## Requirements
- Stata 17+
- uv/uvx on PATH (to run the published mcp-stata tool). If missing, the extension bootstraps uv locally into its storage; otherwise it surfaces a quick action to copy the install command or open the uv install docs.

## Features & Commands
- Syntax highlighting for Stata, Dyndoc Markdown, and Dyndoc LaTeX.
- Run Selection/Current Line (`stata-workbench.runSelection`) → MCP tool `run_command` with normalized output + graphs.
- Run Current File (`stata-workbench.runFile`) → MCP tool `run_do_file` for `.do` scripts.
- Interactive panel (`stata-workbench.showInteractive`): rerun snippets inline with the latest stdout/stderr + graph artifacts.
- Graph viewer (`stata-workbench.showGraphs`): list via `list_graphs`, fetch via `export_graph`, render inline previews.
- Test MCP Server (`stata-workbench.testMcpServer`) for quick smoke checks.
- Install MCP CLI helper (`stata-workbench.installMcpCli`): bootstraps uv locally when it is missing.
- Status bar + cancel (`stata-workbench.cancelRequest`): live request states with one-click cancellation routed through the MCP client.
- Auto-manage MCP configs: writes `.vscode/mcp.json` and `.cursor/mcp.json` so agents reuse the same `uvx --from mcp-stata` wiring.
- Run results surface in the Run panel + `Stata MCP` output channel for durable logs.

## Settings
- `stataMcp.requestTimeoutMs` (default `45000`): timeout for MCP requests.
- `stataMcp.autoRevealOutput` (default `true`): automatically show the output channel after runs.
- `stataMcp.runFileWorkingDirectory` (default empty): working directory when running .do files. Supports an absolute path, ~, ${workspaceFolder} or ${fileDir}; empty uses the .do file's folder.

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

## Uninstall cleanup (optional)
If you added agent configs and want to remove them:
- `.vscode/mcp.json` → delete `servers.mcp_stata`
- `.cursor/mcp.json` → delete `mcpServers.mcp_stata`

## Acknowledgments
Portions of this file are derived from [stata-mcp](https://github.com/hanlulong/stata-mcp) (MIT License), [language-stata](https://github.com/kylebarron/language-stata) by Kyle Barron (MIT License), and [vscode-stata](https://github.com/kylebutts/vscode-stata) by Kyle Butts (MIT License). See license_extras for the full license texts. Do check their projects out!
