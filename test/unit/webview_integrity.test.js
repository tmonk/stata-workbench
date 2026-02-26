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
    itWithContext('should produce syntactically valid JavaScript in the webview script tags', () => {
        const vscode = require('vscode');
        const vm = require('vm');
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

        // Extract all script contents from <script> tags that aren't sourcing a file
        const scriptRegex = /<script\b[^>]*>([\s\S]*?)<\/script>/gm;
        let match;
        let scriptsFound = 0;

        while ((match = scriptRegex.exec(htmlContent)) !== null) {
            const scriptContent = match[1].trim();
            if (scriptContent) {
                scriptsFound++;
                try {
                    // Try to compile the script. This will throw if there's a SyntaxError (like duplicate const).
                    new vm.Script(scriptContent);
                } catch (err) {
                    throw new Error(`Syntax error in webview script: ${err.message}\n\nScript content:\n${scriptContent}`);
                }
            }
        }

        expect(scriptsFound).toBeGreaterThan(0);
        mock.restore();
    });
});
