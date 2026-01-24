const os = require('os');
const fs = require('fs');
const path = require('path');
const Sentry = require("@sentry/node");

let cachedTmpDir = null;

/**
 * Check if a directory is writable by attempting to create and delete a tiny sentinel file.
 * @param {string} dir Path to check
 * @returns {boolean}
 */
function isWritable(dir) {
    if (!dir) return false;
    try {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        const sentinel = path.join(dir, `.stata_writable_test_${Math.random().toString(36).slice(2, 10)}`);
        fs.writeFileSync(sentinel, 'test');
        fs.unlinkSync(sentinel);
        return true;
    } catch (_err) {
        return false;
    }
}

/**
 * Get a writable temporary directory.
 * Prioritizes:
 * 1. os.tmpdir()
 * 2. Extension storage path (if context provided)
 * 3. ~/.stata-workbench/tmp
 * 
 * @param {object} context VS Code extension context (optional)
 * @returns {string} Writable directory path
 */
function getTmpDir(context = null) {
    if (cachedTmpDir && isWritable(cachedTmpDir)) {
        return cachedTmpDir;
    }

    const candidates = [];

    // 1. System temp dir
    candidates.push(os.tmpdir());

    // 2. Local extension storage
    if (context && context.extensionStorageUri && context.extensionStorageUri.scheme === 'file') {
        candidates.push(context.extensionStorageUri.fsPath);
    }

    // 3. Home directory fallback
    const homeDir = os.homedir();
    if (homeDir) {
        candidates.push(path.join(homeDir, '.stata-workbench', 'tmp'));
    }

    for (const dir of candidates) {
        if (isWritable(dir)) {
            cachedTmpDir = path.normalize(dir);
            return cachedTmpDir;
        }
    }

    const errorMsg = `Could not find a writable temporary directory. Checked: ${candidates.join(', ')}`;
    Sentry.captureMessage(errorMsg, 'error');
    throw new Error(errorMsg);
}

/**
 * Generate a standard temporary file path.
 * @param {string} originalName Base filename
 * @param {object} context VS Code extension context (optional)
 * @returns {string} Full path to temporary file
 */
function getTmpFilePath(originalName, context = null) {
    const tmpDir = getTmpDir(context);
    const fileName = `stata_tmp_${Date.now()}_${path.basename(originalName)}`;
    return path.join(tmpDir, fileName);
}

module.exports = {
    getTmpDir,
    getTmpFilePath,
    isWritable
};
