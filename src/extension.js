// Instrument Sentry must be first to capture all errors
// and ensure native modules find their binaries before evaluation.
require("./instrument.js");
const Sentry = require("@sentry/node");
const path = require('path');
const os = require('os');
const { getVscode, getEnv, getFs, getChildProcess, getMcpClient, createDepProxy } = require('./runtime-context');
const { DaemonManager } = require('./daemon-manager');
const { StataClient } = require('./stata-client');
const pkg = require('../package.json');
const { TerminalPanel } = require('./terminal-panel');
const { DataBrowserPanel } = require('./data-browser-panel');
const { openArtifact } = require('./artifact-utils');
const { HelpPanel } = require('./help-panel');
const { getTmpFilePath, getTmpDir } = require('./fs-utils');

const vscode = createDepProxy(getVscode);
const fs = createDepProxy(getFs);
const cp = createDepProxy(getChildProcess);
const mcpClient = createDepProxy(() => getMcpClient() || require('./mcp-client').client);

let daemonMgr = null;
let stataClient = null;
const moduleExports = {
    daemonMgr: null,
    stataClient: null,
};

let outputChannel;
let statusBarItem;
let graphPanel = null;
let globalExtensionUri = null;
let globalContext = null;

function revealOutput() {
    try {
        const config = vscode.workspace.getConfiguration('stata');
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
    const config = vscode.workspace.getConfiguration('stata');
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
    const config = vscode.workspace.getConfiguration('stata');
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

function migrateSettings() {
    try {
        const old = vscode.workspace.getConfiguration('stataMcp');
        const neo = vscode.workspace.getConfiguration('stata');
        const keys = [
            'requestTimeoutMs', 'loadStataOnStartup', 'autoRevealOutput',
            'showAllLogsInOutput', 'logStataCode', 'runFileWorkingDirectory',
            'stataPath', 'setupTimeoutSeconds', 'noReloadOnClear',
            'maxOutputLines', 'runFileBehavior', 'defaultVariableLimit',
        ];
        for (const key of keys) {
            const val = typeof old.inspect === 'function' ? old.inspect(key) : undefined;
            const neov = typeof neo.inspect === 'function' ? neo.inspect(key) : undefined;
            if (val?.globalValue !== undefined &&
                neov?.globalValue === undefined) {
                neo.update(key, val.globalValue, vscode.ConfigurationTarget.Global);
            }
        }
    } catch (_err) {
        // Best-effort migration; never block activation
    }
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

    migrateSettings();
    daemonMgr = moduleExports.daemonMgr = new DaemonManager();
    stataClient = moduleExports.stataClient = new StataClient(daemonMgr);
    DataBrowserPanel._stataClient = stataClient;

    outputChannel = vscode.window.createOutputChannel('Stata Workbench');

    const version = pkg?.version || 'unknown';
    const isLocal = context.extensionMode === vscode.ExtensionMode.Development ||
        (context.extensionUri?.fsPath && context.extensionUri.fsPath.includes('stata-workbench-debug'));
    appendLine(`Stata Workbench ready (extension v${version}${isLocal ? ' (local)' : ''})`);

    stataClient.on('status', updateStatusBar);
    stataClient.on('error', (err) => {
        appendLine(`[stata] Client error: ${err.message}`);
    });

    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.text = '$(beaker) Stata: Initializing';
    statusBarItem.tooltip = 'Stata Workbench';
    statusBarItem.show();

    const subscriptions = [
        vscode.commands.registerCommand('stata-workbench.runSelection', runSelection),
        vscode.commands.registerCommand('stata-workbench.runFile', runFile),
        vscode.commands.registerCommand('stata-workbench.restartDaemon', async () => {
            await daemonMgr.stop('default');
            await daemonMgr.ensureRunning('default');
            appendLine('Daemon restarted');
        }),
        vscode.commands.registerCommand('stata-workbench.showDaemonStatus', async () => {
            const health = await daemonMgr.health('default');
            if (health) {
                appendLine(`Daemon: running (PID ${health.pid}, sessions: ${(health.sessions || []).join(', ')})`);
            } else {
                appendLine('Daemon: not running');
            }
        }),
        vscode.commands.registerCommand('stata-workbench.viewData', viewData),
        vscode.commands.registerCommand('stata-workbench.cancelRequest', cancelRequest),
        vscode.commands.registerCommand('stata-workbench.openTerminal', openTerminal),
    ];

    TerminalPanel.setHandlersFactory(() => ({
        runCommand: terminalRunCommand,
        variableProvider: variableListProvider,
        downloadGraphPdf: downloadGraphAsPdf,
        openHelpPanel: (helpPath, helpLabel) => {
            try {
                const content = fs.readFileSync(helpPath, 'utf8');
                HelpPanel.show(globalExtensionUri, helpLabel || 'Stata Help', content);
            } catch (err) {
                debugLog(`[Extension] openHelpPanel failed: ${err.message}`);
            }
        },
        cancelRun: cancelRequest,
        cancelTask: cancelTask,
        clearAll: clearAllCommand
    }));

    if (vscode.window.registerWebviewPanelSerializer) {
        vscode.window.registerWebviewPanelSerializer('stataTerminal', {
            async deserializeWebviewPanel(webviewPanel, state) {
                TerminalPanel.restorePanel(webviewPanel, state);
            }
        });
    }

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

    const config = vscode.workspace.getConfiguration('stata');
    if (config.get('loadStataOnStartup')) {
        daemonMgr.ensureRunning('default').catch(e => appendLine(`[stata] Startup: ${e.message}`));
    }

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('stata')) {
                debugLog('[Extension] Config changed');
            }
        })
    );

    // Expose API for testing
    if (context.extensionMode === vscode.ExtensionMode.Test) {
        return {
            TerminalPanel,
            DataBrowserPanel,
            daemonMgr,
            stataClient,
        };
    }
}

async function deactivate() {
    if (typeof global.setStataWorkbenchShuttingDown === 'function') {
        global.setStataWorkbenchShuttingDown();
    }
    if (daemonMgr) await daemonMgr.stop('default');
    try {
        await Sentry.flush(2000);
    } catch (_err) { }
}

function updateStatusBar(status) {
    if (!statusBarItem) return;
    switch (status) {
        case 'connecting':
        case 'reconnecting':
            statusBarItem.text = '$(loading~spin) Stata: Starting';
            statusBarItem.backgroundColor = undefined;
            statusBarItem.command = undefined;
            break;
        case 'connected':
        case 'idle':
            statusBarItem.text = '$(check) Stata: Ready';
            statusBarItem.backgroundColor = undefined;
            statusBarItem.command = 'stata-workbench.showDaemonStatus';
            statusBarItem.tooltip = 'Stata daemon running';
            break;
        case 'running':
            statusBarItem.text = '$(loading~spin) Stata: Running';
            statusBarItem.backgroundColor = undefined;
            statusBarItem.command = 'stata-workbench.cancelRequest';
            statusBarItem.tooltip = 'Cancel current Stata request';
            break;
        case 'disconnected':
            statusBarItem.text = '$(circle-slash) Stata: Not running';
            statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
            statusBarItem.command = 'stata-workbench.restartDaemon';
            statusBarItem.tooltip = 'Click to restart daemon';
            break;
        default:
            statusBarItem.text = '$(beaker) Stata: Initializing';
            statusBarItem.backgroundColor = undefined;
            statusBarItem.command = undefined;
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

        await withStataProgress('Running selection', async (token) => {
            const runId = TerminalPanel.startStreamingEntry(text, filePath, terminalRunCommand, variableListProvider, cancelRequest, cancelTask, downloadGraphAsPdf);
            try {
                const result = await stataClient.runCode(text, {
                    sessionName: 'default',
                    echo: true,
                    strict: false,
                    cwd,
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
        const config = vscode.workspace.getConfiguration('stata');
        const behavior = config.get('runFileBehavior', 'runDirtyFile');
        const originalDir = path.dirname(filePath);
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
                const runId = TerminalPanel.startStreamingEntry(commandText, filePath, terminalRunCommand, variableListProvider, cancelRequest, cancelTask, downloadGraphAsPdf);
                try {
                    const result = await stataClient.runFile(effectiveFilePath, {
                        sessionName: 'default',
                        cwd: originalDir,
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

async function openTerminal() {
    return Sentry.startSpan({ name: 'stata.extension.openTerminal', op: 'extension.operation' }, async () => {
        const editor = vscode.window.activeTextEditor;
        const filePath = editor?.document?.uri?.fsPath || null;
        const runId = null; // No active run yet

        TerminalPanel.show({
            filePath,
            initialCode: null,
            initialResult: null,
            runCommand: terminalRunCommand,
            variableProvider: variableListProvider,
            downloadGraphPdf: downloadGraphAsPdf,
            openHelpPanel: (helpPath, helpLabel) => {
                try {
                    const content = fs.readFileSync(helpPath, 'utf8');
                    HelpPanel.show(globalExtensionUri, helpLabel || 'Stata Help', content);
                } catch (err) {
                    debugLog(`[Extension] openHelpPanel failed: ${err.message}`);
                }
            },
            cancelRun: cancelRequest,
            cancelTask: cancelTask,
            clearAll: clearAllCommand
        });
    });
}

async function testConnection() {
    return Sentry.startSpan({ name: 'extension.testConnection', op: 'extension.operation' }, async () => {
        await withStataProgress('Testing Stata', async (token) => {
            const output = await stataClient.runCode('di "Hello from Stata!"', { sessionName: 'default' });
            vscode.window.showInformationMessage('Stata responded successfully.');
            showOutput(output);
        });
    });
}

function showOutput(content) {
    if (content === undefined || content === null) return;
    const now = new Date().toISOString();
    appendLine(`\n=== ${now} ===`);
    appendLine(typeof content === 'string' ? content : JSON.stringify(content, null, 2));
    const config = vscode.workspace.getConfiguration('stata');
    if (config.get('autoRevealOutput', true)) {
        outputChannel.show(true);
    }
}

// Defines the standard run command used by the Terminal Panel
const terminalRunCommand = async (code, hooks) => {
    try {
        const res = await stataClient.runCode(code, {
            sessionName: 'default',
            echo: true,
            strict: false,
            maxOutputTokens: 0,
        });
        return res;
    } catch (error) {
        return {
            ok: false,
            rc: -1,
            stdout: '',
            error: { message: error?.message || String(error) }
        };
    }
};

// Clear-all convenience for terminal UI
const clearAllCommand = async () => {
    try {
        const res = await stataClient.runCode('clear all', {
            sessionName: 'default',
        });
        return res;
    } catch (error) {
        return {
            ok: false,
            rc: -1,
            stdout: '',
            error: { message: error?.message || String(error) }
        };
    }
};

const variableListProvider = async () => {
    try {
        const list = await stataClient.listVariables();
        return Array.isArray(list) ? list : [];
    } catch (error) {
        debugLog(`Failed to fetch variable list: ${error?.message || error}`);
        return [];
    }
};

async function viewData() {
    return Sentry.startSpan({ name: 'extension.viewData', op: 'extension.operation' }, async () => {
        DataBrowserPanel.createOrShow(globalExtensionUri);
    });
}

async function downloadGraphAsPdf(graphName, baseDir) {
    return Sentry.startSpan({ name: 'extension.downloadGraphAsPdf', op: 'extension.operation' }, async () => {
        try {
            const pdfPath = await stataClient.exportGraph(graphName, 'pdf', baseDir);
            return { path: pdfPath.file_path, url: null, label: graphName };
        } catch (error) {
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
                    debugLog(`[Graph Panel] Processing PDF download for: ${message.graphName} (baseDir: ${message.baseDir})`);
                    await downloadGraphAsPdf(message.graphName, message.baseDir);
                } else if (message.type === 'openArtifact' && message.path) {
                    debugLog(`[Graph Panel] Opening artifact: ${message.path}`);
                    if (message.artifactType === 'help' || message.label?.toLowerCase().startsWith('help:')) {
                        try {
                            const content = fs.readFileSync(message.path, 'utf8');
                            HelpPanel.show(globalExtensionUri, message.label || 'Stata Help', content);
                        } catch (err) {
                            debugLog(`[Extension] Failed to read help artifact: ${err.message}`);
                            openArtifact(message.path, message.baseDir);
                        }
                    } else {
                        openArtifact(message.path, message.baseDir);
                    }
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

        return `<div class="artifact-tile" data-action="open-modal" data-path="${dataPath}" data-basedir="${escapeHtml(baseDir)}" data-label="${name}" data-type="${escapeHtml(g.type || "")}">
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

         if (modalDownloadBtn) {
             if (artifact.type === 'help') {
                 modalDownloadBtn.textContent = 'View Help';
             } else {
                 modalDownloadBtn.textContent = 'Download PDF';
             }
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
                 
                 console.log('[Modal] Sending message for:', graphName, 'type:', activeModalArtifact.type);
                 if (activeModalArtifact.type === 'help') {
                     vscode.postMessage({
                         type: 'openArtifact',
                         path: activeModalArtifact.path,
                         label: activeModalArtifact.label,
                         baseDir: activeModalArtifact.baseDir,
                         artifactType: 'help'
                     });
                 } else {
                     vscode.postMessage({
                        command: 'download-graph-pdf',
                        graphName: graphName,
                        baseDir: activeModalArtifact.baseDir
                    });
                 }
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
             const baseDir = tile.getAttribute('data-basedir');
             const type = tile.getAttribute('data-type');
             const src = tile.querySelector('img')?.src || path;
             
             console.log('[Modal] Opening modal for:', label, 'type:', type);
             openArtifactModal({ label, name: label, src, path, baseDir, type });
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
        const result = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title, cancellable: true },
            (_progress, token) => task(token)
        );
        return result;
    } catch (error) {
        const detail = error?.message || String(error);
        vscode.window.showErrorMessage(`${title} failed: ${detail}${hints ? ` (snippet: ${hints})` : ''}`);
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
    const snippet = payload?.error?.details || payload?.error?.snippet || payload?.stdout;
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
    const config = vscode.workspace.getConfiguration('stata');
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
    } else if (result?.error?.details) {
        outputChannel.appendLine(result.error.details);
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
        const cancelled = await stataClient.cancel();
        if (!cancelled) {
            console.log('[Extension] No running Stata requests to cancel.');
        }
    } catch (error) {
        console.error('[Extension] Cancel failed:', error);
        vscode.window.showErrorMessage('Failed to cancel: ' + error.message);
    }
}

async function cancelTask(runId) {
    console.log('[Extension] cancelTask called:', runId);
    try {
        await stataClient.cancelTask(runId);
    } catch (error) {
        console.warn('[Extension] cancelTask failed:', error);
    }
}

module.exports = {
    ...moduleExports,
    activate,
    deactivate,
    DataBrowserPanel,
    TerminalPanel,
};
