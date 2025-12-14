## Development
- Install deps: `npm install`
- Bundle once for local debugging: `npm run compile`
- Watch mode while iterating: `npm run watch`
- Tests: `npm test`
- Package: `npm run package` (or `npm run package:dist` for output to the dist directory)

## Packaging - for internal use
- Build bundle: `npm run bundle` (runs esbuild in production mode).
- Build VSIX: `npm install && npm run package` (bundles then invokes `vsce`).
- Publish to VS Code Marketplace: `VSCE_PAT=<token> npm run package && npx vsce publish` (or use your own flow).
- Publish to Open VSX: `OVSX_TOKEN=<token> npm run publish:ovsx` (see [Open VSX publishing guide](https://github.com/EclipseFdn/open-vsx.org/wiki/Publishing-Extensions)).