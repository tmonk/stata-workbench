# Stata Agentic Toolkit Features

Stata Workbench is a unified **Agentic Toolkit** for Stata development, providing a rich IDE experience with deep AI integration:

- **Integrated Terminal**: Rich UI for tracking Stata output with clickable links, integrated search, and persistent history. Includes a **Log tab** for the full session history with efficient tail-loading for large logs.
- **Data Browser** (`stata-workbench.viewData`): High-performance view of millions of rows (~20x faster with Apache Arrow) with live filtering and sorting. Optimized for data-intensive research.
- **Advanced MCP Tools**: Full suite of tools for agents to Run code, Inspect data, and Export Graphs directly from the AI chat.
- **Run Selection/Current Line** (`stata-workbench.runSelection`): Executes selected code or the current line with results and graphs routed to the unified terminal panel.
- **Run Current File** (`stata-workbench.runFile`): Runs entire `.do` files with full execution tracking and return code validation.
- **Environment Detection** (`stata_manage_session` action="detect"): Returns Stata version, flavor, OS metadata, and optionally a list of installed SSC packages.
- **Code Linting** (`stata_inspect_data` action="lint"): Static analysis of `.do` and `.ado` files to identify style violations and modern best practices.
- **Modern Stata Skill**: Pre-configured domain knowledge that teaches agents to use frames, `gtools`, and dynamic paths instead of legacy anti-patterns.
- **State History & Diff**: Track and compare dataset states (variables, macros, observations) between command executions.
- **Integrated Results**: Coherent access to `r()`, `e()`, and `s()` results, including matrices and Mata state.
- **Setup Toolkit** (`scripts/setup_toolkit.py`): Automated registration for Claude Desktop, Codex, VS Code, and Cursor in one command.
- **Auto-manage MCP configs**: Synchronizes your host MCP settings (`mcp.json`) across your favorite AI editors.
- **Status Bar + Cancel**: Live request states with one-click cancellation routed through the MCP client.
- **Test MCP Server** (`stata-workbench.testMcpServer`): Quick smoke checks to verify your Stata connection.
- **Syntax Highlighting**: Full support for `.do`, `.ado`, `.mata`, Dyndoc Markdown, and Dyndoc LaTeX.
- **Install MCP CLI helper** (`stata-workbench.installMcpCli`): Bootstraps `uv` locally when it is missing from the environment.
- **Durable logs**: All run results are logged to the `Stata Workbench` output channel for persistent reference.