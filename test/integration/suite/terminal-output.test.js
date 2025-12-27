const vscode = require('vscode');

describe('Terminal Output E2E', () => {
    jest.setTimeout(90000);

    const enabled = process.env.MCP_STATA_INTEGRATION === '1';

    test('Should hide internal commands and highlight output', async () => {
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

        // Run a sequence that involves internal log closing
        // We simulate what the MCP does by running it
        const doc = await vscode.workspace.openTextDocument({
            language: 'stata',
            content: 'sysuse auto, clear\nsum price'
        });
        const editor = await vscode.window.showTextDocument(doc);
        editor.selection = new vscode.Selection(0, 0, doc.lineCount - 1, doc.lineAt(doc.lineCount - 1).text.length);

        const outgoing = [];
        api.TerminalPanel._testOutgoingCapture = (msg) => {
            outgoing.push(msg);
        };

        await vscode.commands.executeCommand('stata-workbench.runSelection');

        let runFinished = null;
        for (let i = 0; i < 120; i++) {
            for (const m of outgoing) {
                if (m?.type === 'runFinished') runFinished = m;
            }
            if (runFinished) break;
            await new Promise(r => setTimeout(r, 500));
        }

        expect(runFinished).toBeTruthy();
        expect(runFinished.success).toBe(true);

        const combined = outgoing
            .filter(m => m.type === 'runLogAppend' || (m.type === 'runFinished' && m.runId === runFinished.runId))
            .map(m => String(m.text || m.stdout || ''))
            .join('');

        // 1. Verify internal command stripping
        // The mcp-stata server sends 'capture log close _mcp_smcl_...' at the end of runs if it uses log streaming
        expect(combined).not.toContain('capture log close _mcp_smcl_');

        // 2. Verify syntax highlighting markers
        // smclToHtml should have added syntax-highlight class to command blocks
        expect(combined).toContain('syntax-highlight');
        expect(combined).toContain('smcl-com');

        // 3. Verify specific Stata metadata stripping
        expect(combined).not.toContain('log type:');
        expect(combined).not.toContain('opened on:');
    });
});
