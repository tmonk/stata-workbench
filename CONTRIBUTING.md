## Development
- Node.js version: `>=22.14.0` (or Bun v1.2+)
- Install dependencies: `bun install`
- Bundle for development: `bun run compile`
- Production build: `bun run bundle` (local builds default to development mode unless `CI=true` is set)
- Watch mode: `bun run watch`
- Unit Tests: `bun run test`
- Integration Tests: `bun run test:integration` (requires `stata-agent` on PATH)

### Testing with Local stata-agent
To test changes to the `stata-agent` server locally without publishing to PyPI:

1. **In Integration Tests**: The test runner (`runTest.js`) automatically attempts to resolve the local `stata-agent` directory. You can force a specific path by setting the `STATA_AGENT_LOCAL_REPO` environment variable:
   ```bash
   STATA_AGENT_LOCAL_REPO="/path/to/stata-agent" bun run test:integration
   ```

2. **In VS Code (Manual Testing)**: Configure the extension to point to your local `stata-agent` clone via the extension settings.
   *Note: Ensure `uv` is installed and the directory points to your local `stata-agent` clone.*

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