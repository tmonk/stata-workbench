## Development
- Node.js version: `>=22.14.0`
- Install dependencies: `npm install`
- Bundle for development: `npm run compile`
- Production build: `npm run bundle`
- Watch mode: `npm run watch`
- Unit Tests: `npm test`
- Integration Tests: `npm run test:integration` (requires `mcp-stata` on PATH, (`$env:MCP_STATA_INTEGRATION="1"; npm run compile; node ./test/integration/runTest.js`)

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
- Build VSIX: `npm run package:dist` (outputs to `dist/`).
- Verify build: `npm run bundle` (production build).