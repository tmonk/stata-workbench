const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');

describe('Run Dirty File Integration', () => {
    jest.setTimeout(60000);

    const enabled = process.env.STATA_AGENT_INTEGRATION === '1';

    let testDir;
    let diskFile;
    let sideFile;
    let proofFile;
    let sideProofFile;

    beforeAll(() => {
        // Create a temporary directory for this test
        testDir = path.join(os.tmpdir(), `stata_test_${Date.now()}`);
        fs.mkdirSync(testDir, { recursive: true });

        // Proof file written by Stata to verify the right content was executed
        proofFile = path.join(testDir, 'executed_content.txt');
        sideProofFile = path.join(testDir, 'side_executed.txt');

        // The main .do file on disk
        diskFile = path.join(testDir, 'main.do');

        // A side file to test CWD preservation
        sideFile = path.join(testDir, 'side.do');
        fs.writeFileSync(sideFile, [
            `file open spf using "${sideProofFile}", write replace`,
            'file write spf "SIDE-FILE-RUNS"',
            'file close spf',
        ].join('\n'));
    });

    afterAll(() => {
        if (fs.existsSync(testDir)) {
            try {
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
            // Write the disk version of main.do — content that should NOT be run
            fs.writeFileSync(diskFile, [
                `file open pf using "${proofFile}", write replace`,
                'file write pf "DISK-VERSION"',
                'file close pf',
            ].join('\n'));

            // 1. Open the file
            const doc = await vscode.workspace.openTextDocument(diskFile);
            const editor = await vscode.window.showTextDocument(doc);

            // 2. Modify the file (making it dirty) — content that SHOULD be run
            const unsavedContent = [
                `file open pf using "${proofFile}", write replace`,
                'file write pf "UNSAVED-VERSION"',
                'file close pf',
                `do "${sideFile}"`,
            ].join('\n');
            await editor.edit(editBuilder => {
                editBuilder.replace(new vscode.Range(0, 0, doc.lineCount, 0), unsavedContent);
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

            // 5. Verify the UNSAVED content was run by checking the proof file
            expect(fs.existsSync(proofFile)).toBe(true);
            const proofContent = fs.readFileSync(proofFile, 'utf8').trim();
            expect(proofContent).toBe('UNSAVED-VERSION');

            // 6. Verify CWD was preserved — side.do was found and executed
            expect(fs.existsSync(sideProofFile)).toBe(true);
            const sideContent = fs.readFileSync(sideProofFile, 'utf8').trim();
            expect(sideContent).toBe('SIDE-FILE-RUNS');

        } finally {
            // Cleanup proof files
            try { if (fs.existsSync(proofFile)) fs.unlinkSync(proofFile); } catch {}
            try { if (fs.existsSync(sideProofFile)) fs.unlinkSync(sideProofFile); } catch {}
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
        await vscode.workspace.getConfiguration('stata').update('runFileBehavior', 'runDiskFile', vscode.ConfigurationTarget.Global);

        try {
            // Write the disk version — this is what SHOULD be run
            fs.writeFileSync(diskFile, [
                `file open pf using "${proofFile}", write replace`,
                'file write pf "DISK-VERSION"',
                'file close pf',
            ].join('\n'));

            const doc = await vscode.workspace.openTextDocument(diskFile);
            const editor = await vscode.window.showTextDocument(doc);

            // Make the file dirty with content that should NOT be run
            await editor.edit(editBuilder => {
                editBuilder.replace(new vscode.Range(0, 0, doc.lineCount, 0), [
                    `file open pf using "${proofFile}", write replace`,
                    'file write pf "SHOULD-NOT-RUN"',
                    'file close pf',
                ].join('\n'));
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

            // Verify the DISK version was run, NOT the unsaved content
            expect(fs.existsSync(proofFile)).toBe(true);
            const proofContent = fs.readFileSync(proofFile, 'utf8').trim();
            expect(proofContent).toBe('DISK-VERSION');
            expect(proofContent).not.toBe('SHOULD-NOT-RUN');

        } finally {
            // Restore default setting
            await vscode.workspace.getConfiguration('stata').update('runFileBehavior', 'runDirtyFile', vscode.ConfigurationTarget.Global);
            // Cleanup proof file
            try { if (fs.existsSync(proofFile)) fs.unlinkSync(proofFile); } catch {}
            api.TerminalPanel._testOutgoingCapture = null;
            await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        }
    });
});
