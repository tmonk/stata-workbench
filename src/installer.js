const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Lazy-load vscode to allow tests to mock it before import.
let _vscode;
function getVscode() {
    if (!_vscode) _vscode = require('vscode');
    return _vscode;
}

const INSTALL_SCRIPT_URL = 'https://stata-agent-install.tdmonk.com/install.sh';
const INSTALL_SCRIPT_PS1_URL = 'https://stata-agent-install.tdmonk.com/install.ps1';

// Self-reference so internal calls go through the export object (mockable in tests).
const mod = {};

/**
 * Returns true if the `stata-agent` CLI is available and identifies itself as
 * stata-agent (not Stata Corp's stata binary).
 */
mod.isStataAgentInstalled = function isStataAgentInstalled() {
    const bin = mod.findStataAgentBinary();
    if (!bin) return false;

    try {
        const result = cp.spawnSync(bin, ['--version'], { timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'] });
        if (result.status !== 0) return false;

        const output = (result.stdout?.toString() || '') + (result.stderr?.toString() || '');
        return /stata[_-]agent/i.test(output);
    } catch {
        return false;
    }
};

/**
 * Returns the path to the stata-agent CLI binary if found, else null.
 *
 * Discovery order (no hard-coded paths):
 * 1. STATA_AGENT_PATH env var
 * 2. uv tool bin directory (discovered via `uv tool dir --bin`)
 * 3. stata-agent on PATH (via spawnSync --version)
 *
 * Does NOT use STATA_PATH — that's reserved for the Stata Corp binary.
 */
mod.findStataAgentBinary = function findStataAgentBinary() {
    // 1. STATA_AGENT_PATH env (not STATA_PATH)
    if (process.env.STATA_AGENT_PATH) {
        return process.env.STATA_AGENT_PATH;
    }

    // 2. Discover uv tool bin directory dynamically
    try {
        const result = cp.spawnSync('uv', ['tool', 'dir', '--bin'], {
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 5000,
        });
        if (result.status === 0) {
            const binDir = result.stdout.toString().trim();
            const candidate = process.platform === 'win32'
                ? path.join(binDir, 'stata-agent.exe')
                : path.join(binDir, 'stata-agent');
            if (fs.existsSync(candidate)) return candidate;
        }
    } catch {}

    // 3. Check PATH via spawnSync --version
    try {
        const result = cp.spawnSync('stata-agent', ['--version'], {
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 3000,
        });
        if (result.status === 0) return 'stata-agent';
    } catch {}

    return null;
};

/**
 * Show a VS Code notification offering to install stata-agent.
 * Respects globalState.stataAgentInstallDeclined to avoid re-prompting.
 */
mod.promptInstall = async function promptInstall(context) {
    // Skip if user previously declined
    if (context.globalState.get('stataAgentInstallDeclined')) {
        return;
    }

    const vscode = getVscode();
    const choice = await vscode.window.showInformationMessage(
        'Stata Agent is not installed. Install now?',
        'Install',
        'Not now'
    );

    if (choice === 'Install') {
        const oc = vscode.window.createOutputChannel('Stata Workbench');
        mod.runInstallInTerminal(oc);
    } else if (choice === 'Not now') {
        await context.globalState.update('stataAgentInstallDeclined', true);
    }
};

/**
 * Reset the install prompt so it shows again after "Not now" was selected.
 */
mod.resetInstallPrompt = function resetInstallPrompt(context) {
    context.globalState.update('stataAgentInstallDeclined', false);
};

/**
 * Open an integrated terminal and run the appropriate install script.
 * Sets STATA_AGENT_INSTALL_SOURCE=workbench for telemetry tagging.
 */
mod.runInstallInTerminal = function runInstallInTerminal(outputChannel) {
    const vscode = getVscode();
    const isWin = process.platform === 'win32';
    const term = vscode.window.createTerminal({
        name: 'Install Stata Agent',
        env: { STATA_AGENT_INSTALL_SOURCE: 'workbench' },
    });
    term.show();

    if (isWin) {
        term.sendText(`irm ${INSTALL_SCRIPT_PS1_URL} | iex`);
    } else {
        term.sendText(`curl -LsSf ${INSTALL_SCRIPT_URL} | bash`);
    }

    const stateDir = process.platform === 'win32'
        ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'stata-agent', 'state')
        : path.join(os.homedir(), '.local', 'state', 'stata-agent');
    outputChannel.appendLine(`Install log: ${path.join(stateDir, 'install.log')} (or check terminal output)`);
};

/**
 * Check installation status and emit to the output channel.
 */
mod.checkAndReport = async function checkAndReport(outputChannel) {
    if (mod.isStataAgentInstalled()) {
        const bin = mod.findStataAgentBinary();
        outputChannel.appendLine(`stata-agent is installed (${bin}).`);
    } else {
        outputChannel.appendLine('stata-agent is not installed.');
    }
};

module.exports = mod;
