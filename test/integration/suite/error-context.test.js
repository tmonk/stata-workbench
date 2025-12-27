const vscode = require('vscode');

describe('Error Context E2E', () => {
    jest.setTimeout(60000);

    const enabled = process.env.MCP_STATA_INTEGRATION === '1';

    test('Error context should be displayed in Terminal Panel on failure', async () => {
        if (!enabled) {
            return;
        }

        const extension = vscode.extensions.getExtension('tmonk.stata-workbench');
        expect(extension).toBeTruthy();
        if (!extension.isActive) {
            await extension.activate();
        }
        const api = extension.exports;
        expect(api?.TerminalPanel).toBeTruthy();

        // Use a command that will definitely fail and provide some SMCL context
        const doc = await vscode.workspace.openTextDocument({
            language: 'stata',
            content: 'cljn'
        });
        const editor = await vscode.window.showTextDocument(doc);
        editor.selection = new vscode.Selection(0, 0, 0, doc.lineAt(0).text.length);

        const outgoing = [];
        api.TerminalPanel._testOutgoingCapture = (msg) => {
            outgoing.push(msg);
        };

        await vscode.commands.executeCommand('stata-workbench.runSelection');

        let runFinished = null;
        for (let i = 0; i < 60; i++) {
            for (const m of outgoing) {
                if (m?.type === 'runFinished') runFinished = m;
            }
            if (runFinished) break;
            await new Promise(r => setTimeout(r, 500));
        }

        expect(runFinished).toBeTruthy();
        expect(runFinished.success).toBe(false);

        const stderr = String(runFinished.stderr || '');
        // Check for the "Error:" context we prepend
        expect(stderr).toContain('Error: command cljn is unrecognized');
        // Check for the "Command:" context (if Stata echoes it in the error block)
        // Note: runSelection might not always have the command in the error block from Stata's side,
        // but our toEntry/parseSMCL logic should try to find it if it's there.
        // If cljn is the only thing, it might just be Error: cljn ...
    });
});
