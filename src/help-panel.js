const path = require('path');
const { getVscode } = require('./runtime-context');
const vscode = new Proxy({}, {
    get(_target, prop) {
        return getVscode()?.[prop];
    }
});
const fs = require('fs');
const Sentry = require("@sentry/node");

class HelpPanel {
    static currentPanel = null;
    static extensionUri = null;

    /**
     * @param {vscode.Uri} extensionUri
     * @param {string} title
     * @param {string} content Markdown content
     */
    static async show(extensionUri, title, content) {
        const column = vscode.ViewColumn.Beside;

        if (HelpPanel.currentPanel) {
            HelpPanel.currentPanel._panel.title = title;
            HelpPanel.currentPanel._update(content);
            HelpPanel.currentPanel._panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'stataHelp',
            title,
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

        HelpPanel.currentPanel = new HelpPanel(panel, extensionUri, content);
    }

    constructor(panel, extensionUri, content) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._disposables = [];

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._update(content);
    }

    dispose() {
        HelpPanel.currentPanel = null;
        this._panel.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }

    _update(content) {
        this._panel.webview.html = this._getHtmlForWebview(this._panel.webview, content);
    }

    _getHtmlForWebview(webview, markdown) {
        const designUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'src', 'ui-shared', 'design.css'));
        const nonce = getNonce();

        return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <link rel="stylesheet" href="${designUri}">
                <title>Stata Help</title>
                <style>
                    body {
                        padding: 20px 28px;
                        line-height: 1.65;
                        font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif);
                        font-size: var(--vscode-font-size, 13px);
                        color: var(--vscode-foreground);
                        background: var(--vscode-editor-background);
                    }
                    .help-container {
                        max-width: 860px;
                        margin: 0 auto;
                    }
                    h1 {
                        font-size: 1.4em;
                        font-weight: 600;
                        border-bottom: 2px solid var(--vscode-panel-border, #444);
                        padding-bottom: 6px;
                        margin-bottom: 16px;
                        color: var(--vscode-foreground);
                    }
                    h2 {
                        font-size: 1.15em;
                        font-weight: 600;
                        border-bottom: 1px solid var(--vscode-panel-border, #444);
                        padding-bottom: 4px;
                        margin-top: 24px;
                        margin-bottom: 10px;
                        color: var(--vscode-foreground);
                    }
                    h3 {
                        font-size: 1em;
                        font-weight: 600;
                        margin-top: 16px;
                        margin-bottom: 6px;
                        color: var(--vscode-foreground);
                    }
                    p {
                        margin: 6px 0 10px 0;
                    }
                    code {
                        font-family: var(--vscode-editor-font-family, "SF Mono", Monaco, Consolas, "Courier New", monospace);
                        font-size: 0.9em;
                        background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.15));
                        padding: 1px 4px;
                        border-radius: 3px;
                    }
                    pre {
                        background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.1));
                        border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
                        border-left: 3px solid var(--vscode-textLink-activeForeground, #4d9ee8);
                        padding: 10px 14px;
                        border-radius: 4px;
                        overflow-x: auto;
                        margin: 8px 0;
                    }
                    pre code {
                        background: none;
                        padding: 0;
                        font-size: 0.9em;
                    }
                    table {
                        border-collapse: collapse;
                        width: 100%;
                        margin: 8px 0 14px 0;
                        font-size: 0.95em;
                    }
                    th {
                        background: var(--vscode-editor-inactiveSelectionBackground, rgba(128,128,128,0.2));
                        font-weight: 600;
                        text-align: left;
                        padding: 5px 10px;
                        border: 1px solid var(--vscode-panel-border, #555);
                    }
                    td {
                        padding: 4px 10px;
                        border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
                        vertical-align: top;
                    }
                    td:first-child {
                        white-space: nowrap;
                        font-family: var(--vscode-editor-font-family, "SF Mono", Monaco, Consolas, "Courier New", monospace);
                        font-size: 0.88em;
                    }
                    tr:nth-child(even) td {
                        background: var(--vscode-editor-inactiveSelectionBackground, rgba(128,128,128,0.06));
                    }
                    hr {
                        border: none;
                        border-top: 1px solid var(--vscode-panel-border, #555);
                        margin: 12px 0;
                    }
                    a {
                        color: var(--vscode-textLink-foreground, #4d9ee8);
                        text-decoration: none;
                    }
                    a:hover { text-decoration: underline; }
                    strong { font-weight: 600; }
                </style>
            </head>
            <body>
                <div class="help-container">
                    ${this._renderMarkdown(markdown)}
                </div>
            </body>
            </html>`;
    }

    _renderMarkdown(md) {
        if (!md) return '';

        // Process code blocks first (before line-by-line handling)
        // to avoid interference from inline replacements
        const codeBlocks = [];
        md = md.replace(/```[\w]*\n([\s\S]*?)```/g, (_, code) => {
            const idx = codeBlocks.length;
            codeBlocks.push(`<pre><code>${_escHtml(code.trimEnd())}</code></pre>`);
            return `\x00CODE${idx}\x00`;
        });

        // Split into lines for block-level processing
        const lines = md.split('\n');
        const out = [];
        let inTable = false;
        let tableRows = [];

        const flushTable = () => {
            if (!tableRows.length) return;
            // First row is header, second is separator, rest are data
            let html = '<table>';
            tableRows.forEach((row, ri) => {
                if (ri === 1) return; // skip separator row
                const cells = row.split('|').filter((_, ci, arr) => ci > 0 && ci < arr.length - 1);
                if (ri === 0) {
                    html += '<tr>' + cells.map(c => `<th>${_renderInline(c.trim())}</th>`).join('') + '</tr>';
                } else {
                    html += '<tr>' + cells.map(c => `<td>${_renderInline(c.trim())}</td>`).join('') + '</tr>';
                }
            });
            html += '</table>';
            out.push(html);
            tableRows = [];
            inTable = false;
        };

        for (const line of lines) {
            // Table rows
            if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
                inTable = true;
                tableRows.push(line.trim());
                continue;
            }
            if (inTable) {
                flushTable();
            }

            // Headings
            if (/^# /.test(line)) { out.push(`<h1>${_renderInline(line.slice(2))}</h1>`); continue; }
            if (/^## /.test(line)) { out.push(`<h2>${_renderInline(line.slice(3))}</h2>`); continue; }
            if (/^### /.test(line)) { out.push(`<h3>${_renderInline(line.slice(4))}</h3>`); continue; }

            // Horizontal rule
            if (/^---+\s*$/.test(line)) { out.push('<hr>'); continue; }

            // Restore code block placeholder
            if (/\x00CODE\d+\x00/.test(line)) {
                out.push(line.replace(/\x00CODE(\d+)\x00/g, (_, n) => codeBlocks[+n]));
                continue;
            }

            // Paragraph
            if (line.trim()) {
                out.push(`<p>${_renderInline(line)}</p>`);
            }
        }
        if (inTable) flushTable();

        return out.join('\n');
    }
}

function _escHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function _renderInline(text) {
    return text
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        // Bold before italic to avoid ** being swallowed by * rule
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}

function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

module.exports = { HelpPanel };
