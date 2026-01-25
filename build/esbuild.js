const esbuild = require('esbuild');
const path = require('path');
const { sentryEsbuildPlugin } = require('@sentry/esbuild-plugin');
const pkg = require('../package.json');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
const rootDir = path.resolve(__dirname, '..');
const release = process.env.SENTRY_RELEASE || `v${pkg.version}`;

// Sentry configuration
const sentryAuthToken = process.env.SENTRY_AUTH_TOKEN?.trim();
const sentryUploadDefault = process.env.CI === 'true' || Boolean(sentryAuthToken);
const sentryUpload = (process.env.SENTRY_UPLOAD ?? sentryUploadDefault.toString()).toLowerCase() === 'true';
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
        if (location) {
          console.error(`    ${location.file}:${location.line}:${location.column}:`);
        }
      });
      console.log('[watch] build finished');
    });
  }
};

function createSentryPlugin() {
  if (!enableSentry) return null;
  
  return sentryEsbuildPlugin({
    authToken: sentryAuthToken,
    org: 'tdmonk',
    project: '4510744389550160',
    telemetry: false,
    release: {
      name: release,
      create: true,
      finalize: true,
    },
  });
}

function createBaseConfig(overrides = {}) {
  return {
    bundle: true,
    minify: production,
    sourcemap: true,
    sourcesContent: false,
    logLevel: 'warning',
    define: {
      'process.env.SENTRY_RELEASE': JSON.stringify(release),
    },
    plugins: [esbuildProblemMatcherPlugin, createSentryPlugin()].filter(Boolean),
    ...overrides,
  };
}

async function main() {
  if (production && sentryUpload && !sentryAuthToken) {
    throw new Error('[sentry-esbuild-plugin] SENTRY_UPLOAD is true but SENTRY_AUTH_TOKEN is missing.');
  }

  // Build Extension Host
  const extensionCtx = await esbuild.context(createBaseConfig({
    entryPoints: [path.join(rootDir, 'src', 'extension.js')],
    format: 'cjs',
    platform: 'node',
    outfile: path.join(rootDir, 'dist', 'extension.js'),
    external: ['vscode'],
    assetNames: '[name]',
    loader: {
      '.node': 'file',
    },
  }));

  // Build Webview Scripts
  const webviewCtx = await esbuild.context(createBaseConfig({
    entryPoints: {
      'data-browser': path.join(rootDir, 'src', 'ui-shared', 'data-browser.js'),
      'main': path.join(rootDir, 'src', 'ui-shared', 'main.js'),
    },
    format: 'iife',
    platform: 'browser',
    outdir: path.join(rootDir, 'dist', 'ui-shared'),
  }));

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