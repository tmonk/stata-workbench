## Development
- Node.js version: `>=22.14.0` (or Bun v1.2+)
- Install dependencies: `bun install`
- **Download uv binaries**: `bun run download-uv` (fetches platform-specific binaries for bundling)
- Bundle for development: `bun run compile`
- Production build: `bun run bundle` (local builds default to development mode unless `CI=true` is set)
- Watch mode: `bun run watch`
- Unit Tests: `bun run test`
- Integration Tests: `bun run test:integration` (requires `mcp-stata` on PATH)

### Testing with Local mcp-stata
To test changes to the `mcp-stata` server locally without publishing to PyPI:

1. **In Integration Tests**: The test runner (`runTest.js`) automatically attempts to resolve the local `mcp-stata` directory. You can force a specific path by setting the `MCP_STATA_LOCAL_REPO` environment variable:
   ```bash
   MCP_STATA_LOCAL_REPO="/path/to/mcp-stata" bun run test:integration
   ```

2. **In VS Code (Manual Testing)**: Create a `.vscode/mcp.json` file in the root of the `stata-workbench` workspace. This will override global MCP configurations:
   ```json
   {
     "servers": {
       "mcp_stata": {
         "command": "uv",
         "args": ["run", "--directory", "/path/to/your/mcp-stata", "mcp-stata"]
       }
     }
   }
   ```
   *Note: Ensure `uv` is installed and the directory points to your local `mcp-stata` clone.*

## Commit Conventions
We use [Conventional Commits](https://www.conventionalcommits.org/) to automate our release process. This is enforced locally via `commitlint` + `husky` and in CI via the `Commitlint` GitHub Actions workflow.

When you commit, use the following prefixes:
- `fix:` for bug fixes (triggers a **patch** release)
- `feat:` for new features (triggers a **minor** release)
- `BREAKING CHANGE:` or `!` after the type (e.g., `feat!:`) for breaking changes (triggers a **major** release)
- `chore:`, `docs:`, `style:`, `refactor:`, `test:` for changes that don't affect the production code (no release)

You can validate recent commits locally with:
```bash
bun run lint:commits
```

## Automated Releases
This project uses `semantic-release` to automate versioning and publishing to the VS Code Marketplace and Open VSX Registry via GitHub Actions.

- Releases trigger automatically on push to `main`.
- `CHANGELOG.md` is updated automatically.

## Manual Packaging (Local Debugging)
- Build VSIX for current platform: `bun run package`
- Build VSIX for specific target: `npm_config_target=win32-x64 bun run package:target`
- Verify build: `bun run bundle` (production build)
- Clean build outputs: `rm -rf dist bin/*.vsix`