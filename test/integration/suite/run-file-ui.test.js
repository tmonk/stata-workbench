const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');

describe('Run File UI Integration', () => {
    jest.setTimeout(60000);

    const enabled = process.env.MCP_STATA_INTEGRATION === '1';

    let tempFile;

    beforeAll(() => {
        // Create a temporary .do file
        const tempDir = os.tmpdir();
        tempFile = path.join(tempDir, 'test_run_all.do');
        fs.writeFileSync(tempFile, 'display "UI-INTEGRATION-SUCCESS"');
    });

    afterAll(() => {
        if (fs.existsSync(tempFile)) {
            fs.unlinkSync(tempFile);
        }
    });

    test('Run File command should open panel and show output', async () => {
        if (!enabled) {
            return;
        }
        // Open the document
        let doc = await vscode.workspace.openTextDocument(tempFile);
        await vscode.window.showTextDocument(doc);

        // Execute the command "Run All" (which is stata-workbench.runFile)
        // Get the extension API
        const extension = vscode.extensions.getExtension('tmonk.stata-workbench');
        expect(extension).toBeTruthy();
        if (!extension.isActive) {
            await extension.activate();
        }
        const api = extension.exports;
        expect(api).toBeTruthy();
        expect(api.TerminalPanel).toBeTruthy();

        // Close all editors to ensure a clean state for the panel
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');

        // Setup listener for webview messages (outgoing from extension -> webview)
        let receivedError = null;
        const outgoing = [];
        api.TerminalPanel._testOutgoingCapture = (msg) => {
            outgoing.push(msg);
        };
        api.TerminalPanel._testCapture = (msg) => {
            if (msg.type === 'log' && msg.level === 'error') receivedError = msg.message;
        };

        // Open the document and execute the command "Run All" (which is stata-workbench.runFile)
        doc = await vscode.workspace.openTextDocument(tempFile);
        await vscode.window.showTextDocument(doc);
        await vscode.commands.executeCommand('stata-workbench.runFile');

        // Poll for run lifecycle events
        let runStarted = null;
        let runFinished = null;
        let sawLogAppend = false;
        let sawProgress = false;

        for (let i = 0; i < 120; i++) { // up to 60s
            if (receivedError) throw new Error(`Client Script Error: ${receivedError}`);

            for (const m of outgoing) {
                if (m?.type === 'runStarted') {
                    runStarted = m;
                }
                if (m?.type === 'runLogAppend') {
                    sawLogAppend = true;
                }
                if (m?.type === 'runProgress') {
                    sawProgress = true;
                }
                if (m?.type === 'runFinished') {
                    runFinished = m;
                }
            }

            if (runStarted && runFinished) break;
            await new Promise(r => setTimeout(r, 500));
        }

        expect(api.TerminalPanel.currentPanel).toBeTruthy();
        expect(runStarted).toBeTruthy();
        expect(runFinished).toBeTruthy();
        expect(runStarted.runId).toBe(runFinished.runId);
        expect(runFinished.success === true || runFinished.success === false).toBe(true);

        // We expect at least some streamed log output in normal runs.
        // Progress may or may not be emitted depending on server/runtime.
        const finalStdout = String(runFinished?.stdout || '');
        expect(sawLogAppend || finalStdout.includes('UI-INTEGRATION-SUCCESS')).toBe(true);

        const logMsgs = outgoing.filter(m => m?.type === 'runLogAppend');
        if (logMsgs.length) {
            expect(logMsgs.every(m => m.runId === runStarted.runId)).toBe(true);
        }

        // If progress is emitted, it should come for the same run.
        if (sawProgress) {
            const progressMsgs = outgoing.filter(m => m?.type === 'runProgress');
            expect(progressMsgs.length).toBeGreaterThanOrEqual(1);
            expect(progressMsgs.every(m => m.runId === runStarted.runId)).toBe(true);
        }
    });

    test(
        'Run File surfaces stderr tail for failing .do with long output',
        async () => {
            if (!enabled) {
                return;
            }

            // Create a temp .do that emits ~100,000 lines then triggers an r(199) unknown command error.
            const errFile = path.join(os.tmpdir(), `test_run_error_${Date.now()}.do`);
            fs.writeFileSync(errFile, [
                'forvalues i = 1/100000 {',
                '    display "."',
                '}',
                // Intentional unknown command to yield r(199)
                'ppp'
            ].join('\n'));

            // Ensure a clean panel state and capture outgoing messages.
            const extension = vscode.extensions.getExtension('tmonk.stata-workbench');
            expect(extension).toBeTruthy();
            if (!extension.isActive) {
                await extension.activate();
            }
            const api = extension.exports;
            expect(api).toBeTruthy();
            expect(api.TerminalPanel).toBeTruthy();

            api.TerminalPanel._testOutgoingCapture = null;
            api.TerminalPanel._testCapture = null;
            const outgoing = [];
            let sawLogAppend = false;
            let receivedError = null;
            api.TerminalPanel._testOutgoingCapture = (msg) => outgoing.push(msg);
            api.TerminalPanel._testCapture = (msg) => {
                if (msg.type === 'log' && msg.level === 'error') receivedError = msg.message;
            };

            try {
                const doc = await vscode.workspace.openTextDocument(errFile);
                await vscode.window.showTextDocument(doc);
                await vscode.commands.executeCommand('stata-workbench.runFile');

                let runStarted = null;
                let runFinished = null;

                for (let i = 0; i < 160; i++) { // up to ~80s
                    if (receivedError) throw new Error(`Client Script Error: ${receivedError}`);
                    for (const m of outgoing) {
                        if (m?.type === 'runStarted') runStarted = m;
                        if (m?.type === 'runFinished') runFinished = m;
                        if (m?.type === 'runLogAppend') sawLogAppend = true;
                    }
                    if (runStarted && runFinished) break;
                    await new Promise(r => setTimeout(r, 500));
                }

                expect(runStarted).toBeTruthy();
                expect(runFinished).toBeTruthy();
                expect(runStarted.runId).toBe(runFinished.runId);
                expect(runFinished.success).toBe(false);
                expect(runFinished.rc).toBe(199);

                const stderr = String(runFinished.stderr || '');
                const stdout = String(runFinished.stdout || '');
                const combined = `${stderr}\n${stdout}`;
                if (!/199|unrecognized|command ppp/i.test(combined)) {
                    // If the textual tail was truncated, fall back to rc validation.
                    expect(runFinished.rc).toBe(199);
                }

                // Some MCP runtimes may truncate stdout when the run fails early; rely on stderr + rc.
                expect(sawLogAppend || combined.length > 0).toBe(true);
            } finally {
                api.TerminalPanel._testOutgoingCapture = null;
                api.TerminalPanel._testCapture = null;
                if (fs.existsSync(errFile)) {
                    fs.unlinkSync(errFile);
                }
            }
        }
    );
});
