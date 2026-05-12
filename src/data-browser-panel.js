const path = require('path');
const { getVscode } = require('./runtime-context');
const vscode = new Proxy({}, {
    get(_target, prop) {
        return getVscode()?.[prop];
    }
});
const Sentry = require("@sentry/node");

class DataBrowserPanel {
    static currentPanel = null;
    static extensionUri = null;
    static _log = (msg) => console.log(msg);

    static setLogger(logger) {
        DataBrowserPanel._log = logger;
    }


    /**
     * @param {vscode.Uri} extensionUri
     */
    static async createOrShow(extensionUri) {
        const column = vscode.ViewColumn.Beside;

        // If we already have a panel, show it.
        if (DataBrowserPanel.currentPanel) {
            const targetColumn = DataBrowserPanel.currentPanel._panel.viewColumn || vscode.ViewColumn.Beside;
            DataBrowserPanel.currentPanel._panel.reveal(targetColumn);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'stataDataBrowser',
            'Stata Data Browser',
            column,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(extensionUri, 'src', 'ui-shared'),
                    vscode.Uri.joinPath(extensionUri, 'dist', 'ui-shared')
                ]
            }
        );

        DataBrowserPanel.currentPanel = new DataBrowserPanel(panel, extensionUri, DataBrowserPanel._stataClient);
    }

    constructor(panel, extensionUri, stataClient) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._stataClient = stataClient;
        this._disposables = [];
        this._isWebviewReady = false;

        // Listen for messages from the webview FIRST
        this._panel.webview.onDidReceiveMessage(
            async message => {
                switch (message.type) {
                    case 'ready':
                        this._isWebviewReady = true;
                        try {
                            const vars = await this._stataClient.listVariables();
                            const state = await this._stataClient.getDatasetState();
                            this._panel.webview.postMessage({
                                type: 'init',
                                variables: vars,
                                obs_count: state.obs_count,
                                var_count: state.var_count,
                                dataset_name: state.dataset_name,
                                config: { variableLimit: this._config?.variableLimit || 0 },
                            });
                        } catch (err) {
                            this._panel.webview.postMessage({ type: 'error', message: err.message });
                        }
                        break;
                    case 'log':
                        DataBrowserPanel._log(`[DataBrowser Webview] ${message.message}`);
                        break;
                    case 'error':
                        Sentry.captureException(new Error(`Data Browser Webview Error: ${message.message}`));
                        DataBrowserPanel._log(`[DataBrowser Webview Error] ${message.message}`);
                        break;
                    case 'requestVariables':
                        try {
                            const vars = await this._stataClient.listVariables();
                            const state = await this._stataClient.getDatasetState();
                            this._panel.webview.postMessage({
                                type: 'variables',
                                variables: vars,
                                obs_count: state.obs_count,
                                var_count: state.var_count,
                                dataset_name: state.dataset_name,
                            });
                        } catch (err) {
                            this._panel.webview.postMessage({ type: 'error', message: err.message });
                        }
                        break;
                    case 'requestPage':
                        try {
                            const { start, count, varlist } = message;
                            const buffer = await this._stataClient.getDataPage(start, count, varlist);
                            this._panel.webview.postMessage({
                                type: 'arrow-page',
                                data: Array.from(new Uint8Array(buffer)),
                            });
                        } catch (err) {
                            this._panel.webview.postMessage({ type: 'error', message: err.message });
                        }
                        break;
                    case 'filter':
                        try {
                            const result = await this._stataClient.validateFilterExpr(message.expr);
                            if (result.valid) {
                                const indices = await this._stataClient.computeViewIndices(message.expr);
                                this._panel.webview.postMessage({
                                    type: 'filterResult',
                                    valid: true,
                                    indices: indices,
                                });
                            } else {
                                this._panel.webview.postMessage({
                                    type: 'filterResult',
                                    valid: false,
                                    error: result.error,
                                });
                            }
                        } catch (err) {
                            this._panel.webview.postMessage({ type: 'filterResult', valid: false, error: err.message });
                        }
                        break;
                }
            },
            null,
            this._disposables
        );

        // Set the HTML SECOND
        this._update();

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    }


    dispose() {
        DataBrowserPanel.currentPanel = null;

        // Clean up our resources
        this._panel.dispose();

        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }

    _update() {
        this._panel.webview.html = this._getHtmlForWebview(this._panel.webview, this._extensionUri);
    }


    _getHtmlForWebview(webview, extensionUri) {
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'ui-shared', 'data-browser.js'));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'src', 'ui-shared', 'data-browser.css'));
        const designUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'src', 'ui-shared', 'design.css'));
        const nonce = getNonce();

        // CSP: Allow scripts from our extension, styles from extension, and connect to localhost (for API) + Sentry
        const csp = `
            default-src 'none';
            style-src ${webview.cspSource} 'unsafe-inline' https://unpkg.com;
            script-src ${webview.cspSource} 'nonce-${nonce}' blob:;
            worker-src 'self' blob:;
            connect-src http://127.0.0.1:* ws://127.0.0.1:* https://o4510744386732032.ingest.de.sentry.io;
            img-src ${webview.cspSource} data:;
            font-src ${webview.cspSource} https://unpkg.com;
        `;

        return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta http-equiv="Content-Security-Policy" content="${csp.replace(/\s+/g, ' ').trim()}">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <link rel="stylesheet" href="${designUri}">
                <link rel="stylesheet" href="${styleUri}">
                <title>Stata Data Browser</title>
                <style nonce="${nonce}">
                    @import url('https://unpkg.com/@vscode/codicons@0.0.44/dist/codicon.css');
                </style>
            </head>
            <body>
                <div id="error-banner" class="error-banner hidden"></div>

                <div class="context-header">
                    <div class="context-container">
                        <div class="context-info">
                            <div class="context-row">
                                <span class="context-label">Frame:</span>
                                <span class="context-value" id="frame-name">default</span>
                            </div>
                            <div class="context-row">
                                <span class="context-label">Filter:</span>
                                <div id="filter-container">
                                    <input type="text" id="filter-input" placeholder="e.g. price > 5000">
                                    <button id="apply-filter" class="btn btn-ghost btn-icon" title="Apply Filter">
                                        <i class="codicon codicon-filter"></i>
                                    </button>
                                </div>
                            </div>
                        </div>
                        <div class="context-right">
                            <div class="data-summary" id="data-summary">
                                <span class="summary-item">n: <span id="obs-count">0</span></span>
                                <span class="summary-item">v: <span id="var-count">0</span></span>
                            </div>
                            <div class="pagination-controls">
                                <button id="btn-prev" class="btn btn-sm btn-ghost" title="Previous Page" disabled>
                                    <i class="codicon codicon-chevron-left"></i>
                                </button>
                                <span id="page-info" class="page-info">0 - 0</span>
                                <button id="btn-next" class="btn btn-sm btn-ghost" title="Next Page" disabled>
                                    <i class="codicon codicon-chevron-right"></i>
                                </button>
                            </div>
                            <div class="input-actions">
                                <button id="btn-refresh" class="btn btn-sm btn-ghost" title="Refresh Data">
                                    <i class="codicon codicon-refresh"></i>
                                </button>
                                <div class="var-dropdown-container">
                                    <button id="btn-variables">
                                        <i class="codicon codicon-list-selection"></i>
                                        <span>Variables</span>
                                    </button>
                                    <div id="var-dropdown-menu" class="var-dropdown-menu">
                                        <div class="dropdown-header">
                                            <input type="text" id="var-search-input" placeholder="Search...">
                                            <div class="dropdown-actions">
                                                <button id="btn-select-all" class="text-btn">Select All</button>
                                                <button id="btn-select-none" class="text-btn">Select None</button>
                                            </div>
                                        </div>
                                        <div id="var-list" class="dropdown-list"></div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <div id="data-grid-container">
                    <div id="loading-overlay" class="loading-overlay hidden">
                        <div class="spinner"></div>
                    </div>
                    <table id="data-grid">
                        <thead id="grid-header"></thead>
                        <tbody id="grid-body"></tbody>
                    </table>
                </div>

                <script nonce="${nonce}" src="${scriptUri}"></script>
            </body>
            </html>`;
    }
}

function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

module.exports = { DataBrowserPanel };
