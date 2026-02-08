// Instrument Sentry must be first to capture all errors
// and ensure native modules find their binaries before evaluation.
require("./instrument.js");
const Sentry = require("@sentry/node");
const path = require('path');
const os = require('os');
const { getVscode } = require('./runtime-context');
const { getEnv, getFs, getChildProcess, getMcpClient } = require('./runtime-context');
const pkg = require('../package.json');
const { TerminalPanel } = require('./terminal-panel');
const { DataBrowserPanel } = require('./data-browser-panel');
const { openArtifact } = require('./artifact-utils');
const { getTmpFilePath, getTmpDir } = require('./fs-utils');

const createDepProxy = (getter) => new Proxy({}, {
    get(_target, prop) {
        const target = getter();
        const value = target?.[prop];
        const isMockFunction = typeof value === 'function' && (value._isMockFunction || value.mock);
        if (typeof value === 'function' && !isMockFunction) {
            return value.bind(target);
        }
        return value;
    },
    set(_target, prop, value) {
        const target = getter();
        if (!target) return false;
        target[prop] = value;
        return true;
    }
});

const vscode = createDepProxy(getVscode);
const fs = createDepProxy(getFs);
const cp = createDepProxy(getChildProcess);
const mcpClient = createDepProxy(() => getMcpClient() || require('./mcp-client').client);

let outputChannel;
let statusBarItem;
let graphPanel = null;
let missingCli = false;
let missingCliPrompted = false;
const MCP_SERVER_ID = 'mcp_stata';
const MCP_PACKAGE_NAME = 'mcp-stata';
const MCP_PACKAGE_SPEC = `${MCP_PACKAGE_NAME}@latest`;
const MISSING_CLI_PROMPT_KEY = 'stata-workbench.missingCliPrompted';
let uvCommand = 'uvx';
let mcpPackageVersion = 'unknown';
let globalExtensionUri = null;
let globalContext = null;

function revealOutput() {
    try {
        const config = vscode.workspace.getConfiguration('stataMcp');
        if (config.get('autoRevealOutput', true)) {
            outputChannel?.show?.(true);
        }
    } catch (_err) {
        // Best effort; never throw from telemetry helpers.
    }
}

/**
 * Log a line to the Output channel and Sentry log buffer.
 */
function appendLine(msg) {
    if (!outputChannel) return;
    outputChannel.appendLine(msg);
    if (typeof global.addLogToSentryBuffer === 'function') {
        global.addLogToSentryBuffer(msg);
    }
}

/**
 * Log a line to the Output channel ONLY if showAllLogsInOutput is enabled.
 * Otherwise, send to Sentry buffer only.
 */
function debugLog(msg) {
    const config = vscode.workspace.getConfiguration('stataMcp');
    if (config.get('showAllLogsInOutput', false)) {
        appendLine(msg);
    } else if (typeof global.addLogToSentryBuffer === 'function') {
        global.addLogToSentryBuffer(msg + '\n');
    }
}

/**
 * Log a string to the Output channel and Sentry log buffer (no newline).
 */
function append(msg) {
    if (!outputChannel) return;
    outputChannel.append(msg);
    if (typeof global.addLogToSentryBuffer === 'function') {
        global.addLogToSentryBuffer(msg);
    }
}

function getOutputLogHandler() {
    const config = vscode.workspace.getConfiguration('stataMcp');
    const showLogsInOutput = !!config.get('showAllLogsInOutput', false);

    return (chunk) => {
        if (!chunk) return;
        if (showLogsInOutput) {
            append(String(chunk));
        } else if (typeof global.addLogToSentryBuffer === 'function') {
            // Keep logs for Sentry even if they aren't shown in Output
            global.addLogToSentryBuffer(String(chunk));
        }
    };
}

function getUvInstallCommand(platform = process.platform) {
    if (platform === 'win32') {
        const display = 'powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "iwr https://astral.sh/uv/install.ps1 -useb | iex"';
        return {
            command: 'powershell',
            args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'iwr https://astral.sh/uv/install.ps1 -useb | iex'],
            display
        };
    }

    const display = 'curl -LsSf https://astral.sh/uv/install.sh | sh';
    return {
        command: 'sh',
        args: ['-c', display],
        display
    };
}

function activate(context) {
    globalContext = context;

    // Use Sentry to track extension lifecycle and environment
    try {
        const version = pkg?.version || 'unknown';
        Sentry.setTag("extension.version", version);
        Sentry.setTag("vscode.version", vscode.version);
        Sentry.setTag("os.platform", process.platform);
        Sentry.setContext("extension", {
            installSource: context.extensionUri.fsPath.includes('.vscode-insiders') ? 'insiders' : 'stable',
            mode: context.extensionMode === vscode.ExtensionMode.Development ? 'development' : 
                  context.extensionMode === vscode.ExtensionMode.Test ? 'test' : 'production'
        });
    } catch (_err) {
        // Telemetry should never crash the extension
    }

    outputChannel = vscode.window.createOutputChannel('Stata Workbench');

    const settings = vscode.workspace.getConfiguration('stataMcp');
    const version = pkg?.version || 'unknown';
    appendLine(`Stata Workbench ready (extension v${version})`);
    missingCliPrompted = !!context.globalState?.get?.(MISSING_CLI_PROMPT_KEY);
    if (!missingCliPrompted && mcpClient.hasConfig()) {
        missingCliPrompted = true;
        context.globalState?.update?.(MISSING_CLI_PROMPT_KEY, true).catch?.(() => { });
    }
    if (typeof mcpClient.setLogger === 'function') {
        mcpClient.setLogger((msg) => {
            const config = vscode.workspace.getConfiguration('stataMcp');
            const showAll = config.get('showAllLogsInOutput', false);
            const logCode = config.get('logStataCode', false);
            
            // Always show our explicit code logs if they are enabled via the opt-in setting
            if (msg.includes('[mcp-stata code]')) {
                if (logCode) {
                    appendLine(msg);
                } else if (typeof global.addLogToSentryBuffer === 'function') {
                    global.addLogToSentryBuffer(msg + '\n');
                }
                return;
            }

            if (showAll) {
                appendLine(msg);
            } else {
                // By default, we suppress the raw mcp-stata stderr logs (which can be very noisy/verbose)
                // but keep them in the Sentry buffer for troubleshooting.
                if (typeof global.addLogToSentryBuffer === 'function') {
                    global.addLogToSentryBuffer(msg + '\n');
                }
                
                // We show connection/starting events and mcp-stata diagnostic logs by default.
                // But we suppress 'stderr' noise from the server process unless showAll is on.
                if (msg.startsWith('[mcp-stata]') && !msg.includes('stderr')) {
                    appendLine(msg);
                } else if (msg.startsWith('Starting mcp-stata') || msg.startsWith('mcp-stata connected')) {
                    appendLine(msg);
                }
            }
        });
    }
    if (typeof mcpClient.setTaskDoneHandler === 'function') {
        mcpClient.setTaskDoneHandler((payload) => {
            if (payload?.runId) {
                TerminalPanel.notifyTaskDone(payload.runId, payload.logPath, payload.logSize, null, payload.rc);
            }
        });
    }
    DataBrowserPanel.setLogger((msg) => appendLine(msg));

    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.text = '$(beaker) Stata Workbench: Idle';
    statusBarItem.tooltip = 'Stata Workbench (powered by mcp-stata)';
    statusBarItem.show();

    const subscriptions = [
        vscode.commands.registerCommand('stata-workbench.runSelection', runSelection),
        vscode.commands.registerCommand('stata-workbench.runFile', runFile),
        vscode.commands.registerCommand('stata-workbench.testMcpServer', testConnection),
        vscode.commands.registerCommand('stata-workbench.viewData', viewData),
        vscode.commands.registerCommand('stata-workbench.installMcpCli', () => promptInstallMcpCli(globalContext, true)),
        vscode.commands.registerCommand('stata-workbench.cancelRequest', cancelRequest),
        mcpClient.onStatusChanged(updateStatusBar)
    ];

    context.subscriptions.push(...subscriptions, statusBarItem, outputChannel);
    globalExtensionUri = context.extensionUri;
    TerminalPanel.setExtensionUri(context.extensionUri);
    TerminalPanel.setLogProvider(async (logPath, offset, maxBytes) => {
        try {
            const exists = !!logPath && fs.existsSync(logPath);
            debugLog(`[LogProvider] request path=${logPath || 'null'} offset=${offset} maxBytes=${maxBytes} exists=${exists}`);
            if (exists) {
                const stats = fs.statSync(logPath);
                const size = stats.size;
                const effectiveOffset = Math.min(offset, size);
                const bytesToRead = Math.min(maxBytes, size - effectiveOffset);

                if (bytesToRead <= 0) {
                    return { data: '', next_offset: effectiveOffset };
                }

                const fd = fs.openSync(logPath, 'r');
                try {
                    const buffer = Buffer.allocUnsafe(bytesToRead);
                    const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, effectiveOffset);
                    const data = buffer.slice(0, bytesRead).toString('utf8');
                    debugLog(`[LogProvider] read bytes=${bytesRead} next_offset=${effectiveOffset + bytesRead} size=${size}`);
                    return {
                        data,
                        next_offset: effectiveOffset + bytesRead
                    };
                } finally {
                    fs.closeSync(fd);
                }
            }
        } catch (err) {
            debugLog(`[LogProvider] Local read failed for ${logPath}: ${err.message || err}`);
        }
        return null;
    });

    // Resolve 'uv' binary (system -> bundled fallback)
    uvCommand = findUvBinary();
    const env = getEnv();
    if (uvCommand && (!env.MCP_STATA_UVX_CMD || env.MCP_STATA_UVX_CMD !== uvCommand)) {
        env.MCP_STATA_UVX_CMD = uvCommand;
    }

    // Load existing config and validate
    const existingServerConfig = mcpClient.getServerConfig();
    const isWorking = isMcpConfigWorking(existingServerConfig);

    if (isWorking) {
        missingCli = false;
        appendLine('Using existing, functional MCP configuration');
    } else {
        if (existingServerConfig?.configPath) {
            appendLine(`Existing MCP config at ${existingServerConfig.configPath} appears broken or missing.`);
        }
        missingCli = !ensureMcpCliAvailable(context);
    }

    if (!missingCli) {
        // Refresh package first so we know if we're "current"
        const refreshed = refreshMcpPackage();
        mcpPackageVersion = refreshed || getMcpPackageVersion();

        const autoConfigureMcp = settings.get('autoConfigureMcp', true);
        if (autoConfigureMcp) {
            // Even if it was "working" before, check if it's still "current" after refresh.
            // If not current, we update the config file to point to the new version/path.
            const isCurrent = isWorking && isMcpConfigCurrent(existingServerConfig, uvCommand, mcpPackageVersion);
            if (!isCurrent) {
                ensureMcpConfigs(context);
            }

            const configureClaudeCode = settings.get('configureClaudeCode', false);
            if (configureClaudeCode) {
                const scope = settings.get('claudeCodeConfigScope', 'user');
                if (isClaudeCodeInstalled()) {
                    const claudeTarget = getClaudeMcpConfigTarget(context, scope);
                    if (!claudeTarget) {
                        appendLine('Skipping Claude Code MCP config update: no target path resolved');
                    } else {
                        const existingClaude = loadMcpConfigFromPath(claudeTarget.configPath);
                        const claudeCurrent = isMcpConfigCurrent(existingClaude, uvCommand, mcpPackageVersion);
                        if (!claudeCurrent) {
                            writeMcpConfig(claudeTarget);
                        }
                    }
                } else {
                    appendLine('Skipping Claude Code MCP config update: claude CLI not detected');
                }
            }
        } else {
            appendLine('Skipping MCP config update: stataMcp.autoConfigureMcp is disabled');
        }
        
        appendLine(`mcp-stata version: ${mcpPackageVersion}`);
        try {
            Sentry.setTag("mcp.version", mcpPackageVersion);
        } catch (_err) { }
    }
    updateStatusBar(missingCli ? 'missing' : 'idle');

    // Startup loading: if enabled, start the Stata session immediately.
    // We don't await this so activation finishes quickly, but the process starts in the background.
    const loadOnStartup = settings.get('loadStataOnStartup', true);
    if (loadOnStartup && !missingCli) {
        mcpClient.connect().catch((err) => {
            appendLine(`[Startup] Failed to load Stata: ${err.message || err}`);
        });
    }

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('stataMcp')) {
                debugLog('[Extension] Config changed, updating MCP client config');
                const config = vscode.workspace.getConfiguration('stataMcp');
                mcpClient.updateConfig({
                    logStataCode: config.get('logStataCode', false)
                });
            }
        })
    );

    // Expose API for testing
    if (context.extensionMode === vscode.ExtensionMode.Test) {
        return {
            TerminalPanel,
            DataBrowserPanel,
            downloadGraphAsPdf,
            mcpClient,
            refreshMcpPackage,
            getUvCommand: () => uvCommand,
            getMcpPackageVersion,
            reDiscoverUv: () => {
                ensureMcpCliAvailable(context);
                return uvCommand;
            },
            isMcpConfigWorking,
            isMcpConfigCurrent,
            logRunToOutput
        };
    }
}

function ensureMcpCliAvailable(context) {
    const env = getEnv();
    const found = findUvBinary();
    if (found) {
        uvCommand = found;
        debugLog(`Using uv binary at: ${uvCommand}`);
        // Only set the env var if it's not already set to this value
        // or if we want to ensure it's propagated to children.
        // For tests, we want to AVOID overwriting a specific path override with "uvx"
        if (!env.MCP_STATA_UVX_CMD || env.MCP_STATA_UVX_CMD !== uvCommand) {
            env.MCP_STATA_UVX_CMD = uvCommand;
        }
        return true;
    }

    const installDir = path.join(context.globalStoragePath, 'uv');
    try {
        fs.mkdirSync(installDir, { recursive: true });
    } catch (_err) {
        // ignore mkdir failures; fall back to prompt
    }

    const installCmd = getUvInstallCommand();
    debugLog('uvx not found on PATH; attempting automatic installation via uv installer.');
    revealOutput();
    const installEnv = { ...env, UV_INSTALL_DIR: installDir };
    const result = cp.spawnSync(installCmd.command, installCmd.args, { env: installEnv, encoding: 'utf8' });

    const installed = findUvBinary(installDir);
    if (result.status === 0 && installed) {
        uvCommand = installed;
        debugLog(`Using uv binary at: ${uvCommand} (automatically installed)`);
        env.MCP_STATA_UVX_CMD = uvCommand;
        return true;
    }

    debugLog('Automatic uv install failed or uvx still missing. You can copy the install command from the prompt.');
    revealOutput();
    promptInstallMcpCli();
    return false;
}

function getMcpPackageVersion() {
    const cmd = uvCommand;
    if (!cmd) return 'unknown';

    const isUv = cmd.endsWith('uv') || cmd.endsWith('uv.exe');
    const baseArgs = isUv ? ['tool', 'run'] : [];

    // 1) Try invoking the CLI with --version (primary method).
    try {
        const args = [...baseArgs, '--from', MCP_PACKAGE_SPEC, MCP_PACKAGE_NAME, '--version'];
        const result = cp.spawnSync(cmd, args, {
            encoding: 'utf8',
            timeout: 5000,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        const stdout = result?.stdout?.toString?.() || '';
        const stderr = result?.stderr?.toString?.() || '';
        const sanitized = sanitizeVersion(stdout) || sanitizeVersion(stderr);
        if (sanitized) return sanitized;
    } catch (_err) {
        // ignore and fall back
    }

    // 2) Fallback to reading metadata via Python (useful if CLI --version fails or is slow).
    try {
        // Use -I (isolated mode) to avoid environment pollution and clear markers to identify the output.
        // We use a marker to pull the exact version out of a potentially polluted stdout.
        const pyCode = "import importlib.metadata; ver = importlib.metadata.version('mcp-stata'); print(f'VERSION_MATCH:{ver}:VERSION_MATCH')";
        const args = [...baseArgs, '--from', MCP_PACKAGE_SPEC, 'python', '-I', '-c', pyCode];
        const pyResult = cp.spawnSync(cmd, args, {
            encoding: 'utf8',
            timeout: 5000,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        const stdout = pyResult?.stdout?.toString?.() || '';
        const sanitized = sanitizeVersion(stdout);
        if (sanitized) return sanitized;
    } catch (_err) {
        // ignore
    }

    return 'unknown';
}

/**
 * Safely extracts a meaningful version string from noisy tool output.
 * Should ignore download progress, logs, and other distractions.
 */
function sanitizeVersion(text) {
    if (!text) return null;

    // 1. Check for explicit markers first if they exist (highest confidence)
    const markerMatch = text.match(/VERSION_MATCH:([vV]?\d+(\.\d+)*([-a-zA-Z0-9.]+)?):VERSION_MATCH/);
    if (markerMatch && markerMatch[1]) {
        return markerMatch[1];
    }

    // 2. Fallback to line-by-line heuristic parsing
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => {
        if (!l) return false;
        // Skip common log/progress prefixes
        if (l.startsWith('[') && l.includes(']')) return false;
        if (l.startsWith('Download')) return false;
        if (l.includes('INFO:') || l.includes('ERROR:') || l.includes('DEBUG:')) return false;

        // A version should at least start with a digit (simple heuristic for "Downloading..." etc)
        return /^[vV]?\d/.test(l);
    });

    if (lines.length === 0) return null;

    // Take the last line that matches the pattern (often tools print logs then the result)
    const candidate = lines[lines.length - 1];

    // Further validate that it looks like a version (X.Y.Z...)
    // Allow basic semver or simple numbers, but NOT long sentences
    if (candidate.length < 50 && /^[vV]?\d+(\.\d+)*([-a-zA-Z0-9.]+)?$/.test(candidate)) {
        return candidate;
    }

    return null;
}

function refreshMcpPackage() {
    const cmd = uvCommand;
    if (!cmd) {
        outputChannel?.appendLine?.('Skipping mcp-stata refresh: uvx not found');
        return null;
    }

    const isUv = cmd.endsWith('uv') || cmd.endsWith('uv.exe');
    const baseArgs = isUv ? ['tool', 'run'] : [];
    const args = [...baseArgs, '--refresh', '--refresh-package', MCP_PACKAGE_NAME, '--from', MCP_PACKAGE_SPEC, MCP_PACKAGE_NAME, '--version'];
    
    try {
        const result = cp.spawnSync(cmd, args, { encoding: 'utf8', timeout: 10000 });
        const stdout = result?.stdout?.toString?.().trim() || '';
        const stderr = result?.stderr?.toString?.().trim() || '';
        
        const sanitized = sanitizeVersion(stdout) || sanitizeVersion(stderr);

        if (result.status === 0) {
            if (sanitized) {
                mcpPackageVersion = sanitized;
            }
            appendLine(`Ensured latest mcp-stata via uvx --refresh --refresh-package mcp-stata (${sanitized || 'version not reported'})`);
            return mcpPackageVersion === 'unknown' ? null : mcpPackageVersion;
        }

        const errText = stdout || stderr;
        appendLine(`Failed to refresh mcp-stata (exit ${result.status}): ${errText}`);
        appendLine('If you are behind a proxy or corporate network, set HTTPS_PROXY/HTTP_PROXY and retry.');
        appendLine('You can also run: uvx --refresh --refresh-package mcp-stata --from mcp-stata@latest mcp-stata --version');
        revealOutput();
    } catch (err) {
        appendLine(`Error refreshing mcp-stata: ${err.message}`);
        appendLine('Network/permission issues can block uv downloads. Check firewall/proxy settings and retry.');
        revealOutput();
    }

    return null;
}

function promptInstallMcpCli(context, force = false) {
    const ctx = context && typeof context.globalState === 'object' ? context : globalContext;
    if (!force && !missingCliPrompted) {
        missingCliPrompted = !!ctx?.globalState?.get?.(MISSING_CLI_PROMPT_KEY);
    }
    if (!force && missingCliPrompted) {
        missingCli = true;
        updateStatusBar('missing');
        return false;
    }

    const installCmd = getUvInstallCommand().display;
    const message = 'uvx (uv) not found on PATH. Install uv to run mcp-stata via uvx.';
    vscode.window.showErrorMessage(
        message,
        'Copy uv install',
        'Open uv docs'
    ).then(async (choice) => {
        if (choice === 'Copy uv install') {
            await vscode.env.clipboard.writeText(installCmd);
            vscode.window.showInformationMessage(`Copied: ${installCmd}`);
        } else if (choice === 'Open uv docs') {
            vscode.env.openExternal(vscode.Uri.parse('https://docs.astral.sh/uv/getting-started/installation/'));
        }
    });
    missingCli = true;
    missingCliPrompted = true;
    ctx?.globalState?.update?.(MISSING_CLI_PROMPT_KEY, true).catch?.(() => { });
    updateStatusBar('missing');
    return false;
}

function findUvBinary(optionalInstallDir) {
    const env = getEnv();
    const base = ['uvx', 'uvx.exe', 'uv', 'uv.exe'];

    // 0. Use environment variable override if specified (e.g. for testing)
    if (env.MCP_STATA_UVX_CMD) {
        return env.MCP_STATA_UVX_CMD;
    }

    // 1. Check system PATH first to respect user-managed installations
    for (const name of base) {
        // Simple test to see if it's on the PATH and executable
        const result = cp.spawnSync(name, ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' });
        const stderr = (result.stderr || '').toString();
        if (!result.error && result.status === 0 && !stderr.includes('command not found')) {
            return name;
        }
    }

    // 2. Check for bundled binary as fallback
    if (globalContext && globalContext.extensionUri && globalContext.extensionUri.fsPath) {
        const platform = process.platform;
        const arch = process.arch;
        const binNames = platform === 'win32' ? ['uvx.exe', 'uv.exe'] : ['uvx', 'uv'];

        for (const binName of binNames) {
            // Try platform-specific subdirectory first
            const platformSpecific = path.join(globalContext.extensionUri.fsPath, 'bin', `${platform}-${arch}`, binName);
            if (fs.existsSync(platformSpecific)) {
                const result = cp.spawnSync(platformSpecific, ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' });
                const stderr = (result.stderr || '').toString();
                if (!result.error && result.status === 0 && !stderr.includes('command not found')) {
                    return platformSpecific;
                }
            }

            // Fallback to generic bin directory
            const genericBundled = path.join(globalContext.extensionUri.fsPath, 'bin', binName);
            if (fs.existsSync(genericBundled)) {
                const result = cp.spawnSync(genericBundled, ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' });
                const stderr = (result.stderr || '').toString();
                if (!result.error && result.status === 0 && !stderr.includes('command not found')) {
                    return genericBundled;
                }
            }
        }
    }

    // 3. Check common installation directories
    const candidates = [];
    const defaultDirs = new Set();
    const home = typeof os.homedir === 'function' ? os.homedir() : null;
    if (home) {
        defaultDirs.add(path.join(home, '.local', 'bin'));
        const localApp = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
        defaultDirs.add(path.join(localApp, 'uv'));
        defaultDirs.add(path.join(localApp, 'uv', 'bin'));
    }

    if (optionalInstallDir) {
        defaultDirs.add(optionalInstallDir);
        defaultDirs.add(path.join(optionalInstallDir, 'bin'));
    }

    for (const dir of defaultDirs) {
        for (const name of base) {
            candidates.push(path.join(dir, name));
        }
    }

    for (const candidate of candidates) {
        const result = cp.spawnSync(candidate, ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' });
        const stderr = (result.stderr || '').toString();
        if (!result.error && result.status === 0 && !stderr.includes('command not found')) {
            return candidate;
        }
    }
    return null;
}

function isMcpConfigWorking(config) {
    if (!config || !config.command) return false;
    try {
        const result = cp.spawnSync(config.command, ['--version'], { encoding: 'utf8', shell: process.platform === 'win32', timeout: 3000 });
        const stderr = (result.stderr || '').toString();
        return !result.error && result.status === 0 && !stderr.includes('command not found');
    } catch (_err) {
        return false;
    }
}

function isClaudeCodeInstalled() {
    try {
        const result = cp.spawnSync('claude', ['--version'], { encoding: 'utf8', shell: process.platform === 'win32', timeout: 3000 });
        const stderr = (result.stderr || '').toString();
        return !result.error && result.status === 0 && !stderr.includes('command not found');
    } catch (_err) {
        return false;
    }
}

/**
 * Checks if the existing MCP config matches what we expect to be "current".
 * If mcp-stata has released a new version, the config might be "working" but not "current".
 */
function isMcpConfigCurrent(config, expectedUv, expectedVersion) {
    if (!config || !config.command || !config.args) return false;
    
    // Check if the command matches our resolved uv command (or is a valid equivalent)
    if (config.command !== expectedUv) {
        // If we expect 'uvx' and they have an absolute path to it, that's fine.
        // But if they have some other command, it's not our "current" preferred setup.
        if (!config.command.includes('uv')) return false;
    }

    // Check args for at least the package and version.
    const argsStr = config.args.join(' ');
    if (!argsStr.includes(MCP_PACKAGE_NAME)) return false;
    
    // If we have a specific version we expect, check for it.
    if (expectedVersion && expectedVersion !== 'unknown') {
        if (!argsStr.includes(expectedVersion) && !argsStr.includes('@latest')) return false;
    }

    return true;
}

function ensureMcpConfigs(context) {
    const target = getMcpConfigTarget(context);
    if (!target) {
        outputChannel?.appendLine?.('Skipping MCP config update: no user-level mcp.json path resolved');
        return;
    }

    writeMcpConfig(target);
}

function resolveWorkspaceRoot(context) {
    if (context?.mcpWorkspaceOverride) return context.mcpWorkspaceOverride;
    return vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || null;
}

function getClaudeMcpConfigTarget(context, scopeOverride) {
    const scope = scopeOverride || 'user';
    const hasHomeOverride = context && Object.prototype.hasOwnProperty.call(context, 'mcpHomeOverride');

    let home;
    if (hasHomeOverride) {
        home = context.mcpHomeOverride;
    } else if (context && context.extensionMode === vscode.ExtensionMode.Test) {
        home = null;
    } else {
        home = os.homedir();
    }

    if (scope === 'project') {
        const workspaceRoot = resolveWorkspaceRoot(context);
        if (!workspaceRoot) return null;
        return {
            configPath: path.join(workspaceRoot, '.mcp.json'),
            writeVscode: false,
            writeCursor: true
        };
    }

    if (!home) return null;
    return {
        configPath: path.join(home, '.claude.json'),
        writeVscode: false,
        writeCursor: true
    };
}

function loadMcpConfigFromPath(configPath) {
    if (!configPath) return { command: null, args: null, env: {}, configPath: null };
    try {
        if (!fs.existsSync(configPath)) {
            return { command: null, args: null, env: {}, configPath };
        }
        const raw = fs.readFileSync(configPath, 'utf8');
        const parsed = safeParseJson(raw);
        const json = parsed.data && typeof parsed.data === 'object' ? parsed.data : {};
        const entry = json?.servers?.[MCP_SERVER_ID] || json?.mcpServers?.[MCP_SERVER_ID];
        if (!entry) {
            return { command: null, args: null, env: {}, configPath };
        }
        const env = (typeof entry.env === 'object' && entry.env !== null) ? entry.env : {};
        return {
            command: entry.command || null,
            args: Array.isArray(entry.args) ? entry.args : null,
            env,
            configPath
        };
    } catch (_err) {
        return { command: null, args: null, env: {}, configPath };
    }
}

function hasExistingMcpConfig(context) {
    const target = getMcpConfigTarget(context);
    if (!target) return false;

    try {
        if (!fs.existsSync(target.configPath)) return false;
        const raw = fs.readFileSync(target.configPath, 'utf8');
        if (!raw) return false;
        const json = JSON.parse(raw);
        return !!(json?.servers?.[MCP_SERVER_ID] || json?.mcpServers?.[MCP_SERVER_ID]);
    } catch (_err) {
        Sentry.captureException(_err);
        return false;
    }
}

function getMcpConfigTarget(context) {
    const appName = (context?.mcpAppNameOverride || vscode.env?.appName || '').toLowerCase();
    const hasHomeOverride = context && Object.prototype.hasOwnProperty.call(context, 'mcpHomeOverride');
    
    // In tests, we must not default to the real home directory unless explicitly requested.
    // This prevents unit tests from accidentally writing to the user's real mcp.json.
    let home;
    if (hasHomeOverride) {
        home = context.mcpHomeOverride;
    } else if (context && context.extensionMode === vscode.ExtensionMode.Test) {
        home = null;
    } else {
        home = os.homedir();
    }

    const overridePath = context?.mcpConfigPath;
    const platform = context?.mcpPlatformOverride || process.platform;
    const resolved = resolveHostMcpPath(appName, home, overridePath, platform, hasHomeOverride);
    if (!resolved) {
        outputChannel?.appendLine?.('Skipping MCP config update: no home directory or host path could be resolved');
        return null;
    }

    const { configPath, prefersCursorFormat } = resolved;
    return {
        configPath,
        // Only one entry per host:
        // - VS Code / Insiders -> servers
        // - Cursor / Windsurf / Antigravity -> mcpServers
        writeVscode: !prefersCursorFormat,
        writeCursor: !!prefersCursorFormat
    };
}

function resolveHostMcpPath(appName, home, overridePath, platform, _hasHomeOverride = false) {
    const env = getEnv();
    if (overridePath) {
        return { configPath: overridePath, prefersCursorFormat: true };
    }

    if (!home) return null;

    const codePath = (codeDir) => {
        if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', codeDir, 'User', 'mcp.json');
        if (platform === 'win32') {
            const envAppData = (env.APPDATA && env.APPDATA !== 'undefined' && env.APPDATA !== 'null' && env.APPDATA !== '')
                ? env.APPDATA
                : null;
            const roaming = envAppData || (home ? path.join(home, 'AppData', 'Roaming') : null);
            if (!roaming) return null;
            return path.join(roaming, codeDir, 'User', 'mcp.json');
        }
        return path.join(home, '.config', codeDir, 'User', 'mcp.json');
    };

    if (appName.includes('cursor')) {
        return { configPath: path.join(home, '.cursor', 'mcp.json'), prefersCursorFormat: true };
    }

    if (appName.includes('windsurf')) {
        const isNext = appName.includes('next');
        const dirName = isNext ? 'windsurf-next' : 'windsurf';
        return { configPath: path.join(home, '.codeium', dirName, 'mcp_config.json'), prefersCursorFormat: true };
    }

    if (appName.includes('antigravity')) {
        if (platform === 'darwin') {
            return { configPath: path.join(home, 'Library', 'Application Support', 'Antigravity', 'User', 'mcp.json'), prefersCursorFormat: true };
        }
        if (platform === 'win32') {
            const roaming = env.APPDATA || path.join(home, 'AppData', 'Roaming');
            return { configPath: path.join(roaming, 'Antigravity', 'User', 'mcp.json'), prefersCursorFormat: true };
        }
        return { configPath: path.join(home, '.antigravity', 'mcp.json'), prefersCursorFormat: true };
    }

    // Default to VS Code family (stable + insiders).
    const isInsiders = appName.includes('insider');
    const codeDir = isInsiders ? 'Code - Insiders' : 'Code';
    return { configPath: codePath(codeDir), prefersCursorFormat: false };
}

function writeMcpConfig(target) {
    const { configPath, writeVscode, writeCursor } = target || {};
    if (!configPath) return;
    if (!writeVscode && !writeCursor) {
        outputChannel?.appendLine?.('Skipping MCP config write: neither VS Code nor cursor-style config selected');
        return;
    }

    try {
        const dir = path.dirname(configPath);
        fs.mkdirSync(dir, { recursive: true });
        const raw = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
        const parsed = safeParseJson(raw);
        if (parsed.error) {
            outputChannel?.appendLine?.(`Skipping MCP config update: could not parse ${configPath} (${parsed.error.message || parsed.error})`);
            return;
        }
        const json = parsed.data && typeof parsed.data === 'object' ? parsed.data : {};

        // Only write the format appropriate for the host app.
        const shouldWriteCursor = !!writeCursor;
        const shouldWriteVscode = !!writeVscode;

        const resolvedCommand = uvCommand || 'uvx';

        // Safeguard: never write a path that looks like a mock to the user's config.
        const isTest = globalContext?.extensionMode === vscode.ExtensionMode.Test;
        if (resolvedCommand.includes('/mock/') && !isTest) {
            outputChannel?.appendLine?.('Skipping MCP config write: resolved command appears to be a mock path');
            return;
        }

        // Use the most current version we've resolved, or fallback to @latest
        const activeSpec = (mcpPackageVersion && mcpPackageVersion !== 'unknown')
            ? `${MCP_PACKAGE_NAME}==${mcpPackageVersion}`
            : MCP_PACKAGE_SPEC;

        const isRunUv = resolvedCommand.endsWith('uv') || resolvedCommand.endsWith('uv.exe');
        const expectedArgs = isRunUv 
            ? ['tool', 'run', '--refresh', '--refresh-package', MCP_PACKAGE_NAME, '--from', activeSpec, MCP_PACKAGE_NAME]
            : ['--refresh', '--refresh-package', MCP_PACKAGE_NAME, '--from', activeSpec, MCP_PACKAGE_NAME];

        const existingCursor = json.mcpServers?.[MCP_SERVER_ID];
        const existingVscode = json.servers?.[MCP_SERVER_ID];

        const mergedEnvForCursor = {
            ...(existingVscode?.env || {}),
            ...(existingCursor?.env || {})
        };
        const mergedEnvForVscode = {
            ...(existingCursor?.env || {}),
            ...(existingVscode?.env || {})
        };

        if (shouldWriteCursor) {
            json.mcpServers = json.mcpServers || {};
            const expectedCursor = {
                command: resolvedCommand,
                args: expectedArgs
            };

            const baseCursor = existingCursor ? { ...existingCursor } : {};
            if (Object.keys(mergedEnvForCursor).length) {
                baseCursor.env = mergedEnvForCursor;
            }

            const nextCursor = mergeConfigEntry(baseCursor, expectedCursor);
            const changed = JSON.stringify(nextCursor) !== JSON.stringify(existingCursor || {});
            json.mcpServers[MCP_SERVER_ID] = nextCursor;
            if (changed) {
                outputChannel?.appendLine?.(`Updated Cursor MCP config at ${configPath} for ${MCP_SERVER_ID}`);
            }

            // Do not touch non-mcp_stata entries. Only remove mcp_stata from the opposite container.
            if (json.servers && json.servers[MCP_SERVER_ID]) {
                delete json.servers[MCP_SERVER_ID];
                outputChannel?.appendLine?.(`Removed VS Code MCP entry for ${MCP_SERVER_ID} to keep single source (Cursor host).`);
            }
        }

        if (shouldWriteVscode) {
            json.servers = json.servers || {};
            const expectedVscode = {
                type: 'stdio',
                command: resolvedCommand,
                args: expectedArgs
            };

            const baseVscode = existingVscode ? { ...existingVscode } : {};
            if (Object.keys(mergedEnvForVscode).length) {
                baseVscode.env = mergedEnvForVscode;
            }

            const nextVscode = mergeConfigEntry(baseVscode, expectedVscode);
            const changed = JSON.stringify(nextVscode) !== JSON.stringify(existingVscode || {});
            json.servers[MCP_SERVER_ID] = nextVscode;
            if (changed) {
                outputChannel?.appendLine?.(`Updated VS Code MCP config at ${configPath} for ${MCP_SERVER_ID}`);
            }

            // Do not touch non-mcp_stata entries. Only remove mcp_stata from the opposite container.
            if (json.mcpServers && json.mcpServers[MCP_SERVER_ID]) {
                delete json.mcpServers[MCP_SERVER_ID];
                outputChannel?.appendLine?.(`Removed Cursor MCP entry for ${MCP_SERVER_ID} to keep single source (VS Code host).`);
            }
        }

        // Clean up empty containers
        if (json.servers && Object.keys(json.servers).length === 0) {
            delete json.servers;
        }
        if (json.mcpServers && Object.keys(json.mcpServers).length === 0) {
            delete json.mcpServers;
        }

        fs.writeFileSync(configPath, JSON.stringify(json, null, 2));

        const hasServers = !!json.servers?.[MCP_SERVER_ID];
        const hasMcpServers = !!json.mcpServers?.[MCP_SERVER_ID];
        if (!hasServers && !hasMcpServers) {
            outputChannel?.appendLine?.(`Warning: MCP config at ${configPath} has no mcp_stata entries after write`);
        }
    } catch (err) {
        console.error('Failed to write MCP config', configPath, err.message);
    }
}

function configsMatch(existing, expected, hasType) {
    if (!existing) return false;
    if (hasType && existing.type !== expected.type) return false;
    if (existing.command !== expected.command) return false;
    if (!Array.isArray(existing.args) || existing.args.length !== expected.args.length) return false;
    return existing.args.every((v, i) => v === expected.args[i]);
}

function safeParseJson(raw) {
    if (!raw) return { data: {} };
    try {
        return { data: JSON.parse(raw) };
    } catch (_err) {
        const stripped = raw
            // Remove // and /* */ comments
            .replace(/\/\*[^]*?\*\//g, '')
            .replace(/(^|\s)\/\/.*$/gm, '')
            // Remove trailing commas before } or ]
            .replace(/,\s*([}\]])/g, '$1');
        try {
            return { data: JSON.parse(stripped) };
        } catch (err) {
            return { data: {}, error: err };
        }
    }
}

function mergeConfigEntry(existing, expected) {
    const base = (existing && typeof existing === 'object') ? { ...existing } : {};
    base.type = expected.type ?? base.type;
    base.command = expected.command ?? base.command;
    base.args = expected.args ?? base.args;
    return base;
}

async function deactivate() {
    mcpClient.dispose();
    try {
        await Sentry.flush(2000);
    } catch (_err) { }
}

function updateStatusBar(status) {
    if (!statusBarItem) return;
    switch (status) {
        case 'queued':
            statusBarItem.text = '$(clock) Stata Workbench: Queued';
            statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
            statusBarItem.command = undefined;
            break;
        case 'running':
            statusBarItem.text = '$(sync~spin) Stata Workbench: Running';
            statusBarItem.backgroundColor = undefined;
            statusBarItem.command = 'stata-workbench.cancelRequest';
            statusBarItem.tooltip = 'Cancel current Stata request';
            break;
        case 'connecting':
            statusBarItem.text = '$(sync~spin) Stata Workbench: Connecting';
            statusBarItem.backgroundColor = undefined;
            statusBarItem.command = undefined;
            break;
        case 'connected':
            statusBarItem.text = '$(beaker) Stata Workbench: Connected';
            statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
            statusBarItem.command = undefined;
            break;
        case 'error':
            statusBarItem.text = '$(error) Stata Workbench: Error';
            statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
            statusBarItem.command = undefined;
            break;
        case 'missing':
            statusBarItem.text = '$(warning) Stata Workbench: uvx missing';
            statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
            statusBarItem.tooltip = 'uvx (uv) not found. Click to copy install command.';
            statusBarItem.command = 'stata-workbench.installMcpCli';
            break;
        default:
            statusBarItem.text = '$(beaker) Stata Workbench: Idle';
            statusBarItem.backgroundColor = undefined;
            statusBarItem.command = undefined;
    }
}

async function refreshDatasetSummary() {
    try {
        const channel = await mcpClient.getUiChannel();
        if (channel && channel.baseUrl && channel.token) {
            const url = `${channel.baseUrl}/v1/dataset`;
            const result = await DataBrowserPanel._performRequest(url, {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${channel.token}` }
            });
            const ds = result.dataset || result;
            if (ds) {
                TerminalPanel.updateDatasetSummary(ds.n, ds.k);
            }
        }
        // Also refresh the data browser if it's open
        DataBrowserPanel.refresh();
    } catch (err) {
        // Silently fail for summary updates
        console.error('[Extension] Failed to refresh dataset summary:', err);
    }
}

async function runSelection() {
    return Sentry.startSpan({ name: 'stata.extension.runSelection', op: 'extension.operation' }, async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('No active editor');
            return;
        }

        const selection = editor.selection;
        let text = selection.isEmpty ? editor.document.lineAt(selection.active.line).text : editor.document.getText(selection);
        if (!text.trim()) {
            vscode.window.showErrorMessage('No text selected or current line is empty');
            return;
        }

        const filePath = editor.document.uri.fsPath;
        const cwd = filePath ? path.dirname(filePath) : null;
        const rawLogHandler = getOutputLogHandler();

        await withStataProgress('Running selection', async (token) => {
            const runId = TerminalPanel.startStreamingEntry(text, filePath, terminalRunCommand, variableListProvider, cancelRequest, cancelTask, downloadGraphAsPdf);
            try {
                const result = await mcpClient.runSelection(text, {
                    runId,
                    onStarted: () => {
                        TerminalPanel.updateStreamingStatus(runId, 'running');
                    },
                    cancellationToken: token,
                    normalizeResult: true,
                    includeGraphs: true,
                    cwd,
                    onRawLog: rawLogHandler,
                    onLog: (chunk) => {
                        if (runId) TerminalPanel.appendStreamingLog(runId, chunk);
                    },
                    onGraphReady: (artifact) => {
                        if (runId) TerminalPanel.appendRunArtifact(runId, artifact);
                    },
                    onProgress: (progress, total, message) => {
                        if (runId) TerminalPanel.updateStreamingProgress(runId, progress, total, message);
                    }
                });
                if (runId) {
                    // Enrich result with logSize if it's missing but we can find it
                    if (result.logPath && (result.logSize === undefined || result.logSize === null)) {
                        try {
                            const exists = fs.existsSync(result.logPath);
                            debugLog(`[RunSelection] logPath=${result.logPath} exists=${exists}`);
                            const stats = fs.statSync(result.logPath);
                            result.logSize = stats.size;
                            debugLog(`[RunSelection] logSize=${result.logSize}`);
                        } catch (_err) { }
                    }
                    logRunToOutput(result, text);
                    TerminalPanel.finishStreamingEntry(runId, result);
                } else {
                    await presentRunResult(text, result, filePath);
                }
                // Update summary after run
                refreshDatasetSummary();
            } catch (error) {
                if (runId) {
                    TerminalPanel.failStreamingEntry(runId, error?.message || String(error));
                }
                throw error;
            }
        }, text);
    });
}

async function runFile() {
    return Sentry.startSpan({ name: 'stata.extension.runFile', op: 'extension.operation' }, async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('No active editor');
            return;
        }

        const filePath = editor.document.uri.fsPath;
        if (!filePath.toLowerCase().endsWith('.do')) {
            vscode.window.showErrorMessage('Not a Stata .do file');
            return;
        }

        const isDirty = editor.document.isDirty;
        const config = vscode.workspace.getConfiguration('stataMcp');
        const behavior = config.get('runFileBehavior', 'runDirtyFile');
        const originalDir = path.dirname(filePath);
        const rawLogHandler = getOutputLogHandler();
        let effectiveFilePath = filePath;
        let tmpFile = null;

        if (isDirty && behavior === 'runDirtyFile') {
            try {
                tmpFile = getTmpFilePath(filePath, globalContext);
                fs.writeFileSync(tmpFile, editor.document.getText(), 'utf8');
                effectiveFilePath = tmpFile;
            } catch (err) {
                vscode.window.showWarningMessage(`Failed to create temporary file for unsaved changes: ${err.message}. Running version on disk instead.`);
            }
        }

        try {
            await withStataProgress(`Running ${path.basename(filePath)}`, async (token) => {
                const commandText = `do "${path.basename(filePath)}"`;
                let taskDoneSeen = false;
                const runId = TerminalPanel.startStreamingEntry(commandText, filePath, terminalRunCommand, variableListProvider, cancelRequest, cancelTask, downloadGraphAsPdf);
                try {
                    const result = await mcpClient.runFile(effectiveFilePath, {
                        cancellationToken: token,
                        normalizeResult: true,
                        includeGraphs: true,
                        cwd: originalDir,
                        runId,
                        onStarted: () => {
                            TerminalPanel.updateStreamingStatus(runId, 'running');
                        },
                        onRawLog: rawLogHandler,
                        onLog: (chunk) => {
                            if (taskDoneSeen) {
                            }
                            if (runId) TerminalPanel.appendStreamingLog(runId, chunk);
                        },
                        onGraphReady: (artifact) => {
                            if (runId) TerminalPanel.appendRunArtifact(runId, artifact);
                        },
                        onTaskDone: (payload) => {
                            taskDoneSeen = true;
                            let logSize = null;
                            const logPath = payload?.logPath || null;
                            let taskDoneStdout = null;
                            if (logPath) {
                                try {
                                    const exists = fs.existsSync(logPath);
                                    debugLog(`[RunFile] task_done logPath=${logPath} exists=${exists}`);
                                    const stats = fs.statSync(logPath);
                                    logSize = stats.size;
                                    if (logSize > 0 && logSize <= 50_000) {
                                        const raw = fs.readFileSync(logPath, 'utf8');
                                        taskDoneStdout = raw;
                                    }
                                    debugLog(`[RunFile] task_done logSize=${logSize}`);
                                } catch (_err) { }
                            }
                            if (runId) TerminalPanel.notifyTaskDone(runId, logPath, logSize, taskDoneStdout, payload?.rc);
                        },
                        onProgress: (progress, total, message) => {
                            if (runId) TerminalPanel.updateStreamingProgress(runId, progress, total, message);
                        }
                    });
                    if (runId) {
                        // Enrich result with logSize if it's missing but we can find it
                        if (result.logPath && (result.logSize === undefined || result.logSize === null)) {
                            try {
                                const exists = fs.existsSync(result.logPath);
                                debugLog(`[RunFile] logPath=${result.logPath} exists=${exists}`);
                                const stats = fs.statSync(result.logPath);
                                result.logSize = stats.size;
                                debugLog(`[RunFile] logSize=${result.logSize}`);
                            } catch (_err) { }
                        }
                        logRunToOutput(result, commandText);
                        TerminalPanel.finishStreamingEntry(runId, result);
                    } else {
                        await presentRunResult(commandText, result, filePath);
                    }
                    // Update summary after run
                    refreshDatasetSummary();
                } catch (error) {
                    if (runId) {
                        TerminalPanel.failStreamingEntry(runId, error?.message || String(error));
                    }
                    throw error;
                }
            });
        } finally {
            if (tmpFile && fs.existsSync(tmpFile)) {
                try {
                    fs.unlinkSync(tmpFile);
                } catch (_err) {
                    // Ignore cleanup errors
                }
            }
        }
    });
}

async function testConnection() {
    return Sentry.startSpan({ name: 'extension.testConnection', op: 'extension.operation' }, async () => {
        await withStataProgress('Testing MCP server', async (token) => {
            const output = await mcpClient.runSelection('di "Hello from mcp-stata!"', { cancellationToken: token });
            vscode.window.showInformationMessage('mcp-stata responded successfully.');
            showOutput(output);
        });
    });
}

function showOutput(content) {
    if (content === undefined || content === null) return;
    const now = new Date().toISOString();
    appendLine(`\n=== ${now} ===`);
    appendLine(typeof content === 'string' ? content : JSON.stringify(content, null, 2));
    const config = vscode.workspace.getConfiguration('stataMcp');
    if (config.get('autoRevealOutput', true)) {
        outputChannel.show(true);
    }
}

// Defines the standard run command used by the Terminal Panel
const terminalRunCommand = async (code, hooks) => {
    try {
        const rawLogHandler = getOutputLogHandler();
        const res = await mcpClient.runSelection(code, {
            normalizeResult: true,
            includeGraphs: true,
            cwd: hooks?.cwd,
            runId: hooks?.runId,
            onStarted: () => {
                if (hooks?.runId) TerminalPanel.updateStreamingStatus(hooks.runId, 'running');
            },
            onRawLog: rawLogHandler,
            onLog: hooks?.onLog,
            onGraphReady: (artifact) => {
                if (hooks?.runId) TerminalPanel.appendRunArtifact(hooks.runId, artifact);
            },
            onTaskDone: (payload) => {
                if (hooks?.onTaskDone) hooks.onTaskDone(payload);
            },
            onProgress: hooks?.onProgress
        });
        refreshDatasetSummary();
        return res;
    } catch (error) {
        return {
            success: false,
            rc: -1,
            stderr: error?.message || String(error),
            error: { message: error?.message || String(error) }
        };
    }
};

// Clear-all convenience for terminal UI
const clearAllCommand = async () => {
    try {
        const rawLogHandler = getOutputLogHandler();
        const res = await mcpClient.runSelection('clear all', {
            normalizeResult: true,
            includeGraphs: false,
            onRawLog: rawLogHandler
        });
        refreshDatasetSummary();
        return res;
    } catch (error) {
        return {
            success: false,
            rc: -1,
            stderr: error?.message || String(error),
            error: { message: error?.message || String(error) }
        };
    }
};

const variableListProvider = async () => {
    try {
        const list = await mcpClient.getVariableList();
        return Array.isArray(list) ? list : [];
    } catch (error) {
        debugLog(`Failed to fetch variable list: ${error?.message || error}`);
        return [];
    }
};

async function showTerminal() {
    const editor = vscode.window.activeTextEditor;
    // We allow opening without an active editor too, but if present we might seed context.

    // Check if there is a selection to pre-fill? 
    // Actually, Terminal Mode usually starts fresh or with specific context.
    // If called via command palette, just open blank.
    // If proper selection logic was here before, we can preserve it.

    // Existing logic tried to run selection. Let's make it optional:
    // If selection exists, run it. If not, just open.

    let initialCode = null;
    let initialResult = null;
    let filePath = editor?.document.uri.fsPath;

    if (editor) {
        const selection = editor.selection;
        const text = !selection.isEmpty ? editor.document.getText(selection) : null;
        if (text && text.trim()) {
            initialCode = text;
            try {
                initialResult = await withStataProgress('Running terminal code', async (token) => {
                    return mcpClient.runSelection(text, { cancellationToken: token, normalizeResult: true, includeGraphs: true });
                }, text);
            } catch (error) {
                initialResult = { success: false, rc: -1, stderr: error?.message || String(error) };
            }
        }
    }

    TerminalPanel.show({
        filePath,
        initialCode,
        initialResult,
        runCommand: terminalRunCommand,
        variableProvider: variableListProvider,
        downloadGraphPdf: downloadGraphAsPdf,
        cancelRun: cancelRequest,
        cancelTask: cancelTask,
        clearAll: clearAllCommand
    });
    refreshDatasetSummary();
}

async function viewData() {
    return Sentry.startSpan({ name: 'extension.viewData', op: 'extension.operation' }, async () => {
        DataBrowserPanel.createOrShow(globalExtensionUri);
    });
}

async function downloadGraphAsPdf(graphName) {
    return Sentry.startSpan({ name: 'extension.downloadGraphAsPdf', op: 'extension.operation' }, async () => {
        try {
            debugLog(`[Download] Starting PDF export for: ${graphName}`);

            // Request PDF export from MCP server
            debugLog('[Download] Calling mcpClient.fetchGraph...');
            const response = await mcpClient.fetchGraph(graphName, { format: 'pdf' });
            debugLog(`[Download] Response received: ${JSON.stringify(response, null, 2)}`);

            let pdfPath = null;
            let savedPath = null;

            if (response?.path || response?.file_path) {
                pdfPath = response.path || response.file_path;
                debugLog(`[Download] Found file path: ${pdfPath}`);
            }

            if (pdfPath && fs.existsSync(pdfPath)) {
                debugLog(`[Download] Reading file from: ${pdfPath}`);
                // If we have a file path, copy it
                const defaultUri = vscode.Uri.file(path.join(os.homedir(), 'Downloads', `${graphName}.pdf`));

                const saveUri = await vscode.window.showSaveDialog({
                    defaultUri,
                    filters: { 'PDF Files': ['pdf'] },
                    saveLabel: 'Save Graph'
                });

                if (saveUri) {
                    debugLog(`[Download] Copying to: ${saveUri.fsPath}`);
                    const buffer = fs.readFileSync(pdfPath);
                    await vscode.workspace.fs.writeFile(saveUri, buffer);
                    debugLog('[Download] Copy complete!');
                    savedPath = saveUri.fsPath;
                } else {
                    debugLog('[Download] User cancelled save dialog');
                    savedPath = pdfPath;
                }
            } else {
                debugLog('[Download] ERROR: No PDF data found in response');
                throw new Error('No PDF data received from server');
            }

            return {
                path: savedPath || pdfPath || response?.path || response?.file_path || response?.url || response?.href || null,
                url: response?.url || response?.href || null,
                label: response?.label || graphName
            };
        } catch (error) {
            const msg = `Failed to download PDF: ${error.message}`;
            debugLog(`[Download] ERROR: ${msg}`);
            debugLog(`[Download] Stack trace: ${error.stack}`);
            // Avoid toasts; surface via output channel only
            throw error;
        }
    });
}

function escapeHtml(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function openGraphPanel(graphDetails) {
    if (!graphPanel) {
        graphPanel = vscode.window.createWebviewPanel(
            'stataGraphs',
            'Stata Graphs',
            vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(globalExtensionUri, 'src', 'ui-shared'),
                    vscode.Uri.joinPath(globalExtensionUri, 'dist', 'ui-shared')
                ]
            }
        );
        graphPanel.onDidDispose(() => { graphPanel = null; });

        // Handle messages from the webview
        graphPanel.webview.onDidReceiveMessage(async (message) => {
            try {
                if (message.type === 'log') {
                    if (message.level === 'error' || message.severity === 'error') {
                        Sentry.captureException(new Error(`Graph Webview Error: ${message.message}`));
                    }
                    debugLog(`[Graph Webview] ${message.message}`);
                    return;
                }

                debugLog(`[Graph Panel] Received message: ${JSON.stringify(message)}`);

                if (!message || typeof message !== 'object') {
                    debugLog('[Graph Panel] Invalid message format');
                    return;
                }

                if (message.command === 'download-graph-pdf' && message.graphName) {
                    debugLog(`[Graph Panel] Processing PDF download for: ${message.graphName}`);
                    await downloadGraphAsPdf(message.graphName);
                } else if (message.type === 'openArtifact' && message.path) {
                    debugLog(`[Graph Panel] Opening artifact: ${message.path}`);
                    openArtifact(message.path, message.baseDir);
                } else {
                    debugLog(`[Graph Panel] Unknown message type: ${message.command || message.type}`);
                }
            } catch (err) {
                debugLog(`[Graph Panel] Message handler error: ${err.message}`);
                vscode.window.showErrorMessage(`Message handler failed: ${err.message}`);
            }
        });
    }

    const nonce = getNonce();
    const html = renderGraphHtml(graphDetails, graphPanel.webview, globalExtensionUri, nonce);
    graphPanel.webview.html = html;
}

function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

function renderGraphHtml(graphDetails, webview, extensionUri, nonce) {
    const designUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'src', 'ui-shared', 'design.css'));
    const mainJsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'ui-shared', 'main.js'));
    const items = Array.isArray(graphDetails) ? graphDetails : [];

    const tiles = items.map(g => {
        const name = escapeHtml(g.name || g.label || 'graph');
        const preview = g.path || '';
        const canPreview = preview && preview.toLowerCase().endsWith('.svg');

        const error = g.error
            ? `<div class="artifact-tile-error">Error: ${escapeHtml(g.error)}</div>`
            : '';

        const thumbHtml = canPreview
            ? `<img src="file://${preview}" class="artifact-thumb-img" alt="${name}">`
            : `<div class="artifact-thumb-fallback">File</div>`;

        // Make tile clickable to open modal
        const dataPath = escapeHtml(preview);
        const baseDir = g.baseDir || '';

        return `<div class="artifact-tile" data-action="open-modal" data-path="${dataPath}" data-basedir="${escapeHtml(baseDir)}" data-label="${name}">
          ${thumbHtml}
          <div class="artifact-tile-label">${name}</div>
          ${error}
        </div>`;
    }).join('');

    const gridHtml = tiles || '<div class="text-muted">No graphs available</div>';

    // CSP: Allow scripts, styles, and connect to localhost (for API) + Sentry
    const csp = `
      default-src 'none'; 
      img-src ${webview.cspSource} https: data: file:; 
      script-src 'nonce-${nonce}' ${webview.cspSource} blob:; 
      worker-src 'self' blob:;
      style-src 'unsafe-inline' ${webview.cspSource} https://unpkg.com; 
      font-src ${webview.cspSource} https://unpkg.com; 
      connect-src ${webview.cspSource} http://127.0.0.1:* https://o4510744386732032.ingest.de.sentry.io;
    `.replace(/\s+/g, ' ').trim();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <link rel="stylesheet" href="${designUri}">
  <title>Stata Graphs</title>
  <style nonce="${nonce}">
    body { padding: var(--space-md); }
    .hidden { display: none !important; }
  </style>
</head>
<body>
  <div class="header" style="margin-bottom:var(--space-md);">
     <span class="font-bold" style="font-size:16px;">Stata Graphs</span>
  </div>
  <div class="artifact-gallery">
    ${gridHtml}
  </div>

  <!-- Modal HTML -->
  <div id="artifact-modal" class="artifact-modal hidden" aria-hidden="true">
    <div class="artifact-modal-overlay"></div>
    <div class="artifact-modal-panel">
        <div class="artifact-modal-header">
            <span id="artifact-modal-title" class="artifact-modal-title">Graph</span>
            <button id="artifact-modal-close" class="btn btn-secondary" aria-label="Close">×</button>
        </div>
        <div class="artifact-modal-body">
            <img id="artifact-modal-img" class="artifact-modal-img" src="" alt="Graph">
            <div id="artifact-modal-meta" class="artifact-modal-meta"></div>
        </div>
        <div class="artifact-modal-actions">
            <button id="artifact-modal-download" class="btn btn-primary">Download PDF</button>
            <button id="artifact-modal-close-footer" class="btn btn-secondary">Close</button>
        </div>
    </div>
  </div>

  <script nonce="${nonce}" src="${mainJsUri}"></script>
  <script nonce="${nonce}">
     const vscode = acquireVsCodeApi();
     
     // Modal elements
     const modal = document.getElementById('artifact-modal');
     const modalTitle = document.getElementById('artifact-modal-title');
     const modalImg = document.getElementById('artifact-modal-img');
     const modalMeta = document.getElementById('artifact-modal-meta');
     const modalDownloadBtn = document.getElementById('artifact-modal-download');
     const modalCloseBtn = document.getElementById('artifact-modal-close');
     const modalCloseFooterBtn = document.getElementById('artifact-modal-close-footer');
     let activeModalArtifact = null;

     console.log('[Modal] Modal script loaded, vscode API:', typeof vscode);
     console.log('[Modal] Download button found:', !!modalDownloadBtn);

     function openArtifactModal(artifact) {
         activeModalArtifact = artifact;
         if (modalTitle) modalTitle.textContent = artifact.label || 'Graph';
         if (modalImg) {
             modalImg.src = artifact.src || '';
             modalImg.alt = artifact.label || 'Graph';
         }
         if (modalMeta) {
             modalMeta.textContent = artifact.path || '';
         }
         if (modalDownloadBtn) {
             const ok = artifact.label || artifact.name;
             modalDownloadBtn.disabled = !ok;
             modalDownloadBtn.style.opacity = ok ? '1' : '0.6';
         }
         if (modal) {
             modal.classList.remove('hidden');
             modal.setAttribute('aria-hidden', 'false');
         }
     }

     function closeArtifactModal() {
         activeModalArtifact = null;
         if (modal) {
             modal.classList.add('hidden');
             modal.setAttribute('aria-hidden', 'true');
         }
         if (modalImg) modalImg.src = '';
     }

     // Download button handler
     if (modalDownloadBtn) {
         modalDownloadBtn.addEventListener('click', async () => {
             console.log('[Modal] Download button clicked');
             
             if (!activeModalArtifact) {
                 console.error('[Modal] No active artifact');
                 return;
             }
             
             const graphName = activeModalArtifact.label || activeModalArtifact.name;
             console.log('[Modal] Graph name:', graphName);
             
             if (!graphName) {
                 console.error('[Modal] No graph name found');
                 return;
             }
             
             try {
                 const originalText = modalDownloadBtn.textContent;
                 modalDownloadBtn.disabled = true;
                 modalDownloadBtn.textContent = 'Downloading...';
                 
                 console.log('[Modal] Sending download-graph-pdf message:', graphName);
                 vscode.postMessage({
                     command: 'download-graph-pdf',
                     graphName: graphName
                 });
                 console.log('[Modal] Message sent successfully');
                 
                 setTimeout(() => {
                     modalDownloadBtn.disabled = false;
                     modalDownloadBtn.textContent = originalText;
                     console.log('[Modal] Button reset');
                 }, 3000);
             } catch (err) {
                 console.error('[Modal] Download error:', err);
                 modalDownloadBtn.disabled = false;
                 modalDownloadBtn.textContent = 'Download PDF';
             }
         });
     }

     // Close button handlers
     if (modalCloseBtn) {
         modalCloseBtn.addEventListener('click', closeArtifactModal);
     }
     if (modalCloseFooterBtn) {
         modalCloseFooterBtn.addEventListener('click', closeArtifactModal);
     }

     // Close on overlay click
     if (modal) {
         modal.addEventListener('click', (e) => {
             if (e.target === modal || e.target.classList.contains('artifact-modal-overlay')) {
                 closeArtifactModal();
             }
         });
     }

     // Close on escape key
     document.addEventListener('keydown', (e) => {
         if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
             closeArtifactModal();
         }
     });

     // Tile click handlers - open modal
     document.querySelectorAll('[data-action="open-modal"]').forEach(tile => {
         tile.addEventListener('click', () => {
             const label = tile.getAttribute('data-label');
             const path = tile.getAttribute('data-path');
             const src = tile.querySelector('img')?.src || path;
             
             console.log('[Modal] Opening modal for:', label);
             openArtifactModal({ label, name: label, src, path });
         });
     });

     // Also bind old artifact events if they exist
     if (window.stataUI && window.stataUI.bindArtifactEvents) {
         window.stataUI.bindArtifactEvents(vscode);
     }
  </script>
</body></html>`;
}

async function withStataProgress(title, task, sample) {
    const hints = sample && sample.length > 180 ? `${sample.slice(0, 180)}…` : sample;
    try {
        const result = await task(null);
        return result;
    } catch (error) {
        const detail = error?.message || String(error);
        const isMissingCli = detail.includes('uvx') || detail.includes('ENOENT') || detail.includes('not found') || detail.includes('not recognized');

        if (isMissingCli) {
            vscode.window.showErrorMessage(
                `${title} failed: uvx (uv) not found on PATH. Install uv to run mcp-stata.`,
                'Install uv'
            ).then(choice => {
                if (choice === 'Install uv') {
                    promptInstallMcpCli(globalContext, true);
                }
            });
        } else {
            vscode.window.showErrorMessage(`${title} failed: ${detail}${hints ? ` (snippet: ${hints})` : ''}`);
        }
        showOutput(error?.stack || detail);
        throw error;
    }
}

function isStataFailure(result) {
    if (!result || typeof result !== 'object') return false;
    if (result.success === false) return true;
    if (typeof result.rc === 'number' && result.rc !== 0) return true;
    if (result.error) return true;
    return false;
}

function presentStataError(context, payload) {
    const rc = payload?.rc ?? payload?.error?.rc;
    const message = payload?.error?.message || payload?.message || 'Stata reported an error';
    const command = payload?.command || payload?.error?.command;
    const snippet = payload?.error?.snippet || payload?.stdout;
    const detailParts = [];
    if (command) detailParts.push(`cmd: ${command}`);
    if (typeof rc === 'number') detailParts.push(`rc=${rc}`);
    const detail = detailParts.length ? ` (${detailParts.join(' | ')})` : '';
    const summary = `${context}${detail}: ${message}`;

    outputChannel.appendLine(`\n=== ${new Date().toISOString()} — ${context} ===`);
    outputChannel.appendLine(typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2));
    if (snippet) {
        outputChannel.appendLine('--- snippet ---');
        outputChannel.appendLine(snippet);
    }

    vscode.window.showErrorMessage(summary, 'Show Stata output').then((choice) => {
        if (choice === 'Show Stata output') {
            outputChannel.show(true);
        }
    });
}

// Unified presentation using Terminal Panel
async function presentRunResult(commandText, result, filePath) {
    const success = isRunSuccess(result);
    // Log to output channel regardless of UI type
    logRunToOutput(result, commandText);

    // Ensure terminal panel is showing the new entry, initializing if needed with the proper runner
    TerminalPanel.addEntry(commandText, result, filePath, terminalRunCommand, variableListProvider);
}

function logRunToOutput(result, contextTitle) {
    const config = vscode.workspace.getConfiguration('stataMcp');
    const logCode = !!config.get('logStataCode', false);
    const showAll = !!config.get('showAllLogsInOutput', false);

    // If successful and logging is off, we suppress the verbose summary in Output
    // (since it's already in the Terminal Panel). Failures are always shown.
    const isSuccess = isRunSuccess(result);
    if (isSuccess && !logCode && !showAll) {
        return;
    }

    const now = new Date().toISOString();
    outputChannel.appendLine(`\n=== ${now} — ${contextTitle} ===`);
    if (!result) {
        outputChannel.appendLine('No result from Stata.');
        return;
    }

    if (result.command) outputChannel.appendLine(`cmd: ${result.command}`);
    if (typeof result.rc === 'number') outputChannel.appendLine(`rc: ${result.rc}`);
    if (typeof result.durationMs === 'number') outputChannel.appendLine(`duration: ${formatDuration(result.durationMs)}`);
    if (result.logPath) outputChannel.appendLine(`logPath: ${result.logPath}`);
    if (Array.isArray(result.graphArtifacts) && result.graphArtifacts.length) {
        outputChannel.appendLine(`graphs: ${result.graphArtifacts.map(g => g.label || g.path || '').join(', ')}`);
    }
    if (result.stdout) {
        outputChannel.appendLine(result.stdout);
    } else if (result.stderr) {
        outputChannel.appendLine(result.stderr);
    } else if (result?.error?.snippet) {
        outputChannel.appendLine(result.error.snippet);
    } else if (result?.error?.message) {
        outputChannel.appendLine(result.error.message);
    } else if (typeof result === 'string') {
        outputChannel.appendLine(result);
    } else {
        outputChannel.appendLine(JSON.stringify(result, null, 2));
    }
    if (result.stderr) {
        outputChannel.appendLine('--- stderr ---');
        outputChannel.appendLine(result.stderr);
    }
}

function formatDuration(ms) {
    if (ms === null || ms === undefined) return '';
    if (ms < 1000) return `${ms} ms`;
    const seconds = ms / 1000;
    if (seconds < 60) return `${seconds.toFixed(1)} s`;
    const minutes = Math.floor(seconds / 60);
    const rem = seconds - minutes * 60;
    return `${minutes}m ${rem.toFixed(0)}s`;
}

function isRunSuccess(result) {
    if (!result) return false;
    if (result.success === false) return false;
    if (typeof result.rc === 'number' && result.rc !== 0) return false;
    if (result.error) return false;
    return true;
}

async function cancelRequest() {
    console.log('[Extension] cancelRequest called');
    try {
        const cancelled = await mcpClient.cancelAll();
        // Suppress toast notifications; rely on panel status/logs instead.
        if (!cancelled) {
            console.log('[Extension] No running Stata requests to cancel.');
        }
    } catch (error) {
        console.error('[Extension] Cancel failed:', error);
        // Keep error visible to aid debugging, but avoid duplicate info toasts.
        vscode.window.showErrorMessage('Failed to cancel: ' + error.message);
    }
}

async function cancelTask(runId) {
    console.log('[Extension] cancelTask called:', runId);
    try {
        await mcpClient.cancelRun(runId);
    } catch (error) {
        console.warn('[Extension] cancelTask failed:', error);
    }
}

module.exports = {
    activate,
    deactivate,
    refreshMcpPackage,
    writeMcpConfig,
    getUvInstallCommand,
    promptInstallMcpCli,
    hasExistingMcpConfig,
    getMcpConfigTarget,
    getClaudeMcpConfigTarget,
    downloadGraphAsPdf,
    mcpClient,
    DataBrowserPanel,
    findUvBinary,
    isMcpConfigWorking,
    isMcpConfigCurrent
};