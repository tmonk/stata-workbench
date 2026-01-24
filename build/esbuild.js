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
const sentryAuthToken = process.env.SENTRY_AUTH_TOKEN?.trim();
const sentryUploadDefault = (process.env.CI === 'true' || Boolean(sentryAuthToken)) ? 'true' : 'false';
const sentryUploadEnv = process.env.SENTRY_UPLOAD ?? sentryUploadDefault;
const sentryUpload = sentryUploadEnv.toLowerCase() === 'true';
const enableSentry = production && sentryUpload;

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

async function main() {
  if (production && sentryUpload && !sentryAuthToken) {
    throw new Error('[sentry-esbuild-plugin] SENTRY_UPLOAD is true but SENTRY_AUTH_TOKEN is missing.');
  }
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
    assetNames: '[name]',
    define: {
      'process.env.SENTRY_RELEASE': JSON.stringify(release),
    },
    loader: {
      '.node': 'file',
    },
    logLevel: 'warning',
    plugins: [
      esbuildProblemMatcherPlugin,
      enableSentry && sentryEsbuildPlugin({
        authToken: sentryAuthToken,
        org: "tdmonk",
        project: "4510744389550160",
        telemetry: false,
        release: {
          name: release,
          create: false,
          finalize: false,
        },
      }),
    ].filter(Boolean)
  });

  // Build Webview Scripts
  const webviewEntries = {
    'data-browser': path.join(rootDir, 'src', 'ui-shared', 'data-browser.js'),
    'main': path.join(rootDir, 'src', 'ui-shared', 'main.js')
  };
  const webviewOutDir = path.join(rootDir, 'dist', 'ui-shared');
  const webviewCtx = await esbuild.context({
    entryPoints: webviewEntries,
    bundle: true,
    format: 'iife',
    minify: production,
    sourcemap: true,
    sourcesContent: false,
    platform: 'browser',
    outdir: webviewOutDir,
    define: {
      'process.env.SENTRY_RELEASE': JSON.stringify(release),
    },
    logLevel: 'warning',
    plugins: [
      esbuildProblemMatcherPlugin,
      enableSentry && sentryEsbuildPlugin({
        authToken: sentryAuthToken,
        org: "tdmonk",
        project: "4510744389550160",
        telemetry: false,
        release: {
          name: release,
          create: false,
          finalize: false,
        },
      }),
    ].filter(Boolean)
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

main().catch(e => {
  console.error(e);
  process.exit(1);
});
