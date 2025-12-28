const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');

describe('Run Dirty File Integration', () => {
    jest.setTimeout(60000);

    const enabled = process.env.MCP_STATA_INTEGRATION === '1';

    let testDir;
    let diskFile;
    let sideFile;

    beforeAll(() => {
        // Create a temporary directory for this test
        testDir = path.join(os.tmpdir(), `stata_test_${Date.now()}`);
        fs.mkdirSync(testDir, { recursive: true });

        // The main file we will edit
        diskFile = path.join(testDir, 'main.do');
        fs.writeFileSync(diskFile, 'display "DISK-VERSION"');

        // A side file to test CWD preservation
        sideFile = path.join(testDir, 'side.do');
        fs.writeFileSync(sideFile, 'display "SIDE-FILE-RUNS"');
    });

    afterAll(() => {
        if (fs.existsSync(testDir)) {
            try {
                // Simplified recursive delete
                const files = fs.readdirSync(testDir);
                for (const file of files) {
                    fs.unlinkSync(path.join(testDir, file));
                }
                fs.rmdirSync(testDir);
            } catch (e) {
                console.error('Cleanup failed:', e);
            }
        }
    });

    test('Run File should reflect unsaved changes while preserving CWD', async () => {
        if (!enabled) {
            return;
        }

        // Get extension API
        const extension = vscode.extensions.getExtension('tmonk.stata-workbench');
        expect(extension).toBeTruthy();
        if (!extension.isActive) await extension.activate();
        const api = extension.exports;

        // Setup capture
        const outgoing = [];
        api.TerminalPanel._testOutgoingCapture = (msg) => outgoing.push(msg);

        try {
            // 1. Open the file
            const doc = await vscode.workspace.openTextDocument(diskFile);
            const editor = await vscode.window.showTextDocument(doc);

            // 2. Modify the file (making it dirty)
            // We'll add a line that runs the side file to verify CWD
            const newContent = 'display "UNSAVED-VERSION"\ndo "side.do"';
            await editor.edit(editBuilder => {
                editBuilder.replace(new vscode.Range(0, 0, doc.lineCount, 0), newContent);
            });
            expect(doc.isDirty).toBe(true);

            // 3. Run the file
            await vscode.commands.executeCommand('stata-workbench.runFile');

            // 4. Wait for completion
            let runFinished = null;
            for (let i = 0; i < 120; i++) {
                runFinished = outgoing.find(m => m?.type === 'runFinished');
                if (runFinished) break;
                await new Promise(r => setTimeout(r, 500));
            }

            expect(runFinished).toBeTruthy();
            expect(runFinished.success).toBe(true);

            const stdout = String(runFinished.stdout || '');
            // Verify unsaved content was run
            expect(stdout).toContain('UNSAVED-VERSION');
            expect(stdout).not.toContain('DISK-VERSION');

            // Verify CWD was preserved (side.do was found and run)
            expect(stdout).toContain('SIDE-FILE-RUNS');

        } finally {
            api.TerminalPanel._testOutgoingCapture = null;
            // Close editors
            await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        }
    });

    test('Run File should honor runDiskFile behavior', async () => {
        if (!enabled) {
            return;
        }

        const extension = vscode.extensions.getExtension('tmonk.stata-workbench');
        expect(extension).toBeTruthy();
        if (!extension.isActive) await extension.activate();
        const api = extension.exports;

        const outgoing = [];
        api.TerminalPanel._testOutgoingCapture = (msg) => outgoing.push(msg);

        // Configure setting to run disk file
        await vscode.workspace.getConfiguration('stataMcp').update('runFileBehavior', 'runDiskFile', vscode.ConfigurationTarget.Global);

        try {
            const doc = await vscode.workspace.openTextDocument(diskFile);
            const editor = await vscode.window.showTextDocument(doc);

            await editor.edit(editBuilder => {
                editBuilder.replace(new vscode.Range(0, 0, doc.lineCount, 0), 'display "SHOULD-NOT-RUN"');
            });
            expect(doc.isDirty).toBe(true);

            await vscode.commands.executeCommand('stata-workbench.runFile');

            let runFinished = null;
            for (let i = 0; i < 120; i++) {
                runFinished = outgoing.find(m => m?.type === 'runFinished');
                if (runFinished) break;
                await new Promise(r => setTimeout(r, 500));
            }

            expect(runFinished).toBeTruthy();
            expect(runFinished.success).toBe(true);

            const stdout = String(runFinished.stdout || '');
            // Verify disk content was run, NOT unsaved content
            expect(stdout).toContain('DISK-VERSION');
            expect(stdout).not.toContain('SHOULD-NOT-RUN');

        } finally {
            // Restore default setting
            await vscode.workspace.getConfiguration('stataMcp').update('runFileBehavior', 'runDirtyFile', vscode.ConfigurationTarget.Global);
            api.TerminalPanel._testOutgoingCapture = null;
            await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        }
    });
});
