const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');

describe('Tab Completion Integration', () => {
    jest.setTimeout(60000);

    const enabled = process.env.MCP_STATA_INTEGRATION === '1';

    let tempFile;

    beforeAll(() => {
        // Create a temporary .do file
        const tempDir = os.tmpdir();
        tempFile = path.join(tempDir, 'tab_completion.do');
        fs.writeFileSync(tempFile, 'display "TAB-COMPLETION"');
    });

    afterAll(() => {
        if (fs.existsSync(tempFile)) {
            fs.unlinkSync(tempFile);
        }
    });

    test('webview requests variables for tab completion', async () => {
        if (!enabled) {
            return;
        }
        const extension = vscode.extensions.getExtension('tmonk.stata-workbench');
        expect(extension).toBeTruthy();

        if (!extension.isActive) {
            await extension.activate();
        }

        const api = extension.exports;
        expect(api && api.TerminalPanel).toBeTruthy();

        let requestSeen = false;
        let variablesSent = false;

        api.TerminalPanel._testCapture = (msg) => {
            if (msg.type === 'requestVariables') {
                requestSeen = true;
                const panel = api.TerminalPanel.currentPanel;
                if (panel?.webview?.postMessage) {
                    panel.webview.postMessage({
                        type: 'variables',
                        variables: [
                            { name: 'price' },
                            { name: 'mpg' }
                        ]
                    });
                    variablesSent = true;
                }
            }
        };

        // Open the document and execute Run File
        const doc = await vscode.workspace.openTextDocument(tempFile);
        await vscode.window.showTextDocument(doc);
        await vscode.commands.executeCommand('stata-workbench.runFile');

        // Wait for the webview to request variables
        for (let i = 0; i < 20; i++) { // up to ~10s
            if (requestSeen) break;
            await delay(500);
        }

        expect(requestSeen).toBe(true);
        expect(variablesSent).toBe(true);
    });
});

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}