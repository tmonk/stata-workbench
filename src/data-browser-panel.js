const path = require('path');
const vscode = require('vscode');
const http = require('http');
const { client: mcpClient } = require('./mcp-client');

class DataBrowserPanel {
    static currentPanel = null;
    static extensionUri = null;

    /**
     * @param {vscode.Uri} extensionUri
     */
    static async createOrShow(extensionUri) {
        const column = vscode.ViewColumn.Beside;

        // If we already have a panel, show it.
        if (DataBrowserPanel.currentPanel) {
            DataBrowserPanel.currentPanel.reveal(column);
            return;
        }

        DataBrowserPanel.extensionUri = extensionUri;

        // Otherwise, create a new panel.
        const panel = vscode.window.createWebviewPanel(
            'stataDataBrowser',
            'Stata Data Browser',
            column,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'src', 'ui-shared')]
            }
        );

        DataBrowserPanel.currentPanel = panel;

        panel.onDidDispose(() => {
            DataBrowserPanel.currentPanel = null;
        });

        // Set the webview's initial html content
        panel.webview.html = DataBrowserPanel._getHtmlForWebview(panel.webview, extensionUri);

        // Handle messages from the webview
        panel.webview.onDidReceiveMessage(
            async message => {
                switch (message.type) {
                    case 'log':
                        console.log(`[DataBrowser Webview] ${message.message}`);
                        break;
                    case 'error':
                        console.error(`[DataBrowser Webview Error] ${message.message}`);
                        break;
                    case 'apiCall':
                        try {
                            const result = await DataBrowserPanel._performRequest(message.url, message.options);
                            panel.webview.postMessage({
                                type: 'apiResponse',
                                reqId: message.reqId,
                                success: true,
                                data: result
                            });
                        } catch (err) {
                            console.error('[DataBrowser Proxy Error]', err);
                            // If running in integration test, re-throw to fail the test if unhandled
                            if (process.env.MCP_STATA_INTEGRATION === '1') {
                                // We can't easily throw across the process boundary to Mocha here,
                                // but we can ensure it's logged as a critical error that tests might be scanning for.
                                // However, to truly fail the test, we need the test runner to see this.
                                // The best way is to let the message post back an error, and have the test client assert on no errors.
                            }
                            panel.webview.postMessage({
                                type: 'apiResponse',
                                reqId: message.reqId,
                                success: false,
                                error: err.message
                            });
                        }
                        break;
                }
            },
            null,
            []
        );

        // Fetch connection details and initialize
        console.log('[DataBrowserPanel] Fetching UI channel details...');
        try {
            const channel = await mcpClient.getUiChannel();
            console.log('[DataBrowserPanel] Received channel:', JSON.stringify(channel, null, 2));
            
            if (channel && channel.baseUrl && channel.token) {
                console.log('[DataBrowserPanel] Sending init message to webview');
                panel.webview.postMessage({
                    type: 'init',
                    baseUrl: channel.baseUrl,
                    token: channel.token
                });
            } else {
                console.error('[DataBrowserPanel] Invalid channel details received');
                vscode.window.showErrorMessage('Failed to retrieve UI channel details from Stata.');
            }
        } catch (err) {
            console.error('[DataBrowserPanel] Error connecting:', err);
            vscode.window.showErrorMessage(`Error connecting to Stata UI channel: ${err.message}`);
        }
    }

    static _performRequest(urlStr, options) {
        return new Promise((resolve, reject) => {
            try {
                const url = new URL(urlStr);
                const headers = options.headers || {};
                
                let body = options.body;
                
                // Robustness: ensure body is a string if present.
                // explicitly handle object bodies if they somehow arrive here
                if (body && typeof body !== 'string' && !Buffer.isBuffer(body)) {
                    try {
                        body = JSON.stringify(body);
                        if (!headers['Content-Type']) {
                            headers['Content-Type'] = 'application/json';
                        }
                    } catch (e) {
                        // ignore
                    }
                }

                if (body) {
                    headers['Content-Length'] = Buffer.byteLength(body);
                    if (!headers['Content-Type']) {
                        // Default to JSON if not specified but body is present
                        headers['Content-Type'] = 'application/json';
                    }
                }

                const opts = {
                    method: options.method || 'GET',
                    headers: headers,
                    hostname: url.hostname,
                    port: url.port,
                    path: url.pathname + url.search
                };

                const req = http.request(opts, (res) => {
                    let data = '';
                    res.on('data', (chunk) => data += chunk);
                    res.on('end', () => {
                        if (res.statusCode >= 200 && res.statusCode < 300) {
                            try {
                                const json = JSON.parse(data);
                                resolve(json);
                            } catch (e) {
                                // If not JSON, return text? The API should return JSON.
                                reject(new Error('Invalid JSON response'));
                            }
                        } else {
                            reject(new Error(`API Request Failed (${res.statusCode}): ${data}`));
                        }
                    });
                });

                req.on('error', (e) => reject(e));

                if (body) {
                    req.write(body);
                }
                req.end();
            } catch (err) {
                reject(err);
            }
        });
    }

    static _getHtmlForWebview(webview, extensionUri) {
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'src', 'ui-shared', 'data-browser.js'));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'src', 'ui-shared', 'data-browser.css'));
        const designUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'src', 'ui-shared', 'design.css'));
        const nonce = getNonce();

        // CSP: Allow scripts from our extension, styles from extension, and connect to localhost (for API)
        const csp = `
            default-src 'none';
            style-src ${webview.cspSource} 'unsafe-inline';
            script-src 'nonce-${nonce}';
            connect-src http://127.0.0.1:* ws://127.0.0.1:*;
            img-src ${webview.cspSource} data:;
            font-src ${webview.cspSource};
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
            </head>
            <body>
                <div id="loading-overlay" class="loading-overlay hidden">
                    <div class="spinner"></div>
                </div>
                <div id="error-banner" class="error-banner hidden"></div>

                <div id="toolbar">
                    <div id="filter-container">
                        <input type="text" id="filter-input" placeholder="Filter expression (e.g. price > 5000 & mpg > 20)">
                        <button id="apply-filter" class="btn btn-primary btn-sm">Filter</button>
                    </div>
                    <div class="input-actions" style="margin-left: auto;">
                        <button id="btn-refresh" class="btn btn-sm btn-ghost" title="Refresh Data">
                            <span>Refresh</span>
                        </button>
                        <select id="variable-selector" class="btn btn-sm" style="max-width: 150px;">
                            <option value="">Variables...</option>
                        </select>
                    </div>
                </div>
                <div id="statusbar">
                        <span id="status-text">Not connected</span>
                        <div class="pagination-controls">
                            <button id="btn-prev" class="btn btn-sm btn-ghost" disabled>Prev</button>
                            <span id="page-info" class="page-info">0 - 0</span>
                            <button id="btn-next" class="btn btn-sm btn-ghost" disabled>Next</button>
                        </div>
                    </div>
                </div>

                <div id="data-grid-container">
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
