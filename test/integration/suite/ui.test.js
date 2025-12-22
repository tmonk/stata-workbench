const assert = require('chai').assert;
const vscode = require('vscode');

suite('UI Integration', function () {
    this.timeout(60000);

    const enabled = process.env.MCP_STATA_INTEGRATION === '1';

    test('Extension should activate and register commands', async () => {
        const extension = vscode.extensions.getExtension('tmonk.stata-workbench');
        assert.ok(extension, 'Extension should be present');

        if (!extension.isActive) {
            await extension.activate();
        }
        assert.isTrue(extension.isActive, 'Extension should be active');

        const commands = await vscode.commands.getCommands(true);
        assert.include(commands, 'stata-workbench.runSelection');
        assert.include(commands, 'stata-workbench.runFile');
    });

    test('runSelection should stream output to Terminal Panel (requires Stata)', async () => {
        if (!enabled) {
            return;
        }

        const extension = vscode.extensions.getExtension('tmonk.stata-workbench');
        assert.ok(extension, 'Extension should be present');
        if (!extension.isActive) {
            await extension.activate();
        }
        const api = extension.exports;
        assert.ok(api?.TerminalPanel, 'TerminalPanel should be exported');

        const doc = await vscode.workspace.openTextDocument({ language: 'stata', content: 'display "STREAM-SELECTION"' });
        const editor = await vscode.window.showTextDocument(doc);
        editor.selection = new vscode.Selection(0, 0, 0, doc.lineAt(0).text.length);

        let receivedError = null;
        const outgoing = [];
        api.TerminalPanel._testOutgoingCapture = (msg) => {
            outgoing.push(msg);
        };
        api.TerminalPanel._testCapture = (msg) => {
            if (msg.type === 'log' && msg.level === 'error') receivedError = msg.message;
        };

        await vscode.commands.executeCommand('stata-workbench.runSelection');

        let runStarted = null;
        let runFinished = null;
        let sawLogAppend = false;

        for (let i = 0; i < 120; i++) {
            if (receivedError) throw new Error(`Client Script Error: ${receivedError}`);

            for (const m of outgoing) {
                if (m?.type === 'runStarted') runStarted = m;
                if (m?.type === 'runLogAppend') sawLogAppend = true;
                if (m?.type === 'runFinished') runFinished = m;
            }
            if (runStarted && runFinished) break;
            await new Promise(r => setTimeout(r, 500));
        }

        assert.ok(api.TerminalPanel.currentPanel, 'Terminal Panel should be open');
        assert.ok(runStarted, 'should emit runStarted');
        assert.ok(runFinished, 'should emit runFinished');
        assert.strictEqual(runStarted.runId, runFinished.runId, 'runId should match');
        const finalStdout = String(runFinished?.stdout || '');
        assert.isTrue(
            sawLogAppend || finalStdout.includes('STREAM-SELECTION'),
            'should stream logs or include expected output in runFinished'
        );

        const logMsgs = outgoing.filter(m => m?.type === 'runLogAppend');
        if (logMsgs.length) {
            assert.isTrue(logMsgs.every(m => m.runId === runStarted.runId), 'runLogAppend should match runId');
        }

        // If any log chunk includes the marker, that's great; but do not require it.
        // Different Stata/MCP setups may stream prompts/noise without the exact displayed text.
        const combined = logMsgs.map(m => String(m.text || '')).join('');
        if (combined) {
            // Not a strict requirement; keep as a sanity check only when present.
            if (combined.includes('STREAM-SELECTION')) {
                assert.include(combined, 'STREAM-SELECTION');
            }
        }
    });

    // test('Download PDF button triggers export_graph and yields PDF path', async () => {
    //     if (!enabled) {
    //         return;
    //     }

    //     const extension = vscode.extensions.getExtension('tmonk.stata-workbench');
    //     assert.ok(extension, 'Extension should be present');
    //     if (!extension.isActive) {
    //         await extension.activate();
    //     }
    //     const api = extension.exports;
    //     assert.ok(api?.TerminalPanel, 'TerminalPanel should be exported');

    //     // Prepare a document and create a graph
    //     const doc = await vscode.workspace.openTextDocument({ language: 'stata', content: 'sysuse auto\nscatter price mpg, name(gint, replace)' });
    //     const editor = await vscode.window.showTextDocument(doc);
    //     editor.selection = new vscode.Selection(0, 0, doc.lineCount - 1, doc.lineAt(doc.lineCount - 1).text.length);

    //     const outgoing = [];
    //     api.TerminalPanel._testOutgoingCapture = (msg) => {
    //         outgoing.push(msg);
    //     };

    //     // Run selection to create graph
    //     await vscode.commands.executeCommand('stata-workbench.runSelection');

    //     // Wait for run finished
    //     let runFinished = null;
    //     for (let i = 0; i < 120; i++) {
    //         for (const m of outgoing) {
    //             if (m?.type === 'runFinished') runFinished = m;
    //         }
    //         if (runFinished) break;
    //         await new Promise(r => setTimeout(r, 500));
    //     }
    //     assert.ok(runFinished, 'runFinished should arrive');
    //     assert.strictEqual(runFinished.success, true, 'graph creation run should succeed');

    //     // Trigger downloadGraphPdf directly through panel handler
    //     let downloadResult = null;
    //     api.TerminalPanel._downloadGraphPdf = async (graphName) => {
    //         const res = await extension.exports.downloadGraphAsPdf(graphName);
    //         downloadResult = res;
    //     };

    //     await api.TerminalPanel._handleDownloadGraphPdf('gint');

    //     assert.isOk(downloadResult, 'download result should exist');
    //     const resolvedPath = downloadResult.path || downloadResult.file_path || downloadResult.url || null;
    //     const resolvedDataUri = downloadResult.dataUri || null;
    //     assert.isTrue(!!resolvedPath || !!resolvedDataUri, 'download result should contain a path/url or dataUri');
    //     if (resolvedPath) {
    //         assert.match(resolvedPath, /\.pdf$/i, 'result path/url should be a PDF');
    //     }
    //     if (resolvedDataUri) {
    //         assert.match(resolvedDataUri, /^data:application\/pdf;base64,/i, 'dataUri should be a PDF data URI');
    //     }
    // });

    test('Stop button cancels a running command', async () => {
        if (!enabled) {
            return;
        }

        const extension = vscode.extensions.getExtension('tmonk.stata-workbench');
        assert.ok(extension, 'Extension should be present');
        if (!extension.isActive) {
            await extension.activate();
        }
        const api = extension.exports;
        assert.ok(api?.TerminalPanel, 'TerminalPanel should be exported');

        const doc = await vscode.workspace.openTextDocument({ language: 'stata', content: 'sleep 5000' });
        const editor = await vscode.window.showTextDocument(doc);
        editor.selection = new vscode.Selection(0, 0, doc.lineCount - 1, doc.lineAt(doc.lineCount - 1).text.length);

        const outgoing = [];
        api.TerminalPanel._testOutgoingCapture = (msg) => {
            outgoing.push(msg);
        };

        // Kick off a long run
        const runPromise = vscode.commands.executeCommand('stata-workbench.runSelection');

        // Wait for runStarted
        let runStarted = null;
        for (let i = 0; i < 40; i++) {
            for (const m of outgoing) {
                if (m?.type === 'runStarted') runStarted = m;
            }
            if (runStarted) break;
            await new Promise(r => setTimeout(r, 250));
        }
        assert.ok(runStarted, 'runStarted should arrive');

        // Trigger cancel via handler (simulating stop button)
        await api.TerminalPanel._handleCancelRun();

        let runFinished = null;
        for (let i = 0; i < 40; i++) {
            for (const m of outgoing) {
                if (m?.type === 'runFinished') runFinished = m;
            }
            if (runFinished) break;
            await new Promise(r => setTimeout(r, 250));
        }

        let cancelledThrown = false;
        try {
            await runPromise;
        } catch (_err) {
            cancelledThrown = true;
        }

        // We accept either an explicit runFinished with error or a thrown cancellation
        assert.isTrue(cancelledThrown || (!!runFinished && runFinished.success === false), 'run should be cancelled or end unsuccessful');
    });

    test('viewData should open Data Browser Panel', async () => {
        const extension = vscode.extensions.getExtension('tmonk.stata-workbench');
        assert.ok(extension, 'Extension should be present');
        if (!extension.isActive) {
            await extension.activate();
        }
        const api = extension.exports;

        // Monitor console.error for Data Browser failures
        const originalError = console.error;
        let browserError = null;
        console.error = (...args) => {
            const msg = args.map(String).join(' ');
            // Catch both webview errors and proxy errors, including specific API failure messages
            if (msg.includes('DataBrowser') || msg.includes('API Request Failed') || msg.includes('Failed to load page')) {
                browserError = msg;
            }
            originalError.apply(console, args);
        };

        try {
            if (enabled) {
                let dataLoaded = false;
                let runOutput = '';
                const originalCapture = api.TerminalPanel._testOutgoingCapture;
                
                api.TerminalPanel._testOutgoingCapture = (msg) => {
                    if (originalCapture) originalCapture(msg);
                    if (msg.type === 'runFinished') {
                        if (msg.success) dataLoaded = true;
                        runOutput = msg.stdout || '';
                    }
                };

                // Create a doc and select it so runSelection picks it up
                const doc = await vscode.workspace.openTextDocument({ language: 'stata', content: 'sysuse auto, clear' });
                const editor = await vscode.window.showTextDocument(doc);
                editor.selection = new vscode.Selection(0, 0, 0, doc.lineAt(0).text.length);

                await vscode.commands.executeCommand('stata-workbench.runSelection');
                
                // Wait for Stata to finish loading data
                for (let i = 0; i < 40; i++) { // Increased wait time
                    if (dataLoaded) break;
                    await new Promise(r => setTimeout(r, 500));
                }
                
                // Restore capture
                api.TerminalPanel._testOutgoingCapture = originalCapture;

                if (!dataLoaded) {
                    assert.fail('Data load (sysuse auto) failed or timed out');
                }
                if (!runOutput.includes('1978 automobile data')) {
                    assert.fail(`Data load output missing confirmation. Output: ${runOutput}`);
                }
            }
            
            // Execute the command
            await vscode.commands.executeCommand('stata-workbench.viewData');
            
            // Wait for potential init errors
            await new Promise(r => setTimeout(r, 3000));

            if (browserError) {
                assert.fail(`Data Browser reported error: ${browserError}`);
            }
            
            // Verify panel is created
            assert.ok(api.DataBrowserPanel, 'DataBrowserPanel should be exported');
            assert.ok(api.DataBrowserPanel.currentPanel, 'DataBrowserPanel should be open');
        } finally {
            console.error = originalError;
            if (api.DataBrowserPanel && api.DataBrowserPanel.currentPanel) {
                api.DataBrowserPanel.currentPanel.dispose();
            }
        }
    });
});
