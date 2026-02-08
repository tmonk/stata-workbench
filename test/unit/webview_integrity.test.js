const { describe, it, expect, mock, jest } = require('bun:test');
const proxyquire = require('proxyquire').noCallThru().noPreserveCache();
const { withTestContext } = require('../helpers/test-context');

const loadTerminalPanel = () => proxyquire('../../src/terminal-panel', {
    './artifact-utils': {
        openArtifact: () => { },
        revealArtifact: () => { },
        copyToClipboard: () => { },
        resolveArtifactUri: () => { }
    }
});

const itWithContext = (name, fn) => it(name, () => withTestContext({}, fn));

describe('Webview Script Integrity', () => {
    itWithContext('should produce valid script content without literal newlines in strings', () => {
        const vscode = require('vscode');
        let htmlContent = '';

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

        const terminalPanelModule = loadTerminalPanel();
        const TerminalPanel = terminalPanelModule.TerminalPanel;

        TerminalPanel.currentPanel = null;

        TerminalPanel.setExtensionUri(vscode.Uri.file('/extension'));

        TerminalPanel.show({
            filePath: '/test.dta',
            runCommand: async () => ({})
        });

        expect(htmlContent).toBeTruthy();

        const strictPattern = /\.indexOf\('[\r\n]+', start\)/;
        expect(htmlContent).not.toMatch(strictPattern);

        expect(htmlContent).toContain('String.fromCharCode(10)');

        mock.restore();
    });
});
