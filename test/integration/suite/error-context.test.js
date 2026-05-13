const vscode = require('vscode');

describe('Error Context E2E', () => {
    jest.setTimeout(60000);

    const enabled = process.env.STATA_AGENT_INTEGRATION === '1';

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

        const isMock = process.env.STATA_AGENT_MOCK === '1';
        // Use a command that fails: mock treats 'error 111' as error,
        // real Stata treats unknown commands as errors.
        const code = isMock ? 'error 111' : 'cljn';

        const doc = await vscode.workspace.openTextDocument({
            language: 'stata',
            content: code
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
        // In mock mode, stderr contains the mock error message
        // In live mode, stderr contains the real Stata error
        expect(stderr.length).toBeGreaterThan(0);
    });
});
