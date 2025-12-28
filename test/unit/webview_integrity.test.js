
const { describe, it, beforeEach, expect } = require('@jest/globals');

describe('Webview Script Integrity', () => {
    let TerminalPanel;
    let htmlContent = '';
    let mockWebview;

    beforeEach(() => {
        jest.resetModules();

        const mockWebview = {
            asWebviewUri: (u) => 'uri:' + (u?.fsPath || u),
            cspSource: 'csp',
            onDidReceiveMessage: jest.fn(),
            html: ''
        };

        const vscodeMock = {
            Uri: {
                joinPath: (u, ...f) => ({ fsPath: (u?.fsPath || u) + '/' + f.join('/') }),
                file: (f) => ({ fsPath: f })
            },
            ViewColumn: { Beside: 1 },
            window: {
                createWebviewPanel: jest.fn(() => ({
                    webview: new Proxy(mockWebview, {
                        set: (target, prop, value) => {
                            if (prop === 'html') {
                                htmlContent = value;
                            }
                            target[prop] = value;
                            return true;
                        },
                        get: (target, prop) => target[prop]
                    }),
                    onDidDispose: jest.fn(),
                    reveal: jest.fn()
                }))
            },
            workspace: {
                getConfiguration: () => ({
                    get: (key, def) => def
                })
            }
        };

        jest.doMock('vscode', () => vscodeMock, { virtual: true });

        // Re-require TerminalPanel to pick up the mock
        const terminalPanelModule = require('../../src/terminal-panel');
        TerminalPanel = terminalPanelModule.TerminalPanel;

        htmlContent = '';
    });

    it('should produce valid script content without literal newlines in strings', () => {
        const vscode = require('vscode');
        TerminalPanel.setExtensionUri(vscode.Uri.file('/extension'));

        TerminalPanel.show({
            filePath: '/test.dta',
            runCommand: async () => ({})
        });

        expect(htmlContent).toBeTruthy();

        const strictPattern = /\.indexOf\('[\r\n]+', start\)/;
        expect(htmlContent).not.toMatch(strictPattern);

        // Ensure our fix is present
        expect(htmlContent).toContain('String.fromCharCode(10)');
    });
});
