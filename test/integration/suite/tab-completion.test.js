const assert = require('chai').assert;
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');

suite('Tab Completion Integration', function () {
    this.timeout(60000);

    let tempFile;

    suiteSetup(() => {
        // Create a temporary .do file
        const tempDir = os.tmpdir();
        tempFile = path.join(tempDir, 'tab_completion.do');
        fs.writeFileSync(tempFile, 'display "TAB-COMPLETION"');
    });

    suiteTeardown(() => {
        if (fs.existsSync(tempFile)) {
            fs.unlinkSync(tempFile);
        }
    });

    test('webview requests variables for tab completion', async () => {
        const extension = vscode.extensions.getExtension('tmonk.stata-workbench');
        assert.ok(extension, 'Extension should be available');

        if (!extension.isActive) {
            await extension.activate();
        }

        const api = extension.exports;
        assert.ok(api && api.InteractivePanel, 'InteractivePanel API should be exposed');

        let requestSeen = false;
        let variablesSent = false;

        api.InteractivePanel._testCapture = (msg) => {
            if (msg.type === 'requestVariables') {
                requestSeen = true;
                const panel = api.InteractivePanel.currentPanel;
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

        assert.isTrue(requestSeen, 'webview should request variables');
        assert.isTrue(variablesSent, 'variables response should be sent to webview');
    });
});

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}