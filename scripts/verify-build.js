const fs = require('fs');
const path = require('path');

const distDir = path.join(__dirname, '..', 'dist');
const extensionJs = path.join(distDir, 'extension.js');

if (!fs.existsSync(extensionJs)) {
    console.error('ERROR: dist/extension.js not found. Run build first.');
    process.exit(1);
}

// Check for native modules if sentry is used
const files = fs.readdirSync(distDir);
const nodeFiles = files.filter(f => f.endsWith('.node'));

if (nodeFiles.length === 0) {
    console.warn('WARNING: No .node files found in dist/. If Sentry profiling is enabled, this will cause activation to fail.');
} else {
    console.log(`Found ${nodeFiles.length} native modules in dist/.`);
}

// Check for webview assets
const uiSharedDir = path.join(distDir, 'ui-shared');
if (!fs.existsSync(uiSharedDir) || fs.readdirSync(uiSharedDir).length === 0) {
    console.error('ERROR: dist/ui-shared/ is missing or empty. Webview will fail.');
    process.exit(1);
}

console.log('Build verification passed.');
