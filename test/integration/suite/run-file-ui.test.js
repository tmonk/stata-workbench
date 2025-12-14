const assert = require('chai').assert;
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');

suite('Run File UI Integration', function () {
    this.timeout(60000);

    let tempFile;

    suiteSetup(() => {
        // Create a temporary .do file
        const tempDir = os.tmpdir();
        tempFile = path.join(tempDir, 'test_run_all.do');
        fs.writeFileSync(tempFile, 'display "UI-INTEGRATION-SUCCESS"');
    });

    suiteTeardown(() => {
        if (fs.existsSync(tempFile)) {
            fs.unlinkSync(tempFile);
        }
    });

    test('Run File command should open panel and show output', async () => {
        // Open the document
        let doc = await vscode.workspace.openTextDocument(tempFile);
        await vscode.window.showTextDocument(doc);

        // Execute the command "Run All" (which is stata-workbench.runFile)
        // Get the extension API
        const extension = vscode.extensions.getExtension('tmonk.stata-workbench');
        assert.ok(extension, 'Extension should be available');
        if (!extension.isActive) {
            await extension.activate();
        }
        const api = extension.exports;
        assert.ok(api, 'Extension exports should be available in test mode');
        assert.ok(api.InteractivePanel, 'InteractivePanel should be exported');

        // Close all editors to ensure a clean state for the panel
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');

        // Setup listener for client messages
        let receivedReady = false;
        let receivedError = null;
        api.InteractivePanel._testCapture = (msg) => {
            if (msg.type === 'ready') receivedReady = true;
            if (msg.type === 'log' && msg.level === 'error') receivedError = msg.message;
        };

        // Open the document and execute the command "Run All" (which is stata-workbench.runFile)
        doc = await vscode.workspace.openTextDocument(tempFile);
        await vscode.window.showTextDocument(doc);
        await vscode.commands.executeCommand('stata-workbench.runFile');

        // Poll for 'ready' message or client error
        for (let i = 0; i < 20; i++) { // Poll for up to 10 seconds
            if (receivedError) throw new Error(`Client Script Error: ${receivedError}`);
            if (receivedReady) break;
            await new Promise(r => setTimeout(r, 500));
        }

        assert.isTrue(receivedReady, 'Client script should send "ready" signal');

        // Additional check: HTML content
        const panel = api.InteractivePanel.currentPanel;
        assert.ok(panel, 'Interactive Panel should be open');
        assert.include(panel.webview.html, 'UI-INTEGRATION-SUCCESS', 'Interactive Panel HTML should contain "UI-INTEGRATION-SUCCESS"');
    });
});
