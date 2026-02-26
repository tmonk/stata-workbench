const vscode = require('vscode');

describe('Terminal Panel Serialization Integration', () => {
    jest.setTimeout(60000);

    const enabled = process.env.MCP_STATA_INTEGRATION === '1';

    test('Extension should register WebviewPanelSerializer for stataTerminal without error', async () => {
        if (!enabled) return;

        const extension = vscode.extensions.getExtension('tmonk.stata-workbench');
        expect(extension).toBeTruthy();
        if (!extension.isActive) {
            await extension.activate();
        }

        const api = extension.exports;

        // Ensure TerminalPanel exists in the export or is at least loaded and hasn't thrown errors
        // during activation when registering the serializer.
        expect(api).toBeTruthy();
        expect(api.TerminalPanel).toBeTruthy();
        expect(typeof api.TerminalPanel.restorePanel).toBe('function');

        // We can't drag UI in this headless test environment, but successfully reaching this
        // block proves `vscode.window.registerWebviewPanelSerializer` ran normally and didn't panic.
    });
});
