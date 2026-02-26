const path = require('path');
const vscode = require('vscode');
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

        // Very basic markdown to HTML for now, or just wrap in <pre> if we don't have a library.
        // Actually, we can use a small library or just simple regex for common things.
        // Since we want it to look PREMIUM, let's try to make it look nice.

        return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <link rel="stylesheet" href="${designUri}">
                <title>Stata Help</title>
                <style>
                    body {
                        padding: 20px;
                        line-height: 1.6;
                        font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif);
                    }
                    pre {
                        background: var(--vscode-textCodeBlock-background);
                        padding: 10px;
                        border-radius: 4px;
                        overflow-x: auto;
                    }
                    code {
                        font-family: var(--vscode-editor-font-family, "SF Mono", Monaco, Consolas, "Courier New", monospace);
                    }
                    h1, h2, h3 {
                        border-bottom: 1px solid var(--vscode-panel-border);
                        padding-bottom: 5px;
                    }
                    .help-container {
                        max-width: 800px;
                        margin: 0 auto;
                    }
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

        // Simple MD renderer
        return md
            .replace(/^#\s+(.+)$/gm, '<h1>$1</h1>')
            .replace(/^##\s+(.+)$/gm, '<h2>$1</h2>')
            .replace(/^###\s+(.+)$/gm, '<h3>$1</h3>')
            .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
            .replace(/\*(.+?)\*/g, '<i>$1</i>')
            .replace(/`(.+?)`/g, '<code>$1</code>')
            .replace(/^\s*\n/gm, '<p>')
            .replace(/```([\s\S]+?)```/g, '<pre><code>$1</code></pre>')
            .replace(/\n/g, '<br>');
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

module.exports = { HelpPanel };
