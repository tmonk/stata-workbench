
const assert = require('assert');
const { TerminalPanel } = require('../../src/terminal-panel');
const vscode = require('vscode');

// Mock vscode
jest.mock('vscode', () => ({
    Uri: {
        joinPath: () => ({ fsPath: '/path/to/resource' }),
        file: (f) => ({ fsPath: f })
    },
    ViewColumn: { Beside: 1 },
    window: {
        createWebviewPanel: jest.fn()
    }
}), { virtual: true });

describe('Webview Script Integrity', () => {
    let mockWebview;
    let htmlContent = '';

    beforeAll(() => {
        mockWebview = {
            asWebviewUri: (u) => 'uri:' + u,
            cspSource: 'csp',
            onDidReceiveMessage: jest.fn(),
            html: ''
        };

        // Mock createWebviewPanel to capture the webview object
        vscode.window.createWebviewPanel = jest.fn(() => ({
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
        }));
    });

    it('should produce valid script content without literal newlines in strings', () => {
        // Important: Set extension URI first to avoid crash
        TerminalPanel.setExtensionUri(vscode.Uri.file('/extension'));

        TerminalPanel.show({
            filePath: '/test.dta',
            runCommand: async () => ({})
        });

        expect(htmlContent).toBeTruthy();

        const strictPattern = /\.indexOf\('[\r\n]+', start\)/;
        expect(htmlContent).not.toMatch(strictPattern);

        // Ensure our fix is present (checking against both possible valid JS implementations if needed, but we look for charCode)
        expect(htmlContent).toContain('String.fromCharCode(10)');
    });
});
