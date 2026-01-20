const esbuild = require('esbuild');
const path = require('path');
const { sentryEsbuildPlugin } = require("@sentry/esbuild-plugin");
const pkg = require('../package.json');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
const rootDir = path.resolve(__dirname, '..');
const entryFile = path.join(rootDir, 'src', 'extension.js');
const outFile = path.join(rootDir, 'dist', 'extension.js');

const release = process.env.SENTRY_RELEASE || `v${pkg.version}`;

async function main() {
  // Build Extension Host
  const extensionCtx = await esbuild.context({
    entryPoints: [entryFile],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: true,
    sourcesContent: false,
    platform: 'node',
    outfile: outFile,
    external: ['vscode'],
    define: {
      'process.env.SENTRY_RELEASE': JSON.stringify(release),
    },
    loader: {
      '.node': 'file',
    },
    logLevel: 'warning',
    plugins: [
      esbuildProblemMatcherPlugin,
      sentryEsbuildPlugin({
        authToken: process.env.SENTRY_AUTH_TOKEN,
        org: "tdmonk",
        project: "node",
        release: {
          name: release,
        },
      }),
    ]
  });

  // Build Webview Scripts
  const webviewEntry = path.join(rootDir, 'src', 'ui-shared', 'data-browser.js');
  const webviewOut = path.join(rootDir, 'dist', 'ui-shared', 'data-browser.js');
  const webviewCtx = await esbuild.context({
    entryPoints: [webviewEntry],
    bundle: true,
    format: 'iife',
    minify: production,
    sourcemap: true,
    sourcesContent: false,
    platform: 'browser',
    outfile: webviewOut,
    define: {
      'process.env.SENTRY_RELEASE': JSON.stringify(release),
    },
    logLevel: 'warning',
    plugins: [
      esbuildProblemMatcherPlugin,
      sentryEsbuildPlugin({
        authToken: process.env.SENTRY_AUTH_TOKEN,
        org: "tdmonk",
        project: "node",
        release: {
          name: release,
        },
      }),
    ]
  });

  if (watch) {
    await extensionCtx.watch();
    await webviewCtx.watch();
  } else {
    await extensionCtx.rebuild();
    await webviewCtx.rebuild();
    await extensionCtx.dispose();
    await webviewCtx.dispose();
  }
}

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
  name: 'esbuild-problem-matcher',

  setup(build) {
    build.onStart(() => {
      console.log('[watch] build started');
    });
    build.onEnd(result => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`);
        if (location == null) return;
        console.error(`    ${location.file}:${location.line}:${location.column}:`);
      });
      console.log('[watch] build finished');
    });
  }
};

main().catch(e => {
  console.error(e);
  process.exit(1);
});
