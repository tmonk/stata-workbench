const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');
const { sentryEsbuildPlugin } = require("@sentry/esbuild-plugin");
const pkg = require('../package.json');

// Force development mode on local environments, even if --production is passed.
// Production mode is only enabled in CI environments.
const production = process.argv.includes('--production') && process.env.CI === 'true';
const watch = process.argv.includes('--watch');

// Parse target if provided via --target=xyz
const targetArg = process.argv.find(arg => arg.startsWith('--target='));
const buildTarget = targetArg ? targetArg.split('=')[1] : null;

const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const entryFile = path.join(rootDir, 'src', 'extension.js');
const outFile = path.join(distDir, 'extension.js');

const release = process.env.SENTRY_RELEASE || `${pkg.name}@${pkg.version}`;
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

  // Ensure dist exists and is clean
  if (fs.existsSync(distDir)) {
    fs.rmSync(distDir, { recursive: true, force: true });
  }
  fs.mkdirSync(distDir, { recursive: true });

  // Copy all Sentry profiler binaries to dist/
  // Esbuild's automatic 'file' loader only catches static requires.
  // Sentry uses dynamic requires for some ABIs, so we must copy everything.
  const sentryProfilerDir = path.join(rootDir, 'node_modules', '@sentry-internal', 'node-cpu-profiler', 'lib');
  if (fs.existsSync(sentryProfilerDir)) {
    const files = fs.readdirSync(sentryProfilerDir);
    let copiedCount = 0;
    for (const file of files) {
      if (file.endsWith('.node')) {
        fs.copyFileSync(path.join(sentryProfilerDir, file), path.join(distDir, file));
        copiedCount++;
      }
    }
    console.log(`Copied ${copiedCount} Sentry profiler binaries to dist/`);
  }

  // Build Extension Host
  const extensionCtx = await esbuild.context({
    entryPoints: [entryFile],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: true,
    platform: 'node',
    outfile: outFile,
    external: ['vscode'],
    assetNames: '[name]',
    define: {
      'process.env.SENTRY_RELEASE': JSON.stringify(release),
      'process.env.NODE_ENV': JSON.stringify(production ? 'production' : 'development'),
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
        sourcemaps: {
          assets: ['./dist/**'],
        },
        release: {
          name: release,
        },
      }),
    ].filter(Boolean)
  });

  // Build Webview Scripts
  const webviewScripts = [
    {
      entry: path.join(rootDir, 'src', 'ui-shared', 'data-browser.js'),
      out: path.join(rootDir, 'dist', 'ui-shared', 'data-browser.js')
    },
    {
      entry: path.join(rootDir, 'src', 'ui-shared', 'main.js'),
      out: path.join(rootDir, 'dist', 'ui-shared', 'main.js')
    }
  ];

  const webviewCtxs = await Promise.all(webviewScripts.map(async script => {
    return await esbuild.context({
      entryPoints: [script.entry],
      bundle: true,
      format: 'iife',
      minify: production,
      sourcemap: true,
      platform: 'browser',
      outfile: script.out,
      define: {
        'process.env.SENTRY_RELEASE': JSON.stringify(release),
        'process.env.NODE_ENV': JSON.stringify(production ? 'production' : 'development'),
      },
      logLevel: 'warning',
      plugins: [
        esbuildProblemMatcherPlugin,
        enableSentry && sentryEsbuildPlugin({
          authToken: sentryAuthToken,
          org: "tdmonk",
          project: "4510744389550160",
          telemetry: false,
          sourcemaps: {
            assets: ['./dist/**'],
          },
          release: {
            name: release,
          },
        }),
      ].filter(Boolean)
    });
  }));

  if (watch) {
    await extensionCtx.watch();
    await Promise.all(webviewCtxs.map(ctx => ctx.watch()));
  } else {
    await extensionCtx.rebuild();
    await Promise.all(webviewCtxs.map(ctx => ctx.rebuild()));

    // Post-build cleanup: if a target is specified, remove non-matching Sentry binaries
    if (buildTarget) {
      const [platform, arch] = buildTarget.split('-');
      const files = fs.readdirSync(distDir);
      let removedCount = 0;
      for (const file of files) {
        if (file.endsWith('.node')) {
          const isMatch = file.includes(`-${platform}-`) && file.includes(`-${arch}-`);
          if (!isMatch) {
            fs.unlinkSync(path.join(distDir, file));
            removedCount++;
          }
        }
      }
      if (removedCount > 0) {
        console.log(`Post-build: Removed ${removedCount} non-matching Sentry binaries for target ${buildTarget}`);
      }
    }

    await extensionCtx.dispose();
    await Promise.all(webviewCtxs.map(ctx => ctx.dispose()));
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
