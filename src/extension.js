const path = require('path');
const fs = require('fs');
const vscode = require('vscode');
const { spawnSync } = require('child_process');
const pkg = require('../package.json');
const { client: mcpClient } = require('./mcp-client');
const { TerminalPanel } = require('./terminal-panel');
const { openArtifact } = require('./artifact-utils');

let outputChannel;
let statusBarItem;
let dataPanel = null;
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
    outputChannel = vscode.window.createOutputChannel('Stata MCP');
    const version = pkg?.version || 'unknown';
    outputChannel.appendLine(`Stata MCP ready (extension v${version})`);
    missingCliPrompted = !!context.globalState?.get?.(MISSING_CLI_PROMPT_KEY);
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || context.extensionPath;
    if (!missingCliPrompted && hasExistingMcpConfig(workspaceRoot)) {
        missingCliPrompted = true;
        context.globalState?.update?.(MISSING_CLI_PROMPT_KEY, true).catch?.(() => { });
    }
    if (typeof mcpClient.setLogger === 'function') {
        mcpClient.setLogger((msg) => outputChannel.appendLine(msg));
    }

    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.text = '$(beaker) Stata MCP: Idle';
    statusBarItem.tooltip = 'Stata MCP (powered by mcp-stata)';
    statusBarItem.show();

    const subscriptions = [
        vscode.commands.registerCommand('stata-workbench.runSelection', runSelection),
        vscode.commands.registerCommand('stata-workbench.runFile', runFile),
        vscode.commands.registerCommand('stata-workbench.testMcpServer', testConnection),
        vscode.commands.registerCommand('stata-workbench.showGraphs', showGraphs),
        vscode.commands.registerCommand('stata-workbench.installMcpCli', promptInstallMcpCli),
        vscode.commands.registerCommand('stata-workbench.cancelRequest', cancelRequest),
        mcpClient.onStatusChanged(updateStatusBar)
    ];

    context.subscriptions.push(...subscriptions, statusBarItem, outputChannel);
    globalExtensionUri = context.extensionUri;
    TerminalPanel.setExtensionUri(context.extensionUri);
    missingCli = !ensureMcpCliAvailable(context);
    if (!missingCli) {
        ensureMcpConfigs(context);
        const refreshed = refreshMcpPackage();
        mcpPackageVersion = refreshed || getMcpPackageVersion();
        outputChannel.appendLine(`mcp-stata version: ${mcpPackageVersion}`);
    }
    updateStatusBar(missingCli ? 'missing' : 'idle');

    // Expose API for testing
    if (context.extensionMode === vscode.ExtensionMode.Test) {
        return {
            TerminalPanel
        };
    }
}

function ensureMcpCliAvailable(context) {
    const found = findUvBinary();
    if (found) {
        uvCommand = found;
        process.env.MCP_STATA_UVX_CMD = uvCommand;
        return true;
    }

    const installDir = path.join(context.globalStoragePath, 'uv');
    try {
        fs.mkdirSync(installDir, { recursive: true });
    } catch (_err) {
        // ignore mkdir failures; fall back to prompt
    }

    const installCmd = getUvInstallCommand();
    const env = { ...process.env, UV_INSTALL_DIR: installDir };
    const result = spawnSync(installCmd.command, installCmd.args, { env, encoding: 'utf8' });

    const installed = findUvBinary(installDir);
    if (result.status === 0 && installed) {
        uvCommand = installed;
        process.env.MCP_STATA_UVX_CMD = uvCommand;
        return true;
    }

    promptInstallMcpCli();
    return false;
}

function getMcpPackageVersion() {
    const cmd = uvCommand || 'uvx';
    // 1) Try reading the installed package metadata via Python (works even if CLI is quiet).
    try {
        const pyResult = spawnSync(cmd, ['--from', MCP_PACKAGE_SPEC, 'python', '-c', 'import importlib.metadata as im; print(im.version("mcp-stata"))'], {
            encoding: 'utf8',
            timeout: 5000
        });
        const pyOut = (pyResult?.stdout || '').toString().trim();
        if (pyOut) return pyOut;
    } catch (_err) {
        // ignore and fall back
    }

    // 2) Fallback to invoking the CLI with --version (some builds may emit this).
    try {
        const result = spawnSync(cmd, ['--from', MCP_PACKAGE_SPEC, MCP_PACKAGE_NAME, '--version'], {
            encoding: 'utf8',
            timeout: 5000
        });
        const stdout = result?.stdout?.toString?.() || '';
        const stderr = result?.stderr?.toString?.() || '';
        const text = stdout.trim() || stderr.trim();
        return text || 'unknown';
    } catch (_err) {
        return 'unknown';
    }
}

function refreshMcpPackage() {
    const cmd = uvCommand || 'uvx';
    const args = ['--refresh', '--from', MCP_PACKAGE_SPEC, MCP_PACKAGE_NAME, '--version'];
    try {
        const result = spawnSync(cmd, args, { encoding: 'utf8', timeout: 10000 });
        const stdout = result?.stdout?.toString?.().trim() || '';
        const stderr = result?.stderr?.toString?.().trim() || '';
        const text = stdout || stderr;

        if (result.status === 0) {
            if (text) {
                mcpPackageVersion = text;
            }
            if (outputChannel) {
                outputChannel.appendLine(`Ensured latest mcp-stata via uvx --refresh (${text || 'version not reported'})`);
            }
            return mcpPackageVersion;
        }

        if (outputChannel) {
            outputChannel.appendLine(`Failed to refresh mcp-stata (exit ${result.status}): ${text}`);
        }
    } catch (err) {
        if (outputChannel) {
            outputChannel.appendLine(`Error refreshing mcp-stata: ${err.message}`);
        }
    }

    return null;
}

function promptInstallMcpCli(context) {
    const ctx = context || globalContext;
    if (!missingCliPrompted) {
        missingCliPrompted = !!ctx?.globalState?.get?.(MISSING_CLI_PROMPT_KEY);
    }
    if (missingCliPrompted) {
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
    const base = ['uvx', 'uvx.exe', 'uv', 'uv.exe'];
    const candidates = [...base];

    if (optionalInstallDir) {
        const binDir = path.join(optionalInstallDir, 'bin');
        for (const name of base) {
            candidates.push(path.join(binDir, name));
        }
    }

    for (const candidate of candidates) {
        const result = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
        if (!result.error && result.status === 0) {
            return candidate;
        }
    }
    return null;
}

function ensureMcpConfigs(context) {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || context.extensionPath;
    const configPaths = getHostConfigPaths(workspaceRoot);
    for (const cfg of configPaths) {
        writeMcpConfig(cfg.path, cfg.isVscode);
    }
}

function hasExistingMcpConfig(workspaceRoot) {
    if (!workspaceRoot) return false;
    const candidates = [
        path.join(workspaceRoot, '.vscode', 'mcp.json'),
        path.join(workspaceRoot, '.cursor', 'mcp.json'),
        path.join(workspaceRoot, '.windsurf', 'mcp.json'),
        path.join(workspaceRoot, '.gemini', 'mcp.json'),
        path.join(workspaceRoot, '.antigravity', 'mcp.json')
    ];

    for (const candidate of candidates) {
        try {
            if (!fs.existsSync(candidate)) continue;
            const raw = fs.readFileSync(candidate, 'utf8');
            if (!raw) continue;
            const json = JSON.parse(raw);
            if (json?.servers?.[MCP_SERVER_ID] || json?.mcpServers?.[MCP_SERVER_ID]) {
                return true;
            }
        } catch (_err) {
            // ignore parse or access errors; treat as not present
        }
    }

    return false;
}

function writeMcpConfig(configPath, isVscodeFormat) {
    try {
        const dir = path.dirname(configPath);
        fs.mkdirSync(dir, { recursive: true });
        const raw = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
        let json;
        try {
            json = raw ? JSON.parse(raw) : {};
        } catch (_err) {
            json = {};
        }

        const resolvedCommand = uvCommand || 'uvx';
        const expectedArgs = ['--refresh', '--from', MCP_PACKAGE_SPEC, MCP_PACKAGE_NAME];

        const expectedCursor = {
            command: resolvedCommand,
            args: expectedArgs
        };

        const expectedVscode = {
            type: 'stdio',
            command: resolvedCommand,
            args: expectedArgs
        };

        if (isVscodeFormat) {
            json.servers = json.servers || {};
            const existing = json.servers[MCP_SERVER_ID];
            if (!configsMatch(existing, expectedVscode, true)) {
                json.servers[MCP_SERVER_ID] = expectedVscode;
                outputChannel?.appendLine?.(`Updated VS Code MCP config at ${configPath} for ${MCP_SERVER_ID}`);
            }
        } else {
            json.mcpServers = json.mcpServers || {};
            const existing = json.mcpServers[MCP_SERVER_ID];
            if (!configsMatch(existing, expectedCursor, false)) {
                json.mcpServers[MCP_SERVER_ID] = expectedCursor;
                outputChannel?.appendLine?.(`Updated Cursor MCP config at ${configPath} for ${MCP_SERVER_ID}`);
            }
        }

        fs.writeFileSync(configPath, JSON.stringify(json, null, 2));
    } catch (err) {
        console.error('Failed to write MCP config', configPath, err.message);
    }
}

function getHostConfigPaths(workspaceRoot) {
    const configs = new Set();
    const appName = (vscode.env?.appName || '').toLowerCase();

    const add = (rel, isVscode) => configs.add(JSON.stringify({ path: path.join(workspaceRoot, rel, 'mcp.json'), isVscode }));

    if (appName.includes('cursor')) add('.cursor', false);
    else if (appName.includes('windsurf')) add('.windsurf', false);
    else if (appName.includes('antigravity') || appName.includes('gemini')) add('.gemini', false);
    else add('.vscode', true);

    // Always include VS Code-style config as a friendly fallback if not already present.
    add('.vscode', true);

    return Array.from(configs).map((s) => JSON.parse(s));
}

function configsMatch(existing, expected, hasType) {
    if (!existing) return false;
    if (hasType && existing.type !== expected.type) return false;
    if (existing.command !== expected.command) return false;
    if (!Array.isArray(existing.args) || existing.args.length !== expected.args.length) return false;
    return existing.args.every((v, i) => v === expected.args[i]);
}

function deactivate() {
    mcpClient.dispose();
}

function updateStatusBar(status) {
    if (!statusBarItem) return;
    switch (status) {
        case 'queued':
            statusBarItem.text = '$(clock) Stata MCP: Queued';
            statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
            statusBarItem.command = undefined;
            break;
        case 'running':
            statusBarItem.text = '$(sync~spin) Stata MCP: Running';
            statusBarItem.backgroundColor = undefined;
            statusBarItem.command = 'stata-workbench.cancelRequest';
            statusBarItem.tooltip = 'Cancel current Stata request';
            break;
        case 'connecting':
            statusBarItem.text = '$(sync~spin) Stata MCP: Connecting';
            statusBarItem.backgroundColor = undefined;
            statusBarItem.command = undefined;
            break;
        case 'connected':
            statusBarItem.text = '$(beaker) Stata MCP: Connected';
            statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
            statusBarItem.command = undefined;
            break;
        case 'error':
            statusBarItem.text = '$(error) Stata MCP: Error';
            statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
            statusBarItem.command = undefined;
            break;
        case 'missing':
            statusBarItem.text = '$(warning) Stata MCP: uvx missing';
            statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
            statusBarItem.tooltip = 'uvx (uv) not found. Click to copy install command.';
            statusBarItem.command = 'stata-workbench.installMcpCli';
            break;
        default:
            statusBarItem.text = '$(beaker) Stata MCP: Idle';
            statusBarItem.backgroundColor = undefined;
            statusBarItem.command = undefined;
    }
}

async function runSelection() {
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

    await withStataProgress('Running selection', async (token) => {
        const result = await mcpClient.runSelection(text, { cancellationToken: token, normalizeResult: true, includeGraphs: true });
        // Use Terminal Panel for output
        await presentRunResult(text, result, filePath);
    }, text);
}

async function runFile() {
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

    await withStataProgress(`Running ${path.basename(filePath)}`, async (token) => {
        const result = await mcpClient.runFile(filePath, { cancellationToken: token, normalizeResult: true, includeGraphs: true });
        // Use "do filename" as the command text representation
        await presentRunResult(`do "${path.basename(filePath)}"`, result, filePath);
    });
}

async function testConnection() {
    await withStataProgress('Testing MCP server', async (token) => {
        const output = await mcpClient.runSelection('di "Hello from mcp-stata!"', { cancellationToken: token });
        vscode.window.showInformationMessage('mcp-stata responded successfully.');
        showOutput(output);
    });
}

function showOutput(content) {
    if (content === undefined || content === null) return;
    const now = new Date().toISOString();
    outputChannel.appendLine(`\n=== ${now} ===`);
    outputChannel.appendLine(typeof content === 'string' ? content : JSON.stringify(content, null, 2));
    const config = vscode.workspace.getConfiguration('stataMcp');
    if (config.get('autoRevealOutput', true)) {
        outputChannel.show(true);
    }
}

// Defines the standard run command used by the Terminal Panel
const terminalRunCommand = async (code) => {
    try {
        return await mcpClient.runSelection(code, { normalizeResult: true, includeGraphs: true });
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
        outputChannel?.appendLine(`Failed to fetch variable list: ${error?.message || error}`);
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
        variableProvider: variableListProvider
    });
}

async function viewData() {
    await refreshDataPanel();
}

async function showGraphs() {
    try {
        const graphList = await mcpClient.listGraphs();
        const items = Array.isArray(graphList?.graphs) ? graphList.graphs : [];
        const detailed = items.map((g) => {
            const dataUri = g.dataUri || (g.path && g.path.startsWith('data:') ? g.path : null);
            const href = dataUri || g.path || g.url;
            return {
                name: g.label || g.name,
                dataUri: dataUri || href,
                previewDataUri: g.previewDataUri || null,
                error: g.error || null
            };
        });
        openGraphPanel(detailed);
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to list graphs: ${error.message}`);
    }
}

function escapeHtml(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function openDataPanel(table) {
    if (!dataPanel) {
        dataPanel = vscode.window.createWebviewPanel(
            'stataData',
            'Stata Data',
            vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(globalExtensionUri, 'src', 'ui-shared')]
            }
        );
        dataPanel.onDidDispose(() => { dataPanel = null; });
        dataPanel.webview.onDidReceiveMessage(async (message) => {
            if (message?.command === 'applyFilter') {
                currentDataFilter = message.filter || '';
                await refreshDataPanel();
            }
        });
    }

    const html = renderDataHtml(table, dataPanel.webview);
    dataPanel.webview.html = html;
}

function renderDataHtml(table, webview) {
    const designUri = webview.asWebviewUri(vscode.Uri.joinPath(globalExtensionUri, 'src', 'ui-shared', 'design.css'));
    const columns = table?.columns || [];
    const data = table?.dataRows || [];
    const rows = table?.count || 0;
    const header = columns.map(c => `<th>${escapeHtml(c)}</th>`).join('');
    const body = data.map(row => `<tr>${row.map(cell => `<td>${escapeHtml(String(cell ?? '.'))}</td>`).join('')}</tr>`).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <link rel="stylesheet" href="${designUri}">
  <title>Stata Data</title>
  <style>
    body { padding: var(--space-md); }
    table { width: 100%; border-collapse: separate; border-spacing: 0; border: 1px solid var(--border-subtle); border-radius: var(--radius-md); overflow: hidden; }
    th, td { padding: 8px 12px; border-bottom: 1px solid var(--border-subtle); border-right: 1px solid var(--border-subtle); font-family: var(--font-mono); font-size: 12px; }
    th { background: var(--bg-secondary); font-weight: 600; position: sticky; top: 0; }
    tr:last-child td { border-bottom: none; }
    tr:nth-child(even) { background: rgba(255,255,255,0.01); }
    td:last-child, th:last-child { border-right: none; }
    .meta-bar { margin-bottom: var(--space-md); display: flex; justify-content: space-between; align-items: center; }
  </style>
</head>
<body>
  <div class="meta-bar">
    <span class="badge" style="font-weight:normal;">${rows} observations</span>
  </div>
  <div style="overflow-x: auto; border-radius: var(--radius-md); border: 1px solid var(--border-subtle);">
    <table style="border:none;">
        <thead><tr>${header}</tr></thead>
        <tbody>${body}</tbody>
    </table>
  </div>
</body></html>`;
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
                localResourceRoots: [vscode.Uri.joinPath(globalExtensionUri, 'src', 'ui-shared')]
            }
        );
        graphPanel.onDidDispose(() => { graphPanel = null; });

        // Handle messages from the webview
        graphPanel.webview.onDidReceiveMessage(async (message) => {
            if (!message || typeof message !== 'object') return;

            if (message.type === 'openArtifact' && message.path) {
                openArtifact(message.path, message.baseDir);
            }
        });
    }

    const html = renderGraphHtml(graphDetails, graphPanel.webview, globalExtensionUri);
    graphPanel.webview.html = html;
}

function renderGraphHtml(graphDetails, webview, extensionUri) {
    const designUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'src', 'ui-shared', 'design.css'));
    const mainJsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'src', 'ui-shared', 'main.js'));
    const items = Array.isArray(graphDetails) ? graphDetails : [];

    // Use artifact-card style for graphs
    const blocks = items.map(g => {
        const name = escapeHtml(g.name || 'graph');
        const resolved = g.previewDataUri ? escapeHtml(g.previewDataUri) : (g.dataUri ? escapeHtml(g.dataUri) : '');
        const error = g.error ? `<div class="code-block" style="color:var(--error-color);border-color:var(--error-color);">Error: ${escapeHtml(g.error)}</div>` : '';
        const image = resolved
            ? `<div class="artifact-preview" style="height:auto; min-height:200px; background:transparent; border:none;">
                 <img src="${resolved}" alt="${name}" style="max-width:100%; border-radius:var(--radius-sm); border:1px solid var(--border-subtle);">
               </div>`
            : '<div class="text-muted p-4">No image data</div>';

        // Add data attributes for click handling
        const path = g.dataUri || g.path || '';
        const displayPath = escapeHtml(path);
        const baseDir = g.baseDir || '';

        return `<div class="artifact-card" data-action="open-artifact" data-path="${displayPath}" data-basedir="${escapeHtml(baseDir)}" data-label="${name}" style="cursor:pointer;">
          <div class="flex justify-between items-center" style="margin-bottom:var(--space-sm);">
             <span class="font-medium">${name}</span>
          </div>
          ${image}
          ${error}
        </div>`;
    }).join('') || '<div class="text-muted">No graphs available</div>';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <link rel="stylesheet" href="${designUri}">
  <title>Stata Graphs</title>
  <style>
    body { padding: var(--space-md); }
    .artifact-grid { display: grid; grid-template-columns: 1fr; gap: var(--space-md); }
  </style>
</head>
<body>
  <div class="header" style="margin-bottom:var(--space-md);">
     <span class="font-bold" style="font-size:16px;">Stata Graphs</span>
  </div>
  <div class="artifact-grid">
    ${blocks}
  </div>
  <script src="${mainJsUri}"></script>
  <script>
     const vscode = acquireVsCodeApi();
     window.stataUI.bindArtifactEvents(vscode);
  </script>
</body></html>`;
}

async function refreshDataPanel() {
    try {
        const response = await mcpClient.viewData(0, 50);
        const table = buildTable(response);
        openDataPanel(table);
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to view data: ${error.message}`);
    }
}

function buildTable(dataResponse) {
    const rows = Array.isArray(dataResponse?.data) ? dataResponse.data : [];
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    const dataRows = rows.map(row => columns.map(col => row[col]));
    return { columns, dataRows, count: rows.length };
}

async function withStataProgress(title, task, sample) {
    const cancellable = true;
    const hints = sample && sample.length > 180 ? `${sample.slice(0, 180)}…` : sample;
    return vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title,
            cancellable
        },
        async (token) => {
            try {
                const result = await task(token);
                return result;
            } catch (error) {
                const detail = error?.message || String(error);
                vscode.window.showErrorMessage(`${title} failed: ${detail}${hints ? ` (snippet: ${hints})` : ''}`);
                showOutput(error?.stack || detail);
                throw error;
            }
        }
    );
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
    const now = new Date().toISOString();
    outputChannel.appendLine(`\n=== ${now} — ${contextTitle} ===`);
    if (!result) {
        outputChannel.appendLine('No result from Stata.');
        return;
    }

    if (result.command) outputChannel.appendLine(`cmd: ${result.command}`);
    if (typeof result.rc === 'number') outputChannel.appendLine(`rc: ${result.rc}`);
    if (typeof result.durationMs === 'number') outputChannel.appendLine(`duration: ${formatDuration(result.durationMs)}`);
    if (Array.isArray(result.graphArtifacts) && result.graphArtifacts.length) {
        outputChannel.appendLine(`graphs: ${result.graphArtifacts.map(g => g.label || g.path || '').join(', ')}`);
    }
    if (result.stdout) {
        outputChannel.appendLine(result.stdout);
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
    const cancelled = await mcpClient.cancelAll();
    if (cancelled) {
        vscode.window.showInformationMessage('Cancelled current Stata request.');
    } else {
        vscode.window.showInformationMessage('No running Stata requests to cancel.');
    }
}

module.exports = {
    activate,
    deactivate,
    refreshMcpPackage,
    writeMcpConfig,
    getUvInstallCommand,
    promptInstallMcpCli,
    hasExistingMcpConfig
};
