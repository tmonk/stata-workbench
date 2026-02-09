const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

describe('Startup Do File Integration', () => {
    jest.setTimeout(120000); // Stata startup can be slow

    const enabled = process.env.MCP_STATA_INTEGRATION === '1';
    const runIfEnabled = enabled ? test : test.skip;

    runIfEnabled('automatically runs startup do file on session load', async () => {
        const { StataMcpClient } = require('../../../src/mcp-client');
        const client = new StataMcpClient();
        
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            throw new Error('No workspace folder found for integration test');
        }
        const rootPath = workspaceFolders[0].uri.fsPath;
        const doFileContent = 'global STARTUP_INTEGRATION_TEST "OK"\nscalar startup_int = 123';
        const doFilePath = path.join(rootPath, 'integration_startup.do');
        
        fs.writeFileSync(doFilePath, doFileContent);

        // Configure the extension setting
        const config = vscode.workspace.getConfiguration('stataMcp');
        await config.update('startupDoFile', '${workspaceFolder}/integration_startup.do', vscode.ConfigurationTarget.Workspace);

        try {
            // Run a command to trigger initialization
            const result = await client.run('display "$STARTUP_INTEGRATION_TEST"');
            
            // The result should contain the output of the command
            const output = result.smcl_output || result.stdout || '';
            expect(output).toContain('OK');

            // Verify another side effect
            const result2 = await client.run('display startup_int');
            const output2 = result2.smcl_output || result2.stdout || '';
            expect(output2).toContain('123');

        } finally {
            await client.dispose();
            if (fs.existsSync(doFilePath)) {
                fs.unlinkSync(doFilePath);
            }
            // Reset setting
            await config.update('startupDoFile', undefined, vscode.ConfigurationTarget.Workspace);
        }
    });
});
