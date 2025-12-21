const assert = require('chai').assert;
const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');
const { spawnSync } = require('child_process');

suite('McpClient integration (VS Code host)', function () {
    this.timeout(120000);

    const enabled = process.env.MCP_STATA_INTEGRATION === '1';
    let tempRoot;
    let workDir;
    let doDir;
    let doFile;
    let client;

    suiteSetup(async function () {
        if (!enabled) {
            this.skip();
            return;
        }

        const uvxCmd = process.env.MCP_STATA_UVX_CMD || process.env.MCP_STATA_UVX_CMD || 'uvx';
        const uvxProbe = spawnSync(uvxCmd, ['--version'], { encoding: 'utf8' });
        if (uvxProbe.status !== 0) {
            this.skip();
            return;
        }
        process.env.MCP_STATA_UVX_CMD = uvxCmd;

        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stata-wb-int-'));
        workDir = path.join(tempRoot, 'workdir');
        doDir = path.join(tempRoot, 'scripts');
        fs.mkdirSync(workDir, { recursive: true });
        fs.mkdirSync(doDir, { recursive: true });
        doFile = path.join(doDir, 'integration.do');
        fs.writeFileSync(doFile, [
            'capture log close _all',
            'log using "integration.log", replace text',
            'display "integration-ok"',
            'log close'
        ].join('\n'));

        const config = vscode.workspace.getConfiguration('stataMcp');
        await config.update('runFileWorkingDirectory', workDir, vscode.ConfigurationTarget.Workspace);
        await config.update('requestTimeoutMs', 60000, vscode.ConfigurationTarget.Workspace);

        // Ensure the extension under test can resolve uvx
        const { StataMcpClient } = require('../../../src/mcp-client');
        client = new StataMcpClient();
    });

    suiteTeardown(async function () {
        if (client?.dispose) {
            await client.dispose();
        }
        // Reset workspace configuration to avoid pointing at deleted temp dirs for later suites.
        if (enabled) {
            const config = vscode.workspace.getConfiguration('stataMcp');
            await config.update('runFileWorkingDirectory', '', vscode.ConfigurationTarget.Workspace);
        }
        if (tempRoot && fs.existsSync(tempRoot)) {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    test('runs .do file with configured working directory', async function () {
        if (!enabled) {
            this.skip();
            return;
        }

        const result = await client.runFile(doFile, { normalizeResult: true, includeGraphs: false });
        assert.isTrue(result.success, 'runFile success flag');
        assert.strictEqual(result.rc, 0);
        const stdout = result.stdout || result.contentText || '';
        assert.include(stdout, 'integration-ok');
        assert.strictEqual(result.cwd, workDir, 'cwd metadata should reflect configured working directory');
    });
});
