## Development
- Install deps: `npm install`
- Bundle once for local debugging: `npm run compile`
- Watch mode while iterating: `npm run watch`
- Tests: `npm test`, `npm run test:integration` for integration tests. (`$env:MCP_STATA_INTEGRATION="1"; npm run compile; node ./test/integration/runTest.js`)

## Commit Conventions
We use [Conventional Commits](https://www.conventionalcommits.org/) to automate our release process. This is enforced via `commitlint` and `husky`.

When you commit, use the following prefixes:
- `fix:` for bug fixes (triggers a **patch** release)
- `feat:` for new features (triggers a **minor** release)
- `BREAKING CHANGE:` or `!` after the type (e.g., `feat!:`) for breaking changes (triggers a **major** release)
- `chore:`, `docs:`, `style:`, `refactor:`, `test:` for changes that don't affect the production code (no release)

## Automated Releases
This project uses `semantic-release` to automate versioning and publishing.
- **Releases**: Happen automatically on push/merge to the `main` branch.
- **Notes**: Generated automatically from commit history into `CHANGELOG.md`.
- **Publishing**: Automated to both the VS Code Marketplace and Open VSX Registry via GitHub Actions.

## Manual Packaging (Local Debugging)
- Build VSIX: `npm run package:dist` (outputs to `dist/`).
- Verify build: `npm run bundle` (production build).