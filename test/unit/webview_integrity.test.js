const { describe, it, beforeEach, afterEach, expect, mock, jest } = require('bun:test');

const resetModules = () => {
    for (const key of Object.keys(require.cache)) {
        delete require.cache[key];
    }
};

describe('Webview Script Integrity', () => {
    let TerminalPanel;
    let htmlContent = '';

    beforeEach(() => {
        resetModules();
        const vscode = require('vscode');

        htmlContent = '';

        // Override the mock implementation to capture HTML content
        vscode.window.createWebviewPanel.mockImplementation(() => {
            const webviewBase = {
                onDidReceiveMessage: jest.fn(),
                html: '',
                cspSource: 'mock-csp-source',
                postMessage: jest.fn().mockResolvedValue(),
                asWebviewUri: jest.fn().mockImplementation((uri) => uri?.fsPath || uri)
            };

            const webviewProxy = new Proxy(webviewBase, {
                set: (target, prop, value) => {
                    if (prop === 'html') {
                        htmlContent = value;
                    }
                    target[prop] = value;
                    return true;
                },
                get: (target, prop) => target[prop]
            });

            return {
                webview: webviewProxy,
                onDidDispose: jest.fn(),
                reveal: jest.fn()
            };
        });

        // Re-require TerminalPanel so it uses the fresh mock state
        const terminalPanelModule = require('../../src/terminal-panel');
        TerminalPanel = terminalPanelModule.TerminalPanel;

        // CRITICAL: Ensure static state is cleared
        TerminalPanel.currentPanel = null;
    });

    afterEach(() => {
        mock.restore();
        jest.clearAllMocks();
        resetModules();
    });

    it('should produce valid script content without literal newlines in strings', () => {
        const vscode = require('vscode');
        TerminalPanel.setExtensionUri(vscode.Uri.file('/extension'));

        TerminalPanel.show({
            filePath: '/test.dta',
            runCommand: async () => ({})
        });

        // If this is failing with "", verify TerminalPanel.show() was actually called 
        // and didn't return early due to currentPanel.
        expect(htmlContent).toBeTruthy();

        const strictPattern = /\.indexOf\('[\r\n]+', start\)/;
        expect(htmlContent).not.toMatch(strictPattern);

        // Ensure our fix is present
        expect(htmlContent).toContain('String.fromCharCode(10)');
    });
});
