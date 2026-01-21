const path = require('path');
const vscode = require('vscode');
const http = require('http');
const Sentry = require("@sentry/node");
const { client: mcpClient } = require('./mcp-client');

class DataBrowserPanel {
    static currentPanel = null;
    static extensionUri = null;
    static _log = (msg) => console.log(msg);

    static setLogger(logger) {
        DataBrowserPanel._log = logger;
    }

    static refresh() {
        if (DataBrowserPanel.currentPanel) {
            DataBrowserPanel.currentPanel._fetchCredentials();
        }
    }

    /**
     * @param {vscode.Uri} extensionUri
     */
    static async createOrShow(extensionUri) {
        const column = vscode.ViewColumn.Beside;

        // If we already have a panel, show it.
        if (DataBrowserPanel.currentPanel) {
            DataBrowserPanel.currentPanel._panel.reveal(column);
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

        DataBrowserPanel.currentPanel = new DataBrowserPanel(panel, extensionUri);
    }

    constructor(panel, extensionUri) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._disposables = [];
        this._credentials = null;
        this._isWebviewReady = false;

        // Listen for messages from the webview FIRST
        this._panel.webview.onDidReceiveMessage(
            async message => {
                switch (message.type) {
                    case 'ready':
                        DataBrowserPanel._log('[DataBrowserPanel] Webview reported ready.');
                        this._isWebviewReady = true;
                        if (this._credentials) {
                            DataBrowserPanel._log('[DataBrowserPanel] Credentials available, sending init.');
                            this._panel.webview.postMessage({
                                type: 'init',
                                ...this._credentials,
                                config: this._config
                            });
                        }
                        break;
                    case 'log':
                        DataBrowserPanel._log(`[DataBrowser Webview] ${message.message}`);
                        break;
                    case 'error':
                        Sentry.captureException(new Error(`Data Browser Webview Error: ${message.message}`));
                        DataBrowserPanel._log(`[DataBrowser Webview Error] ${message.message}`);
                        break;
                    case 'apiCall':
                        try {
                            const isArrow = message.url.endsWith('/arrow');
                            const result = await DataBrowserPanel._performRequest(message.url, message.options, isArrow);

                            // Convert Buffer to Uint8Array for structured clone to webview
                            const dataToPost = (result instanceof Buffer) ? new Uint8Array(result) : result;

                            // Check if panel is still alive before posting
                            if (DataBrowserPanel.currentPanel === this) {
                                this._panel.webview.postMessage({
                                    type: 'apiResponse',
                                    reqId: message.reqId,
                                    success: true,
                                    data: dataToPost,
                                    isBinary: isArrow
                                });
                            }
                        } catch (err) {
                            DataBrowserPanel._log(`[DataBrowser Proxy Error] ${err.message}`);

                            // Check if panel is still alive before posting
                            if (DataBrowserPanel.currentPanel === this) {
                                this._panel.webview.postMessage({
                                    type: 'apiResponse',
                                    reqId: message.reqId,
                                    success: false,
                                    error: err.message
                                });
                            }
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

        // Fetch connection details
        this._fetchCredentials();
    }

    async _fetchCredentials() {
        return Sentry.startSpan({ name: 'databrowser.fetchCredentials', op: 'extension.operation' }, async () => {
            DataBrowserPanel._log('[DataBrowserPanel] Fetching UI channel details...');
            try {
                const channel = await mcpClient.getUiChannel();
                if (channel && channel.baseUrl && channel.token) {
                    this._credentials = {
                        baseUrl: channel.baseUrl,
                        token: channel.token
                    };

                    const config = vscode.workspace.getConfiguration('stataMcp');
                    this._config = {
                        variableLimit: config.get('defaultVariableLimit', 0)
                    };

                    DataBrowserPanel._log('[DataBrowserPanel] Credentials fetched.');

                    if (this._isWebviewReady) {
                        DataBrowserPanel._log('[DataBrowserPanel] Webview already ready, sending init.');
                        this._panel.webview.postMessage({
                            type: 'init',
                            ...this._credentials,
                            config: this._config
                        });
                    } else {
                        DataBrowserPanel._log('[DataBrowserPanel] Waiting for webview ready signal...');
                    }
                }
            } catch (err) {
                DataBrowserPanel._log(`[DataBrowserPanel] Error fetching channel: ${err.message}`);
            }
        });
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

    static _performRequest(urlStr, options, expectBinary = false) {
        return Sentry.startSpan({ name: 'databrowser.apiCall', op: 'extension.operation' }, () => {
            return new Promise((resolve, reject) => {
                try {
                    const url = new URL(urlStr);
                    const body = options.body;
                    const headers = { ...options.headers };

                    if (body) {
                        DataBrowserPanel._log(`[DataBrowser Proxy] Sending ${options.method} request to ${url.toString()} with body length ${Buffer.byteLength(body)}`);
                        headers['Content-Length'] = Buffer.byteLength(body);
                        if (!headers['Content-Type']) {
                            headers['Content-Type'] = 'application/json';
                        }
                    } else {
                        DataBrowserPanel._log(`[DataBrowser Proxy] Sending ${options.method} request to ${url.toString()}`);
                    }

                    const opts = {
                        method: options.method,
                        headers: headers
                    };

                    const req = http.request(url, opts, (res) => {
                        const chunks = [];
                        res.on('data', (chunk) => chunks.push(chunk));
                        res.on('end', () => {
                            const buffer = Buffer.concat(chunks);
                            DataBrowserPanel._log(`[DataBrowser Proxy] Response from ${url.pathname}: Status ${res.statusCode}, Body length: ${buffer.byteLength}`);
                            if (res.statusCode >= 200 && res.statusCode < 300) {
                                if (expectBinary) {
                                    resolve(buffer);
                                } else {
                                    try {
                                        resolve(JSON.parse(buffer.toString()));
                                    } catch (e) {
                                        Sentry.captureException(e);
                                        reject(new Error(`Failed to parse JSON: ${e.message}`));
                                    }
                                }
                            } else {
                                reject(new Error(`API Request Failed (${res.statusCode}): ${buffer.toString()}`));
                            }
                        });
                    });

                    req.on('error', (e) => {
                        Sentry.captureException(e);
                        reject(e);
                    });

                    if (body) {
                        req.write(body);
                    }
                    req.end();
                } catch (err) {
                    reject(err);
                }
            });
        });
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

module.exports = { DataBrowserPanel, _performRequest: DataBrowserPanel._performRequest };
