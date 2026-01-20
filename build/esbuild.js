const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');
const { sentryEsbuildPlugin } = require("@sentry/esbuild-plugin");
const pkg = require('../package.json');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const entryFile = path.join(rootDir, 'src', 'extension.js');
const outFile = path.join(distDir, 'extension.js');

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

  if (production && !sentryUpload) {
    // If we're doing a local build, ensure we don't accidentally pick up tokens from files
    if (fs.existsSync(path.join(rootDir, '.env.sentry-build-plugin'))) {
      console.warn('[build] Warning: .env.sentry-build-plugin exists but SENTRY_UPLOAD is false. The file will be ignored for this build.');
    }
  }

  // Ensure dist exists
  if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
  }

  // Copy all Sentry profiler binaries to dist/
  // Esbuild's automatic 'file' loader only catches static requires.
  // Sentry uses dynamic requires for some ABIs, so we must copy everything.
  const sentryProfilerDir = path.join(rootDir, 'node_modules', '@sentry-internal', 'node-cpu-profiler', 'lib');
  if (fs.existsSync(sentryProfilerDir)) {
    const files = fs.readdirSync(sentryProfilerDir);
    for (const file of files) {
      if (file.endsWith('.node')) {
        fs.copyFileSync(path.join(sentryProfilerDir, file), path.join(distDir, file));
      }
    }
    console.log(`Copied ${files.filter(f => f.endsWith('.node')).length} Sentry profiler binaries to dist/`);
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
