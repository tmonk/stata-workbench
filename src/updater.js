const cp = require('child_process');

/**
 * Run `stata-agent upgrade --quiet` and report result.
 *
 * All version comparison, locking, and re-exec is handled by the CLI.
 * The workbench does NOT implement its own version comparison or PyPI fetch.
 *
 * @param {object} context - VS Code extension context (for globalState)
 * @param {object} outputChannel - VS Code output channel
 * @returns {Promise<{upgraded: boolean, reason?: string}>}
 */
async function checkAndUpgrade(context, outputChannel) {
    // Lazy-require installer inside the function so tests can mock before call.
    const installer = require('./installer');
    const bin = installer.findStataAgentBinary();

    if (!bin) {
        return { upgraded: false, reason: 'not_installed' };
    }

    const result = cp.spawnSync(bin, ['upgrade', '--quiet'], {
        env: { ...process.env, STATA_AGENT_INSTALL_SOURCE: 'workbench' },
        timeout: 35000,
    });

    if (result.status === 0) {
        outputChannel.appendLine('stata-agent is up to date.');
        return { upgraded: true };
    }

    const reason = result.stderr?.toString() || result.error?.message || 'unknown';
    outputChannel.appendLine(`stata-agent upgrade failed: ${reason}`);

    // Store failure timestamp for 24 h suppression in extension.js
    await context.globalState.update('lastUpgradeFailedTs', Date.now());

    return { upgraded: false, reason };
}

module.exports = { checkAndUpgrade };
