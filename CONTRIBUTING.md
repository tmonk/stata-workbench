## Development
- Node.js version: `>=22.14.0` (or Bun v1.2+)
- Install dependencies: `bun install`
- **Download uv binaries**: `bun run download-uv` (fetches platform-specific binaries for bundling)
- Bundle for development: `bun run compile`
- Production build: `bun run bundle` (local builds default to development mode unless `CI=true` is set)
- Watch mode: `bun run watch`
- Unit Tests: `bun run test`
- Integration Tests: `bun run test:integration` (requires `mcp-stata` on PATH)

## Commit Conventions
We use [Conventional Commits](https://www.conventionalcommits.org/) to automate our release process. This is enforced via `commitlint` and `husky`.

When you commit, use the following prefixes:
- `fix:` for bug fixes (triggers a **patch** release)
- `feat:` for new features (triggers a **minor** release)
- `BREAKING CHANGE:` or `!` after the type (e.g., `feat!:`) for breaking changes (triggers a **major** release)
- `chore:`, `docs:`, `style:`, `refactor:`, `test:` for changes that don't affect the production code (no release)

## Automated Releases
This project uses `semantic-release` to automate versioning and publishing to the VS Code Marketplace and Open VSX Registry via GitHub Actions.

- Releases trigger automatically on push to `main`.
- `CHANGELOG.md` is updated automatically.

## Manual Packaging (Local Debugging)
- Build VSIX for current platform: `bun run package`
- Build VSIX for specific target: `npm_config_target=win32-x64 bun run package:target`
- Verify build: `bun run bundle` (production build)
- Clean build outputs: `rm -rf dist bin/*.vsix`