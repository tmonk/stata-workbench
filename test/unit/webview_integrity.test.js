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
    itWithContext('should not have duplicate const observer or saveTimer in the webview script', () => {
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

        // Check for duplicate const observer or saveTimer
        const observerMatches = htmlContent.match(/const observer =/g);
        const saveTimerMatches = htmlContent.match(/const saveTimer =/g);

        expect(observerMatches ? observerMatches.length : 0).toBeLessThan(2);
        expect(saveTimerMatches ? saveTimerMatches.length : 0).toBeLessThan(2);

        mock.restore();
    });
});
